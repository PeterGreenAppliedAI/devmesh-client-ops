/**
 * Unexposed transcript store: imports become committed transcript metadata.
 *
 * One call accepts exactly one raw import (a pasted text or one file) together
 * with either the metadata for a meeting to create or the meeting to attach to.
 * The import is read through the delivered adapters (pasted text, `.txt`/`.md`
 * bytes, DOCX and PDF), and the result is committed to the workspace as a
 * canonical transcript backed by its originals:
 *
 * - The canonical content is the extracted text with whitespace runs collapsed
 *   and the ends trimmed; case and punctuation remain significant, so
 *   equivalence is the engagement plus that case-sensitive canonical text.
 * - A new canonical content creates a meeting (with a supplied title and a
 *   validated date) or attaches once to a supplied notes-only meeting, keeping
 *   that meeting's metadata.
 * - A content the engagement already holds reuses its canonical meeting,
 *   archived matches included, and preserves the stored metadata and project;
 *   the supplied differences (title or notes that differ) are reported as
 *   conflicts and are never written.
 * - A repeat aimed at another meeting leaves that target unchanged and returns
 *   the canonical meeting with an explanation.
 * - Different content cannot replace an attachment: an import that differs
 *   from every stored source of its target is committed as its own transcript,
 *   never as a replacement of an existing one.
 * - Each distinct original (bytes) is retained with its own extracted text and
 *   mappings. An exact repeat of a stored original reuses its stored source id
 *   and first filename, attaches nothing and records no activity.
 *
 * Durability and failure rules:
 *
 * - Original files are published and verified before the JSON that names them
 *   is committed; on a persistence failure no new memory or success result is
 *   published, and the published blobs stay in place (unreferenced originals are
 *   retained, never collected). A retry or a reopen verifies and reuses them.
 * - Validation and parsing failures write nothing at all.
 * - Meeting create (for creation), attachment or a new original (one edit), or
 *   a fresh canonical transcript that attaches once (one edit) are recorded as
 *   one activity event together with the metadata and counters; exact repeats
 *   and reads record none.
 * - Source reads require committed metadata and verified originals, return
 *   detached values and never expose a path into the hash repository.
 *
 * Error classes follow the store's: a missing record is `MissingRecordError`,
 * invalid arguments, parents, lifecycle or content are `ValidationError`, a
 * parser refusal is classified (`parser_refused`), and storage or integrity
 * failures are `PersistenceError`.
 */
import { createHash } from "node:crypto";
import {
  canonicalize,
  importFileBytes,
  importPastedText,
  isWellFormedUnicode,
  MAX_CONTENT_BYTES,
  utf8Length,
  validatePassage,
  type ImportOutcome,
  type ImportResult,
  type Passage,
} from "./transcript.ts";
import { importDocx, type DocxParser } from "./transcript-docx.ts";
import { importPdf, type PdfParser } from "./transcript-pdf.ts";
import {
  clone,
  deepFreeze,
  MissingRecordError,
  parseMeeting,
  PersistenceError,
  ValidationError,
  type Meeting,
} from "./model.ts";
import {
  openStore,
  validateTranscripts,
  type Store,
  type StoreOptions,
  type Transcript,
  type TranscriptSource,
} from "./store.ts";
import type { OriginalStore } from "./transcript-files.ts";

/** The inclusive limit, in bytes, for a supplied original and its extracted text. */
export const MAX_TRANSCRIPT_BYTES = MAX_CONTENT_BYTES;

/** The outcome of a committed import: the ids and the classified outcome. */
export type TranscriptImportOutcome =
  | "created"
  | "attached"
  | "reused"
  | "new_source"
  | "separate_transcript";

/** A difference between the supplied metadata and what is preserved. */
export interface TranscriptConflict {
  /** The field whose supplied value differs from the preserved one. */
  readonly field: "title" | "notes";
  /** The supplied value, reported unchanged. */
  readonly supplied: string;
  /** The preserved value that stays in effect. */
  readonly preserved: string;
}

/** A human-readable explanation of a non-mutating or non-targeted outcome. */
export interface TranscriptExplanation {
  readonly code:
    | "reused_canonical"
    | "archived_canonical"
    | "attached_notes_only"
    | "other_meeting"
    | "new_original"
    | "exact_repeat"
    | "separate_transcript";
  readonly message: string;
}

/** What a committed import resolves with. */
export interface TranscriptImportResult {
  readonly outcome: TranscriptImportOutcome;
  /** The meeting the import was committed to. */
  readonly meeting: Meeting;
  /** The committed canonical transcript. */
  readonly transcript: Transcript;
  /** The canonical meeting's id when it is not the requested target. */
  readonly canonicalMeetingId?: string;
  /** The stored source ids of the canonical transcript, in stored order. */
  readonly sourceIds: readonly string[];
  /** Whether this commit created the meeting. */
  readonly createdMeeting: boolean;
  /** Whether this commit attached a new original. */
  readonly attachedOriginal: boolean;
  /** The supplied metadata differences that were reported, never written. */
  readonly conflicts: readonly TranscriptConflict[];
  readonly explanation?: TranscriptExplanation;
}

/** What a source read resolves with: detached values only. */
export interface TranscriptSourceRead {
  readonly transcriptId: string;
  readonly meetingId: string;
  readonly sourceId: string;
  readonly format: TranscriptSource["format"];
  readonly filename: string;
  /** The exact bytes of the original, verified against its hash. */
  readonly originalBytes: Uint8Array;
  readonly originalSha256: string;
  readonly extractedText: string;
  readonly passages: readonly Passage[];
  /**
   * For a file original, its hash and byte length: a detached reference, never
   * an accessible path into the hash repository. A pasted original is its own
   * exact text, and has no hash reference.
   */
  readonly reference?: { readonly sha256: string; readonly byteLength: number };
}

/** The raw import a call accepts: pasted text or one file, never both. */
export interface TranscriptPasteInput {
  readonly kind: "paste";
  readonly text: unknown;
}

export interface TranscriptFileInput {
  readonly kind: "file";
  readonly bytes: unknown;
  readonly filename: unknown;
}

export type TranscriptInput = TranscriptPasteInput | TranscriptFileInput;

/** Metadata supplied when the import creates a meeting. */
export interface TranscriptMeetingCreate {
  readonly clientId: unknown;
  readonly engagementId: unknown;
  readonly projectId?: unknown;
  readonly title: unknown;
  readonly date: unknown;
  readonly notes?: unknown;
}

/** The target meeting an import attaches to. */
export interface TranscriptMeetingTarget {
  readonly meetingId: unknown;
}

/** Either a meeting create or a target meeting, never both and never neither. */
export type TranscriptTarget =
  | { readonly create: TranscriptMeetingCreate; readonly meetingId?: undefined }
  | { readonly meetingId: unknown; readonly create?: undefined };

/** Options accepted by `openTranscriptStore`; only tests pass them. */
export interface TranscriptStoreOptions extends StoreOptions {
  /** Overrides the DOCX parser, so a parser refusal can be injected. */
  docxParser?: DocxParser;
  /** Overrides the PDF parser, so a parser refusal can be injected. */
  pdfParser?: PdfParser;
}

/** An unexposed transcript store over the workspace's committed metadata. */
export interface TranscriptStore {
  /** The workspace store the metadata is committed through. */
  readonly store: Store;
  /**
   * Import exactly one raw paste or file for a meeting create or target and
   * commit its transcript metadata. See the module comment for the rules.
   */
  importTranscript(input: TranscriptInput, target: TranscriptTarget): Promise<TranscriptImportResult>;
  /** Read one committed source with its verified original and detached values. */
  readSource(transcriptId: unknown, sourceId: unknown): Promise<TranscriptSourceRead>;
  /** Detached, read-only committed transcript metadata. */
  transcripts(): readonly Transcript[];
  /** Release ownership of the workspace. */
  close(): Promise<void>;
}

const INPUT_KEYS = ["kind", "text", "bytes", "filename"] as const;
const CREATE_KEYS = ["clientId", "engagementId", "projectId", "title", "date", "notes"] as const;
const TARGET_KEYS = ["create", "meetingId"] as const;

function requireRecord(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new ValidationError(`${what} has unsupported field ${JSON.stringify(key)}`);
    }
  }
  return record;
}

function requireNonblank(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${what} must be a nonblank string`);
  }
  return value;
}

function optionalText(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${what} must be a string`);
  return value;
}

function optionalNonblank(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonblank(value, what);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The exact stored source id for a distinct original of a transcript. */
function sourceIdFor(transcriptId: string, originalSha256: string): string {
  return `${transcriptId}/o${originalSha256}`;
}

/** The accepted result of a successful import outcome. */
function importedResult(outcome: ImportOutcome): ImportResult {
  if (!outcome.ok) throw new ValidationError("unreachable: a refused import has no result");
  return (outcome as { ok: true; result: ImportResult }).result;
}

/** True when the source is a pasted original (its text is stored). */
function isPasted(source: TranscriptSource): boolean {
  return source.format === "paste";
}

/** The parsed import a call carries, before anything is written. */
interface PreparedImport {
  readonly result: ImportResult;
  /** True when the original is a file's bytes, published to the hash store. */
  readonly file: boolean;
}

/** The mutable transcript draft a commit is applied to. */
interface DraftState {
  meetings: Meeting[];
  transcripts: Transcript[];
  [key: string]: unknown;
}

/** The store's internal transcript commit, over the committed state. */
interface CommitStore {
  nextMeetingId(): string;
  nextId(draft: DraftState, key: "meetings"): string;
  commitTranscripts(
    mutate: (draft: DraftState) => {
      value: unknown;
      event?: { action: "create" | "edit"; targetKind: "meeting"; targetId: string };
    },
  ): Promise<unknown>;
  originalFiles(): OriginalStore;
  unavailable(): PersistenceError | null;
}

class TranscriptStoreImpl implements TranscriptStore {
  readonly store: Store;
  private readonly originals: OriginalStore;
  private readonly docxParser: DocxParser | undefined;
  private readonly pdfParser: PdfParser | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    store: Store,
    originals: OriginalStore,
    docxParser: DocxParser | undefined,
    pdfParser: PdfParser | undefined,
  ) {
    this.store = store;
    this.originals = originals;
    this.docxParser = docxParser;
    this.pdfParser = pdfParser;
  }

  /** Serialize the whole import, so concurrent repeats see one another. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  transcripts(): readonly Transcript[] {
    return deepFreeze(clone(this.store.snapshot().transcripts ?? []));
  }

  private internals(): CommitStore {
    return this.store as unknown as CommitStore;
  }

  /** The failure that refuses writes when the store is closed or blocked. */
  private unavailable(): PersistenceError | null {
    return this.internals().unavailable();
  }

  importTranscript(input: TranscriptInput, target: TranscriptTarget): Promise<TranscriptImportResult> {
    return this.enqueue(async () => {
      // The store must accept writes; a closed or blocked store refuses before
      // anything is read or written.
      const unavailable = this.unavailable();
      if (unavailable !== null) throw unavailable;
      // The arguments are checked before any read or write, so a malformed
      // call writes nothing at all.
      const wanted = this.parseTarget(target);
      const prepared = await this.prepare(input);
      if (wanted.create !== undefined) {
        return this.commitCreate(prepared, wanted.create);
      }
      return this.commitTarget(prepared, wanted.meetingId!);
    });
  }

  /**
   * Read the raw input through the adapters. A non-string/non-bytes argument is
   * a programming error (`ValidationError`); a parser or content refusal is
   * classified as `parser_refused`, with the refusal unchanged, and nothing is
   * written.
   */
  private async prepare(input: TranscriptInput): Promise<PreparedImport> {
    const record = requireRecord(input, "transcript input", INPUT_KEYS);
    const kind = record.kind;
    if (kind === "paste") {
      if ("bytes" in record || "filename" in record) {
        throw new ValidationError("transcript input carries exactly one raw paste or file, not both");
      }
      const outcome = importPastedText(record.text);
      return this.accepted(outcome, false);
    }
    if (kind !== "file") {
      throw new ValidationError('transcript input.kind must be "paste" or "file"');
    }
    if ("text" in record) {
      throw new ValidationError("transcript input carries exactly one raw paste or file, not both");
    }
    if (!(record.bytes instanceof Uint8Array)) {
      throw new ValidationError("transcript input.bytes must be a Uint8Array");
    }
    const filename = requireNonblank(record.filename, "transcript input.filename");
    const bytes = new Uint8Array(record.bytes);
    if (bytes.length > MAX_TRANSCRIPT_BYTES) {
      throw new ValidationError(
        `the original is ${bytes.length} bytes; it must be at most ${MAX_TRANSCRIPT_BYTES} bytes`,
      );
    }
    const lower = filename.toLowerCase();
    let outcome: ImportOutcome;
    if (lower.endsWith(".docx")) {
      outcome = (await importDocx(bytes, filename, this.docxParser)) as ImportOutcome;
    } else if (lower.endsWith(".pdf")) {
      outcome = (await importPdf(bytes, filename, this.pdfParser)) as ImportOutcome;
    } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
      outcome = importFileBytes(bytes, filename);
    } else {
      throw new ValidationError(
        `the file ${JSON.stringify(filename)} is not a supported format; import pasted text, or a .txt, .md, .docx or .pdf file`,
      );
    }
    return this.accepted(outcome, true);
  }

  /** Accept a successful import, refusing a refusal as a classified refusal. */
  private accepted(outcome: ImportOutcome, file: boolean): PreparedImport {
    if (!outcome.ok) {
      const refusal = (outcome as { ok: false; refusal: { code: string; message: string; supportedExports: readonly string[] } }).refusal;
      const error = new ValidationError(`transcript_refused: ${refusal.message}`);
      (error as ValidationError & { code?: string; refusal?: unknown }).code = "parser_refused";
      (error as ValidationError & { code?: string; refusal?: unknown }).refusal = refusal;
      throw error;
    }
    const result = importedResult(outcome);
    requireWellFormed(result);
    return { result, file };
  }

  /** Validate the target: exactly one of a meeting create or a meeting id. */
  private parseTarget(target: TranscriptTarget): { create?: TranscriptMeetingCreate; meetingId?: string } {
    const record = requireRecord(target, "transcript target", TARGET_KEYS);
    const hasCreate = record.create !== undefined;
    const hasMeeting = record.meetingId !== undefined;
    if (hasCreate === hasMeeting) {
      throw new ValidationError("transcript target must carry either a meeting create or a target meetingId");
    }
    if (hasCreate) {
      const create = requireRecord(record.create, "transcript target.create", CREATE_KEYS) as unknown as TranscriptMeetingCreate;
      requireNonblank(create.clientId, "transcript target.create.clientId");
      requireNonblank(create.engagementId, "transcript target.create.engagementId");
      optionalNonblank(create.projectId, "transcript target.create.projectId");
      requireNonblank(create.title, "transcript target.create.title");
      requireNonblank(create.date, "transcript target.create.date");
      optionalText(create.notes, "transcript target.create.notes");
      return { create };
    }
    return { meetingId: requireNonblank(record.meetingId, "transcript target.meetingId") };
  }

  /**
   * The canonical transcript for the import's canonical content in the meeting's
   * engagement, or undefined when the engagement holds none. The engagement is
   * the meeting's authoritative parent, so this never trusts a caller's scope.
   */
  private canonicalFor(snapshot: ReturnType<Store["snapshot"]>, meeting: Meeting, canonicalText: string): Transcript | undefined {
    const transcripts = snapshot.transcripts ?? [];
    const meetings = new Map(snapshot.meetings.map((m) => [m.id, m]));
    return transcripts.find((transcript) => {
      if (transcript.canonicalText !== canonicalText) return false;
      const holder = meetings.get(transcript.meetingId);
      return holder !== undefined && holder.engagementId === meeting.engagementId;
    });
  }

  /** The meeting of a canonical transcript, refusing a stored dangling link. */
  private meetingOf(snapshot: ReturnType<Store["snapshot"]>, transcript: Transcript): Meeting {
    const meeting = snapshot.meetings.find((m) => m.id === transcript.meetingId);
    if (meeting === undefined) {
      throw new ValidationError(
        `transcript ${JSON.stringify(transcript.id)} references missing meeting ${JSON.stringify(transcript.meetingId)}`,
      );
    }
    return meeting;
  }

  /**
   * Whether the canonical transcript already holds an original with the exact
   * bytes of the prepared import, returning that stored source when it does.
   */
  private existingSource(transcript: Transcript, prepared: PreparedImport): TranscriptSource | undefined {
    const wanted = prepared.file
      ? `sha256:${sha256Hex(prepared.result.originalBytes)}`
      : `text:${sha256Hex(new TextEncoder().encode(prepared.result.originalText))}`;
    return transcript.sources.find((source) => {
      if (isPasted(source) !== !prepared.file) return false;
      if (!prepared.file) {
        return source.originalText === prepared.result.originalText;
      }
      return source.originalSha256 !== undefined && `sha256:${source.originalSha256}` === wanted;
    });
  }

  /**
   * Build the stored source for a new original of the transcript, keeping the
   * adapter's extracted text and passage mappings under a source identity
   * derived from the original's exact bytes.
   */
  private newSource(transcriptId: string, prepared: PreparedImport): TranscriptSource {
    const result = prepared.result;
    const id = sourceIdFor(transcriptId, result.originalSha256);
    const passages: readonly Passage[] = result.passages.map((passage) => ({
      ...passage,
      sourceId: id,
    }));
    if (prepared.file) {
      return {
        id,
        format: result.format,
        filename: result.filename,
        originalSha256: result.originalSha256,
        originalLength: result.originalBytes.length,
        extractedText: result.extractedText,
        passages,
      };
    }
    return {
      id,
      format: "paste",
      filename: result.filename,
      originalText: result.originalText,
      extractedText: result.extractedText,
      passages,
    };
  }

  /**
   * The conflicts between the supplied metadata and the preserved meeting. A
   * supplied title always has to be a real meeting title, already checked; a
   * supplied value that differs from the preserved one is reported. Notes may
   * be supplied blank, and only a nonblank supplied note that differs is a
   * conflict.
   */
  private conflicts(create: TranscriptMeetingCreate, meeting: Meeting): TranscriptConflict[] {
    const conflicts: TranscriptConflict[] = [];
    const title = (create.title as string).trim();
    if (title !== meeting.title) {
      conflicts.push({ field: "title", supplied: title, preserved: meeting.title });
    }
    const notes = create.notes as string | undefined;
    if (notes !== undefined && notes.trim() !== "" && notes !== meeting.notes) {
      conflicts.push({ field: "notes", supplied: notes, preserved: meeting.notes });
    }
    return conflicts;
  }

  /**
   * Commit an import whose content is new to the engagement. With a meeting
   * create, one meeting is created and one new original attached; with a
   * supplied target, a notes-only meeting is attached once, and any other
   * meeting's transcript becomes its own transcript attached once.
   */
  private async commitCreate(prepared: PreparedImport, create: TranscriptMeetingCreate): Promise<TranscriptImportResult> {
    const snapshot = this.store.snapshot();
    // The create's metadata is validated as a meeting first, so an invalid
    // title or date writes nothing; the meeting id names the next allocation.
    const internals = this.internals();
    const meetingId = internals.nextMeetingId();
    parseMeeting({
      id: meetingId,
      clientId: create.clientId,
      engagementId: create.engagementId,
      ...(create.projectId === undefined ? {} : { projectId: create.projectId }),
      title: create.title,
      date: create.date,
      notes: create.notes === undefined ? "" : create.notes,
    });
    const clientId = create.clientId as string;
    const engagementId = create.engagementId as string;
    // A missing or mismatched parent chain is refused before any write.
    const client = snapshot.clients.find((c) => c.id === clientId);
    if (client === undefined) throw new MissingRecordError(`No client with id ${JSON.stringify(clientId)}`);
    const engagement = snapshot.engagements.find((e) => e.id === engagementId);
    if (engagement === undefined) throw new MissingRecordError(`No engagement with id ${JSON.stringify(engagementId)}`);
    if (engagement.clientId !== clientId) {
      throw new ValidationError(
        `engagementId ${JSON.stringify(engagementId)} does not belong to clientId ${JSON.stringify(clientId)}`,
      );
    }
    const projectId = optionalNonblank(create.projectId, "transcript target.create.projectId");
    if (projectId !== undefined) {
      const project = snapshot.projects.find((p) => p.id === projectId);
      if (project === undefined) throw new MissingRecordError(`No project with id ${JSON.stringify(projectId)}`);
      if (project.engagementId !== engagementId) {
        throw new ValidationError(
          `projectId ${JSON.stringify(projectId)} does not belong to engagementId ${JSON.stringify(engagementId)}`,
        );
      }
    }
    const built = this.buildCreate(prepared, create, meetingId);
    const { transcriptId, sourceId } = built;
    // The engagement's canonical content is reused before any second
    // attachment: a create for content the engagement already holds never
    // creates another meeting for it.
    const canonicalText = prepared.result.canonicalText;
    const existing = snapshot.transcripts!.find((transcript) => {
      if (transcript.canonicalText !== canonicalText) return false;
      const holder = this.meetingOf(snapshot, transcript);
      return holder.engagementId === engagementId;
    });
    if (existing !== undefined) {
      const canonicalMeeting = this.meetingOf(snapshot, existing);
      const existingArchived = this.isArchived(snapshot, canonicalMeeting);
      const repeated = this.existingSource(existing, prepared);
      if (repeated === undefined && prepared.file) await this.publish(prepared);
      const built = repeated === undefined ? this.buildAttach(existing, prepared) : null;
      if (built !== null) {
        await this.write(built, { action: "edit", targetId: canonicalMeeting.id });
      }
      const committed = this.store.snapshot();
      const transcript = committed.transcripts!.find((t) => t.id === existing.id)!;
      return {
        outcome: "reused",
        meeting: canonicalMeeting,
        transcript,
        canonicalMeetingId: canonicalMeeting.id,
        sourceIds: transcript.sources.map((source) => source.id),
        createdMeeting: false,
        attachedOriginal: repeated === undefined,
        conflicts: this.conflicts(create, canonicalMeeting),
        explanation: {
          code: existingArchived ? "archived_canonical" : "reused_canonical",
          message:
            (existingArchived
              ? "The engagement already holds this canonical content on an archived meeting; that meeting is reused and stays archived."
              : "The engagement already holds this canonical content; its canonical meeting is reused.") +
            (repeated === undefined ? "" : " This exact original is already stored and was reused."),
        },
      };
    }

    if (prepared.file) {
      await this.publish(prepared);
    }
    await this.write(built, { action: "create", targetId: meetingId });
    const committed = this.store.snapshot();
    const transcript = committed.transcripts!.find((t) => t.id === transcriptId)!;
    const meeting = committed.meetings.find((m) => m.id === meetingId)!;
    return {
      outcome: "created",
      meeting,
      transcript,
      sourceIds: [sourceId],
      createdMeeting: true,
      attachedOriginal: true,
      conflicts: [],
    };
  }

  /**
   * Attach the prepared import to a supplied meeting. The meeting must exist
   * with valid parents. New content to a notes-only meeting attaches once; new
   * content to a meeting that already has a transcript becomes its own
   * transcript. Existing content reuses its canonical meeting and never changes
   * the supplied target.
   */
  private async commitTarget(prepared: PreparedImport, meetingId: string): Promise<TranscriptImportResult> {
    const snapshot = this.store.snapshot();
    const target = this.findMeeting(snapshot, meetingId);
    const canonicalText = prepared.result.canonicalText;
    const existing = this.canonicalFor(snapshot, target, canonicalText);

    if (existing !== undefined) {
      const canonicalMeeting = this.meetingOf(snapshot, existing);
      const existingArchived = this.isArchived(snapshot, canonicalMeeting);
      // An exact repeat of a stored original attaches nothing and records
      // nothing: its stored source id and first filename are reused.
      const repeat = this.existingSource(existing, prepared);
      if (repeat !== undefined) {
        const sameTarget = canonicalMeeting.id === target.id;
        return {
          outcome: "reused",
          meeting: canonicalMeeting,
          transcript: existing,
          ...(sameTarget ? {} : { canonicalMeetingId: canonicalMeeting.id }),
          sourceIds: existing.sources.map((source) => source.id),
          createdMeeting: false,
          attachedOriginal: false,
          conflicts: [],
          explanation: sameTarget
            ? {
                code: "exact_repeat",
                message: "This exact original is already stored for the canonical transcript; nothing was written.",
              }
            : this.otherMeetingExplanation(target, canonicalMeeting, "exact_repeat"),
        };
      }
      // Distinct original bytes of the same canonical content: a new original
      // is retained with its own text and mappings, attached once with an edit
      // event. The target meeting is never changed.
      if (prepared.file) await this.publish(prepared);
      const built = this.buildAttach(existing, prepared);
      await this.write(built, { action: "edit", targetId: canonicalMeeting.id });
      const committed = this.store.snapshot();
      const transcript = committed.transcripts!.find((t) => t.id === existing.id)!;
      const sameTarget = canonicalMeeting.id === target.id;
      return {
        outcome: "new_source",
        meeting: canonicalMeeting,
        transcript,
        ...(sameTarget ? {} : { canonicalMeetingId: canonicalMeeting.id }),
        sourceIds: transcript.sources.map((source) => source.id),
        createdMeeting: false,
        attachedOriginal: true,
        conflicts: [],
        explanation: sameTarget
          ? {
              code: "new_original",
              message: "A distinct original was retained for the canonical transcript with its own text and mappings.",
            }
          : this.otherMeetingExplanation(target, canonicalMeeting, "new_original"),
      };
    }

    // New content for this engagement. The target's own attachment decides the
    // meeting: a notes-only meeting is attached once, any other meeting's
    // transcript becomes its own transcript (a transcript never replaces an
    // attachment).
    const targetTranscript = snapshot.transcripts!.find((t) => t.meetingId === target.id);
    const attachHere = targetTranscript === undefined && target.notes === "";
    if (prepared.file) await this.publish(prepared);
    const built = attachHere
      ? this.buildAttachTo(target, prepared)
      : this.buildSeparate(target, prepared);
    await this.write(built, { action: "edit", targetId: built.meetingId });
    const committed = this.store.snapshot();
    const transcript = committed.transcripts!.find((t) => t.id === prepared.result.id)!;
    const meeting = committed.meetings.find((m) => m.id === built.meetingId)!;
    return attachHere
      ? {
          outcome: "attached",
          meeting,
          transcript,
          sourceIds: transcript.sources.map((source) => source.id),
          createdMeeting: false,
          attachedOriginal: true,
          conflicts: [],
          explanation: {
            code: "attached_notes_only",
            message: "The new transcript was attached once to the notes-only meeting; its metadata is kept.",
          },
        }
      : {
          outcome: "separate_transcript",
          meeting,
          transcript,
          sourceIds: transcript.sources.map((source) => source.id),
          createdMeeting: false,
          attachedOriginal: true,
          conflicts: [],
          explanation: this.otherMeetingExplanation(target, meeting, "separate_transcript"),
        };
  }

  /** The explanation for an outcome that left the supplied target unchanged. */
  private otherMeetingExplanation(target: Meeting, canonical: Meeting, code: TranscriptExplanation["code"]): TranscriptExplanation {
    return {
      code: code === "exact_repeat" ? "other_meeting" : "separate_transcript",
      message:
        `The target meeting ${JSON.stringify(target.id)} was left unchanged; ` +
        `the canonical meeting is ${JSON.stringify(canonical.id)}.`,
    };
  }

  /** A meeting by id with its parent chain checked, or a classified refusal. */
  private findMeeting(snapshot: ReturnType<Store["snapshot"]>, meetingId: string): Meeting {
    const meeting = snapshot.meetings.find((m) => m.id === meetingId);
    if (meeting === undefined) throw new MissingRecordError(`No meeting with id ${JSON.stringify(meetingId)}`);
    if (!snapshot.clients.some((c) => c.id === meeting.clientId)) {
      throw new ValidationError(`meeting ${JSON.stringify(meeting.id)} references a missing client`);
    }
    const engagement = snapshot.engagements.find((e) => e.id === meeting.engagementId);
    if (engagement === undefined) {
      throw new ValidationError(`meeting ${JSON.stringify(meeting.id)} references a missing engagement`);
    }
    if (engagement.clientId !== meeting.clientId) {
      throw new ValidationError(`meeting ${JSON.stringify(meeting.id)} has mismatched client and engagement links`);
    }
    if (meeting.projectId !== undefined) {
      const project = snapshot.projects.find((p) => p.id === meeting.projectId);
      if (project === undefined || project.engagementId !== meeting.engagementId) {
        throw new ValidationError(`meeting ${JSON.stringify(meeting.id)} references a missing or mismatched project`);
      }
    }
    return meeting;
  }

  /**
   * Whether the meeting's engagement or client is archived. Archived canonical
   * meetings are reused like active ones, and the result says so.
   */
  private isArchived(snapshot: ReturnType<Store["snapshot"]>, meeting: Meeting): boolean {
    const engagement = snapshot.engagements.find((e) => e.id === meeting.engagementId);
    const client = snapshot.clients.find((c) => c.id === meeting.clientId);
    return engagement?.archived === true || client?.archived === true;
  }

  /**
   * Publish the prepared file original before the JSON that names it. A new
   * distinct original is published under its hash; the returned reference is
   * verified. A publication failure is a persistence failure and publishes no
   * metadata. An already stored, verified original is reused as is.
   */
  private async publish(prepared: PreparedImport): Promise<void> {
    try {
      await this.originals.put(prepared.result.originalBytes);
    } catch (cause) {
      if (cause instanceof ValidationError || cause instanceof MissingRecordError) throw cause;
      if (cause instanceof PersistenceError) throw cause;
      throw new PersistenceError("Failed to publish the transcript original", { cause });
    }
  }

  /**
   * Run one transcript commit through the workspace store: the mutation builds
   * the draft, the store validates and persists it, and this commit's one event
   * (when earned) is stamped with its target. Only a full success publishes the
   * new memory and resolves; any failure publishes nothing.
   */
  private async write(
    built: { mutate: (draft: DraftState) => { value: unknown } },
    event: { action: "create" | "edit"; targetId: string },
  ): Promise<void> {
    await this.internals().commitTranscripts((draft) => ({
      value: built.mutate(draft).value,
      event: { action: event.action, targetKind: "meeting", targetId: event.targetId },
    }));
  }

  /** A meeting built from a validated create, exactly as the store would. */
  private buildCreate(prepared: PreparedImport, create: TranscriptMeetingCreate, meetingId: string) {
    const result = prepared.result;
    const source = this.newSource(result.id, prepared);
    return {
      meetingId,
      transcriptId: result.id,
      sourceId: source.id,
      source,
      mutate: (draft: DraftState) => {
        const id = this.internals().nextId(draft, "meetings");
        draft.meetings.push(
          parseMeeting({
            id,
            clientId: create.clientId,
            engagementId: create.engagementId,
            ...(create.projectId === undefined ? {} : { projectId: create.projectId }),
            title: create.title,
            date: create.date,
            notes: create.notes === undefined ? "" : create.notes,
          }),
        );
        draft.transcripts.push({
          id: result.id,
          canonicalText: result.canonicalText,
          meetingId,
          sources: [source],
        });
        return { value: undefined };
      },
    };
  }

  /** A distinct original appended to the canonical transcript. */
  private buildAttach(transcript: Transcript, prepared: PreparedImport) {
    const result = prepared.result;
    const source = this.newSource(result.id, prepared);
    return {
      meetingId: transcript.meetingId,
      transcriptId: transcript.id,
      sourceId: source.id,
      source,
      mutate: (draft: DraftState) => {
        const current = draft.transcripts.find((t) => t.id === transcript.id);
        if (current === undefined) {
          throw new MissingRecordError(`No transcript with id ${JSON.stringify(transcript.id)}`);
        }
        draft.transcripts[draft.transcripts.indexOf(current)] = {
          ...current,
          sources: [...current.sources, source],
        };
        return { value: undefined };
      },
    };
  }

  /** A first transcript attached to a notes-only meeting, keeping its metadata. */
  private buildAttachTo(target: Meeting, prepared: PreparedImport) {
    const result = prepared.result;
    const source = this.newSource(result.id, prepared);
    return {
      meetingId: target.id,
      transcriptId: result.id,
      sourceId: source.id,
      source,
      mutate: (draft: DraftState) => {
        draft.transcripts.push({
          id: result.id,
          canonicalText: result.canonicalText,
          meetingId: target.id,
          sources: [source],
        });
        return { value: undefined };
      },
    };
  }

  /** A new transcript for a meeting that already holds one or carries notes. */
  private buildSeparate(target: Meeting, prepared: PreparedImport) {
    const result = prepared.result;
    const source = this.newSource(result.id, prepared);
    return {
      meetingId: target.id,
      transcriptId: result.id,
      sourceId: source.id,
      source,
      mutate: (draft: DraftState) => {
        draft.transcripts.push({
          id: result.id,
          canonicalText: result.canonicalText,
          meetingId: target.id,
          sources: [source],
        });
        return { value: undefined };
      },
    };
  }

  /**
   * Read one committed source. The metadata must be committed and validated
   * (reopening refuses anything else, and this store validates it too); the
   * original must verify against its stored hash, or the read fails without any
   * repair. The result holds detached values only: never a path, handle or the
   * store's buffers. A pasted original's exact text is returned as its bytes.
   */
  async readSource(transcriptId: unknown, sourceId: unknown): Promise<TranscriptSourceRead> {
    return this.enqueue(async () => {
      const unavailable = this.unavailable();
      if (unavailable !== null) throw unavailable;
      const wantedTranscript = requireNonblank(transcriptId, "transcriptId");
      const wantedSource = requireNonblank(sourceId, "sourceId");
      const transcripts = this.transcripts();
      const transcript = transcripts.find((t) => t.id === wantedTranscript);
      if (transcript === undefined) {
        throw new MissingRecordError(`No transcript with id ${JSON.stringify(wantedTranscript)}`);
      }
      const source = transcript.sources.find((s) => s.id === wantedSource);
      if (source === undefined) {
        throw new MissingRecordError(
          `No source ${JSON.stringify(wantedSource)} in transcript ${JSON.stringify(wantedTranscript)}`,
        );
      }
      const meeting = this.findMeeting(this.store.snapshot(), transcript.meetingId);
      const { bytes, sha256 } = await this.readOriginal(source);
      const passages = deepFreeze(clone(source.passages.map((passage) => validatePassage(passage))));
      const read: TranscriptSourceRead = {
        transcriptId: transcript.id,
        meetingId: meeting.id,
        sourceId: source.id,
        format: source.format,
        filename: source.filename,
        originalBytes: new Uint8Array(bytes),
        originalSha256: sha256,
        extractedText: source.extractedText,
        passages,
        ...(source.originalSha256 === undefined
          ? {}
          : {
              reference: Object.freeze({ sha256: source.originalSha256, byteLength: bytes.length }),
            }),
      };
      return Object.freeze(read);
    });
  }

  /**
   * Read and verify the source's original. A file original is read through the
   * hash repository, whose path is derived only from the stored hash; a pasted
   * original is its stored exact text. The bytes must match the source's
   * identity and the stored length, or the read fails as a persistence failure
   * and nothing is repaired.
   */
  private async readOriginal(source: TranscriptSource): Promise<{ bytes: Uint8Array; sha256: string }> {
    if (source.originalSha256 === undefined) {
      // A pasted original is its exact text; the bytes the import carried are
      // that text's UTF-8 encoding, which is what the read returns.
      if (source.originalText === undefined) {
        throw new PersistenceError(`Source ${JSON.stringify(source.id)} has no stored pasted original`);
      }
      const bytes = new TextEncoder().encode(source.originalText);
      return { bytes, sha256: sha256Hex(bytes) };
    }
    let reference: { sha256: string; byteLength: number; bytes: Uint8Array };
    try {
      reference = await this.originals.read(source.originalSha256);
    } catch (cause) {
      throw new PersistenceError(
        `The original ${source.originalSha256} of source ${JSON.stringify(source.id)} could not be read or verified`,
        { cause },
      );
    }
    if (reference.byteLength !== source.originalLength) {
      throw new PersistenceError(
        `The original ${source.originalSha256} of source ${JSON.stringify(source.id)} is ${reference.byteLength} bytes, not the stored ${source.originalLength}`,
      );
    }
    if (sha256Hex(reference.bytes) !== source.originalSha256) {
      throw new PersistenceError(
        `The original ${source.originalSha256} of source ${JSON.stringify(source.id)} does not match its hash`,
      );
    }
    return { bytes: reference.bytes, sha256: reference.sha256 };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

/** Require the import's text to be well-formed Unicode within the limit. */
function requireWellFormed(result: ImportResult): void {
  for (const [what, text] of [
    ["originalText", result.originalText],
    ["extractedText", result.extractedText],
  ] as const) {
    if (!isWellFormedUnicode(text)) {
      throw new ValidationError(`the import's ${what} is not well-formed Unicode`);
    }
    if (utf8Length(text) > MAX_TRANSCRIPT_BYTES) {
      throw new ValidationError(`the import's ${what} exceeds the content limit`);
    }
  }
}

/**
 * Open the workspace store and a transcript store over it. The original-file
 * store is the workspace's own, so the metadata the transcript store commits
 * names originals in the same repository the workspace keeps.
 */
export async function openTranscriptStore(
  directory: string,
  options: TranscriptStoreOptions = {},
): Promise<TranscriptStore> {
  const store = await openStore(directory, options);
  try {
    const internals = store as unknown as CommitStore;
    return new TranscriptStoreImpl(store, internals.originalFiles(), options.docxParser, options.pdfParser);
  } catch (cause) {
    await store.close();
    throw cause;
  }
}

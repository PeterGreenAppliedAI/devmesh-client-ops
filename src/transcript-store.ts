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
  type ImportFormat,
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
  /** New content attached to a meeting that was not notes-only. */
  | "new_transcript";

/** A difference between the supplied metadata and what is preserved. */
export interface TranscriptConflict {
  /** The field whose supplied value differs from the preserved one. */
  readonly field: "title" | "notes" | "date" | "projectId";
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
    | "new_transcript";
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
  /** The engagement that authoritatively holds the transcript, for scope. */
  readonly engagementId: string;
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
  nextId(draft: DraftState, key: "meetings"): string;
  commitTranscripts(
    mutate: (draft: DraftState) => {
      value: unknown;
      event?: { action: "create" | "edit"; targetKind: "meeting"; targetId: string };
    },
  ): Promise<unknown>;
  /** Commit a no-op import through the ordinary persistence path. */
  commitNoop(mutate: (draft: DraftState) => { value: unknown }): Promise<unknown>;
  originalFiles(): OriginalStore;
  unavailable(): PersistenceError | null;
}

/** The target scope the import was aimed at, for the result's explanation. */
interface WantedTarget {
  readonly kind: "create" | "meeting";
  /** The supplied meeting id, when the import targeted one. */
  readonly meetingId?: string;
  /** The supplied meeting create's canonical title and notes, when creating. */
  readonly title?: string;
  readonly notes?: string;
}

/** What a commit resolves with, before the committed records are looked up. */
interface CommittedOutcome {
  readonly outcome: "created" | "attached" | "reused" | "new_source" | "new_transcript";
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly createdMeeting: boolean;
  readonly attachedOriginal: boolean;
  readonly conflicts: TranscriptConflict[];
  /** True when nothing was written: an exact repeat or a read-like outcome. */
  readonly noop: boolean;
  readonly explanationCode?: TranscriptExplanation["code"];
}

class TranscriptStoreImpl implements TranscriptStore {
  readonly store: Store;
  private readonly originals: OriginalStore;
  private readonly docxParser: DocxParser | undefined;
  private readonly pdfParser: PdfParser | undefined;

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

  transcripts(): readonly Transcript[] {
    return deepFreeze(clone(this.store.snapshot().transcripts ?? []));
  }

  /** Run an operation inside the workspace store's own mutation queue. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return (this.store as unknown as { runExclusive<T>(op: () => Promise<T>): Promise<T> }).runExclusive(operation);
  }

  private internals(): CommitStore {
    return this.store as unknown as CommitStore;
  }

  /** The failure that refuses writes when the store is closed or blocked. */
  private unavailable(): PersistenceError | null {
    return this.internals().unavailable();
  }

  /**
   * Import exactly one raw paste or file. The whole import (its argument
   * validation, the blob publication and the JSON commit) runs through the
   * workspace store's own mutation queue and commit, so it is serialized with
   * every ordinary store operation: the association is allocated from the id
   * actually committed, and an intervening store write cannot move it.
   */
  importTranscript(input: TranscriptInput, target: TranscriptTarget): Promise<TranscriptImportResult> {
    return this.exclusive(async () => {
      const unavailable = this.unavailable();
      if (unavailable !== null) throw unavailable;
      // The arguments are checked before any read or write, so a malformed
      // call writes nothing at all.
      const parsed = this.parseTarget(target);
      const wanted = parsed.wanted;
      const prepared = await this.prepare(input);
      const committed =
        parsed.create !== undefined
          ? await this.commitCreate(prepared, parsed.create)
          : await this.commitTarget(prepared, parsed.meetingId!);
      return this.result(committed, wanted);
    });
  }

  /**
   * Read the raw input through the adapters. A non-string/non-bytes argument or
   * an unsupported shape is a programming error (`ValidationError`); a parser or
   * content refusal keeps its classification (`parser_refused`, with the
   * adapter's refusal code and guidance), and nothing is written.
   */
  private async prepare(input: TranscriptInput): Promise<PreparedImport> {
    const record = requireRecord(input, "transcript input", INPUT_KEYS);
    const kind = record.kind;
    if (kind === "paste") {
      if ("bytes" in record || "filename" in record) {
        throw new ValidationError("transcript input carries exactly one raw paste or file, not both");
      }
      if (typeof record.text !== "string") {
        throw new ValidationError("transcript input.text must be a string");
      }
      // The paste's own limit is the core adapter's refusal, classified like
      // every other refusal, so an oversized paste is not an argument error.
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
    // The original's limit, the format and the document contents are all the
    // adapters' refusals: an oversized file or an unsupported extension keeps
    // its `too_large` or `unsupported_format` code and guidance.
    const format = fileFormat(filename);
    let outcome: ImportOutcome;
    if (format === "docx") {
      outcome = (await importDocx(bytes, filename, this.docxParser)) as ImportOutcome;
    } else if (format === "pdf") {
      outcome = (await importPdf(bytes, filename, this.pdfParser)) as ImportOutcome;
    } else {
      outcome = importFileBytes(bytes, filename);
    }
    return this.accepted(outcome, true);
  }

  /** Accept a successful import, refusing a refusal as a classified refusal. */
  private accepted(outcome: ImportOutcome, file: boolean): PreparedImport {
    if (!outcome.ok) {
      const refusal = (
        outcome as {
          ok: false;
          refusal: { code: string; message: string; supportedExports: readonly string[] };
        }
      ).refusal;
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
  private parseTarget(
    target: TranscriptTarget,
  ): { create?: TranscriptMeetingCreate; meetingId?: string; wanted: WantedTarget } {
    const record = requireRecord(target, "transcript target", TARGET_KEYS);
    const hasCreate = record.create !== undefined;
    const hasMeeting = record.meetingId !== undefined;
    if (hasCreate === hasMeeting) {
      throw new ValidationError("transcript target must carry either a meeting create or a target meetingId");
    }
    if (hasCreate) {
      const create = requireRecord(
        record.create,
        "transcript target.create",
        CREATE_KEYS,
      ) as unknown as TranscriptMeetingCreate;
      requireNonblank(create.clientId, "transcript target.create.clientId");
      requireNonblank(create.engagementId, "transcript target.create.engagementId");
      optionalNonblank(create.projectId, "transcript target.create.projectId");
      requireNonblank(create.title, "transcript target.create.title");
      requireNonblank(create.date, "transcript target.create.date");
      optionalText(create.notes, "transcript target.create.notes");
      return {
        create,
        wanted: {
          kind: "create",
          title: (create.title as string).trim(),
          notes: create.notes === undefined ? undefined : (create.notes as string).trim(),
        },
      };
    }
    const meetingId = requireNonblank(record.meetingId, "transcript target.meetingId");
    return { meetingId, wanted: { kind: "meeting", meetingId } };
  }

  /**
   * The meeting with the given id whose authoritative parent chain is valid, or
   * a classified refusal: a missing meeting is `MissingRecordError`, an invalid
   * ancestry is `ValidationError`.
   */
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
   * The meeting that authoritatively holds the canonical content, or undefined.
   * The engagement is resolved through the meeting's own valid parent chain, so
   * a caller's scope is never trusted and an identical transcript in another
   * engagement is never mistaken for this one.
   */
  private canonicalFor(
    snapshot: ReturnType<Store["snapshot"]>,
    engagementId: string,
    canonicalText: string,
  ): Meeting | undefined {
    for (const transcript of snapshot.transcripts ?? []) {
      if (transcript.canonicalText !== canonicalText) continue;
      const holder = this.findMeetingOrUndefined(snapshot, transcript.meetingId);
      if (holder !== undefined && holder.engagementId === engagementId) return holder;
    }
    return undefined;
  }

  /** The meeting of a stored transcript, or undefined for a dangling link. */
  private findMeetingOrUndefined(
    snapshot: ReturnType<Store["snapshot"]>,
    meetingId: string,
  ): Meeting | undefined {
    return snapshot.meetings.find((m) => m.id === meetingId);
  }

  /** The transcript held by exactly this meeting, or undefined. */
  private transcriptOf(
    snapshot: ReturnType<Store["snapshot"]>,
    meetingId: string,
  ): Transcript | undefined {
    return (snapshot.transcripts ?? []).find((transcript) => transcript.meetingId === meetingId);
  }

  /**
   * Whether the canonical meeting's engagement or client is archived. Archived
   * canonical meetings are reused like active ones, and the result says so.
   */
  private isArchived(snapshot: ReturnType<Store["snapshot"]>, meeting: Meeting): boolean {
    const engagement = snapshot.engagements.find((e) => e.id === meeting.engagementId);
    const client = snapshot.clients.find((c) => c.id === meeting.clientId);
    return engagement?.archived === true || client?.archived === true;
  }

  /**
   * Whether the canonical transcript already holds an original with the exact
   * bytes of the prepared import, returning that stored source when it does. A
   * file original is matched by its exact bytes' hash, a paste by its exact
   * text; neither is matched against the other kind's representation.
   */
  private existingSource(transcript: Transcript, prepared: PreparedImport): TranscriptSource | undefined {
    const wantedSha256 = sha256Hex(prepared.result.originalBytes);
    const wantedText = prepared.result.originalText;
    return transcript.sources.find((source) => {
      if (isPasted(source) !== !prepared.file) return false;
      if (!prepared.file) return source.originalText === wantedText;
      return source.originalSha256 === wantedSha256;
    });
  }

  /**
   * Build the stored source for a new original of the transcript, keeping the
   * adapter's extracted text and passage mappings under a source identity
   * derived from the original's exact bytes. Its id is unique within the
   * transcript: an identical id would mean the bytes were already stored, which
   * the existing-original check rules out before this is called.
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
   * The supplied differences from the preserved meeting, reported as conflicts
   * and never written. A supplied title, date, project or notes that differs
   * from the preserved value is reported, including an explicitly supplied blank
   * notes that differs from preserved notes.
   */
  private conflicts(create: TranscriptMeetingCreate, meeting: Meeting): TranscriptConflict[] {
    const conflicts: TranscriptConflict[] = [];
    const title = (create.title as string).trim();
    if (title !== meeting.title) {
      conflicts.push({ field: "title", supplied: title, preserved: meeting.title });
    }
    const date = (create.date as string).trim();
    if (date !== meeting.date) {
      conflicts.push({ field: "date", supplied: date, preserved: meeting.date });
    }
    const projectId = optionalNonblank(create.projectId, "transcript target.create.projectId");
    if (projectId !== meeting.projectId) {
      conflicts.push({ field: "projectId", supplied: projectId ?? "", preserved: meeting.projectId ?? "" });
    }
    const notes = create.notes as string | undefined;
    if (notes !== undefined && notes.trim() !== meeting.notes) {
      conflicts.push({ field: "notes", supplied: notes.trim(), preserved: meeting.notes });
    }
    return conflicts;
  }

  /**
   * Check a supplied create against the store's hierarchy before anything is
   * written: the meeting's own fields (title, date, notes) are validated as a
   * meeting, then its client, engagement and project links form one valid
   * chain. A missing record is `MissingRecordError`, a mismatched link is
   * `ValidationError`.
   */
  private requireCreateParents(snapshot: ReturnType<Store["snapshot"]>, create: TranscriptMeetingCreate): void {
    parseMeeting({
      id: "meeting-1",
      clientId: create.clientId,
      engagementId: create.engagementId,
      ...(create.projectId === undefined ? {} : { projectId: create.projectId }),
      title: create.title,
      date: create.date,
      notes: create.notes === undefined ? "" : create.notes,
    });
    const clientId = create.clientId as string;
    const engagementId = create.engagementId as string;
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
  }

  /**
   * Commit an import whose target is a meeting create. The create's content is
   * first checked against the engagement's canonical content: an engagement
   * that already holds it reuses its canonical meeting (archived included)
   * instead of creating a second one; otherwise one meeting and one transcript
   * are created with the supplied metadata.
   */
  private async commitCreate(
    prepared: PreparedImport,
    create: TranscriptMeetingCreate,
  ): Promise<CommittedOutcome> {
    const snapshot = this.store.snapshot();
    this.requireCreateParents(snapshot, create);
    const engagementId = create.engagementId as string;
    const canonical = this.canonicalFor(snapshot, engagementId, prepared.result.canonicalText);
    if (canonical !== undefined) {
      return this.reuse(prepared, canonical, snapshot, this.conflicts(create, canonical));
    }
    // The create is validated and the blob published before the JSON commit;
    // the meeting id is allocated from the draft the commit persists.
    return this.attachOrCreate(prepared, create, null);
  }

  /**
   * Commit an import whose target is a supplied meeting. The meeting and its
   * ancestry are validated first. Content the engagement already holds reuses
   * its canonical meeting and leaves the target unchanged; new content attaches
   * once to a notes-only meeting (keeping its metadata) or, for a meeting that
   * holds an attachment or carries notes, becomes the target's own transcript
   * without replacing anything.
   */
  private async commitTarget(prepared: PreparedImport, meetingId: string): Promise<CommittedOutcome> {
    const snapshot = this.store.snapshot();
    const target = this.findMeeting(snapshot, meetingId);
    const canonical = this.canonicalFor(snapshot, target.engagementId, prepared.result.canonicalText);
    if (canonical !== undefined) {
      return this.reuse(prepared, canonical, snapshot, []);
    }
    return this.attachOrCreate(prepared, null, target);
  }

  /**
   * Reuse the engagement's canonical meeting for this content. An exact repeat
   * of a stored original writes nothing (it is a no-op through the store's own
   * persistence path, so a save failure still rejects and nothing is added); a
   * distinct original is published and attached once with one edit event.
   */
  private async reuse(
    prepared: PreparedImport,
    canonical: Meeting,
    snapshot: ReturnType<Store["snapshot"]>,
    conflicts: readonly TranscriptConflict[],
  ): Promise<CommittedOutcome> {
    const transcript = this.transcriptOf(snapshot, canonical.id);
    if (transcript === undefined) {
      throw new ValidationError(
        `the canonical meeting ${JSON.stringify(canonical.id)} holds no transcript`,
      );
    }
    const archived = this.isArchived(snapshot, canonical);
    const base = {
      outcome: "reused" as const,
      meetingId: canonical.id,
      transcriptId: transcript.id,
      createdMeeting: false,
      conflicts: [...conflicts],
    };
    if (this.existingSource(transcript, prepared) !== undefined) {
      await this.noop();
      return {
        ...base,
        attachedOriginal: false,
        noop: true,
        explanationCode: archived ? "archived_canonical" : "exact_repeat",
      };
    }
    if (prepared.file) await this.publish(prepared);
    const source = this.newSource(transcript.id, prepared);
    await this.write(
      (draft) => {
        const current = draft.transcripts.find((t) => t.id === transcript.id && t.meetingId === canonical.id);
        if (current === undefined) {
          throw new MissingRecordError(`No transcript with id ${JSON.stringify(transcript.id)}`);
        }
        draft.transcripts[draft.transcripts.indexOf(current)] = {
          ...current,
          sources: [...current.sources, source],
        };
        return { value: undefined };
      },
      { action: "edit", targetId: canonical.id },
    );
    return {
      ...base,
      outcome: "new_source",
      attachedOriginal: true,
      noop: false,
      explanationCode: archived ? "archived_canonical" : "new_original",
    };
  }

  /**
   * Commit new content to one meeting: a create makes a meeting and its
   * transcript in one create, a supplied notes-only meeting receives its first
   * transcript (one edit, its metadata kept), and any other supplied meeting
   * receives its own new transcript (one edit). An existing attachment is never
   * replaced. Everything is built against the committed snapshot before the
   * mutation, which re-checks the target inside the serialized commit.
   */
  private async attachOrCreate(
    prepared: PreparedImport,
    create: TranscriptMeetingCreate | null,
    target: Meeting | null,
  ): Promise<CommittedOutcome> {
    if (prepared.file) await this.publish(prepared);
    const result = prepared.result;
    if (create !== null) {
      let meetingId = "";
      await this.write(
        (draft) => {
          const id = this.internals().nextId(draft, "meetings");
          const meeting = parseMeeting({
            id,
            clientId: create.clientId,
            engagementId: create.engagementId,
            ...(create.projectId === undefined ? {} : { projectId: create.projectId }),
            title: create.title,
            date: create.date,
            notes: create.notes === undefined ? "" : create.notes,
          });
          const source = this.newSource(result.id, prepared);
          draft.meetings.push(meeting);
          draft.transcripts.push({
            id: result.id,
            canonicalText: result.canonicalText,
            meetingId: id,
            sources: [source],
          });
          meetingId = id;
          return { value: undefined };
        },
        { action: "create", targetId: "" },
      );
      return {
        outcome: "created",
        meetingId,
        transcriptId: result.id,
        createdMeeting: true,
        attachedOriginal: true,
        conflicts: [],
        noop: false,
      };
    }
    if (target === null) throw new ValidationError("unreachable: an import has a create or a meeting target");
    const attachHere =
      !(this.store.snapshot().transcripts ?? []).some((t) => t.meetingId === target.id) &&
      target.notes === "";
    await this.write(
      (draft) => {
        const meeting = draft.meetings.find((m) => m.id === target.id);
        if (meeting === undefined) throw new MissingRecordError(`No meeting with id ${JSON.stringify(target.id)}`);
        const clash = draft.transcripts.some(
          (t) =>
            t.id === result.id &&
            draft.meetings.some((m) => m.id === t.meetingId && m.engagementId === meeting.engagementId),
        );
        if (clash) {
          throw new ValidationError(
            `engagement ${JSON.stringify(meeting.engagementId)} already holds this canonical transcript`,
          );
        }
        const source = this.newSource(result.id, prepared);
        draft.transcripts.push({
          id: result.id,
          canonicalText: result.canonicalText,
          meetingId: target.id,
          sources: [source],
        });
        return { value: undefined };
      },
      { action: "edit", targetId: target.id },
    );
    return {
      outcome: attachHere ? "attached" : "new_transcript",
      meetingId: target.id,
      transcriptId: result.id,
      createdMeeting: false,
      attachedOriginal: true,
      conflicts: [],
      noop: false,
      explanationCode: attachHere ? "attached_notes_only" : "new_transcript",
    };
  }

  /**
   * Publish the prepared file original before the JSON that names it. A new
   * distinct original is published under its hash, and the returned reference is
   * verified; a publication failure is a persistence failure and publishes no
   * metadata. An already stored, verified original is reused as is.
   */
  private async publish(prepared: PreparedImport): Promise<void> {
    let reference: { sha256: string; byteLength: number };
    try {
      reference = await this.originals.put(prepared.result.originalBytes);
    } catch (cause) {
      throw new PersistenceError("Failed to publish the transcript original", { cause });
    }
    if (
      reference.sha256 !== prepared.result.originalSha256 ||
      reference.byteLength !== prepared.result.originalBytes.length
    ) {
      throw new PersistenceError(
        "The published transcript original does not verify against its stored hash",
      );
    }
  }

  /**
   * Run one transcript commit through the workspace store: the mutation builds
   * the draft, the store validates and persists it, and this commit's one event
   * (when earned) is stamped with its target. Only a full success publishes the
   * new memory and resolves; any failure publishes nothing.
   */
  private async write(
    mutate: (draft: DraftState) => { value: unknown },
    event: { action: "create" | "edit"; targetId: string },
  ): Promise<void> {
    await this.internals().commitTranscripts((draft) => ({
      value: mutate(draft).value,
      event: {
        action: event.action,
        targetKind: "meeting",
        targetId: event.targetId === "" ? draft.meetings[draft.meetings.length - 1].id : event.targetId,
      },
    }));
  }

  /**
   * Persist an exact repeat through the ordinary no-op path: the draft it builds
   * is unchanged, so the store saves the committed state as a no-op and records
   * no event. A save failure rejects exactly as for any other write and adds
   * nothing.
   */
  private async noop(): Promise<void> {
    await this.internals().commitNoop((draft) => {
      validateTranscripts(draft.transcripts, draft as unknown as ReturnType<Store["snapshot"]>);
      return { value: undefined };
    });
  }

  /**
   * Resolve a committed outcome into the public result, looking the records up
   * in the committed snapshot and explaining any outcome that did not write to
   * the supplied target.
   */
  private result(committed: CommittedOutcome, wanted: WantedTarget): TranscriptImportResult {
    const snapshot = this.store.snapshot();
    const meeting = snapshot.meetings.find((m) => m.id === committed.meetingId);
    if (meeting === undefined) {
      throw new PersistenceError(`the committed meeting ${JSON.stringify(committed.meetingId)} is missing`);
    }
    const transcript = this.transcriptOf(snapshot, meeting.id);
    if (transcript === undefined) {
      throw new PersistenceError(`the committed meeting ${JSON.stringify(meeting.id)} holds no transcript`);
    }
    const aimedElsewhere =
      wanted.kind === "meeting" ? wanted.meetingId !== meeting.id : false;
    const explanation = this.explain(committed, wanted, meeting, aimedElsewhere);
    return deepFreeze({
      outcome: committed.outcome,
      meeting,
      transcript,
      ...(aimedElsewhere ? { canonicalMeetingId: meeting.id } : {}),
      sourceIds: transcript.sources.map((source) => source.id),
      createdMeeting: committed.createdMeeting,
      attachedOriginal: committed.attachedOriginal,
      conflicts: committed.conflicts,
      ...(explanation === undefined ? {} : { explanation }),
    });
  }

  /** The explanation a committed outcome carries, when it has one. */
  private explain(
    committed: CommittedOutcome,
    wanted: WantedTarget,
    meeting: Meeting,
    aimedElsewhere: boolean,
  ): TranscriptExplanation | undefined {
    if (aimedElsewhere) {
      return {
        code: "other_meeting",
        message:
          `The target meeting ${JSON.stringify(wanted.meetingId)} was left unchanged; ` +
          `the canonical meeting is ${JSON.stringify(meeting.id)}.`,
      };
    }
    switch (committed.explanationCode) {
      case "archived_canonical":
      case "reused_canonical": {
        const archived = committed.explanationCode === "archived_canonical";
        const held = archived
          ? "The engagement already holds this canonical content on an archived meeting; that meeting is reused and stays archived."
          : "The engagement already holds this canonical content; its canonical meeting is reused.";
        return {
          code: committed.explanationCode,
          message: committed.noop ? `${held} This exact original is already stored and was reused.` : held,
        };
      }
      case "attached_notes_only":
        return {
          code: "attached_notes_only",
          message: "The new transcript was attached once to the notes-only meeting; its metadata is kept.",
        };
      case "new_original":
        return {
          code: "new_original",
          message: "A distinct original was retained for the canonical transcript with its own text and mappings.",
        };
      case "exact_repeat":
        return {
          code: "exact_repeat",
          message: "This exact original is already stored for the canonical transcript; nothing was written.",
        };
      case "new_transcript":
        return {
          code: "new_transcript",
          message:
            `The meeting ${JSON.stringify(meeting.id)} received its own new transcript; ` +
            "its existing transcripts are unchanged and nothing was replaced.",
        };
      default:
        return undefined;
    }
  }

  /**
   * Read one committed source. The metadata must be committed and validated
   * (reopening refuses anything else, and this store validates it too); the
   * original must verify against its stored hash or exact text, or the read
   * fails without any repair. The result holds detached values only: never a
   * path, handle or the store's buffers.
   */
  readSource(transcriptId: unknown, sourceId: unknown): Promise<TranscriptSourceRead> {
    return this.exclusive(async () => {
      const unavailable = this.unavailable();
      if (unavailable !== null) throw unavailable;
      const wantedTranscript = requireNonblank(transcriptId, "transcriptId");
      const wantedSource = requireNonblank(sourceId, "sourceId");
      // Only committed, validated metadata is read; the transcript is scoped by
      // the meeting that authoritatively holds it.
      // A canonical transcript id is unique within an engagement but may name a
      // transcript in each of several engagements, so the read resolves the id
      // against the meetings' authoritative parents: it is refused as ambiguous
      // when several engagements hold it, and otherwise read in its one scope.
      const snapshot = this.store.snapshot();
      const holders = (snapshot.transcripts ?? []).filter((t) => t.id === wantedTranscript);
      if (holders.length === 0) {
        throw new MissingRecordError(`No transcript with id ${JSON.stringify(wantedTranscript)}`);
      }
      if (holders.length > 1) {
        throw new ValidationError(
          `transcript id ${JSON.stringify(wantedTranscript)} is held by several engagements; a source read needs one scope`,
        );
      }
      const transcript = holders[0];
      const meeting = this.findMeeting(snapshot, transcript.meetingId);
      const source = transcript.sources.find((s) => s.id === wantedSource);
      if (source === undefined) {
        throw new MissingRecordError(
          `No source ${JSON.stringify(wantedSource)} in transcript ${JSON.stringify(wantedTranscript)}`,
        );
      }
      const { bytes, sha256 } = await this.readOriginal(source);
      const passages = deepFreeze(clone(source.passages.map((passage) => validatePassage(passage))));
      const read: TranscriptSourceRead = {
        transcriptId: transcript.id,
        engagementId: meeting.engagementId,
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
   * identity and stored length, or the read fails as a persistence failure and
   * nothing is repaired.
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

/** The supported format named by a filename, in any case, or "unsupported". */
function fileFormat(filename: string): ImportFormat | "unsupported" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md")) return "markdown";
  return "unsupported";
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

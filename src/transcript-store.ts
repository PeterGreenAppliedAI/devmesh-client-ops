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
 *   equivalence is the engagement plus that case-sensitive canonical text,
 *   whatever format an original came in.
 * - A new canonical content creates a meeting (with a supplied title and a
 *   validated date) or attaches once to a supplied notes-only meeting, keeping
 *   that meeting's metadata (its notes included when it has any).
 * - A content the engagement already holds reuses its canonical meeting,
 *   archived matches included, and preserves the stored metadata and project;
 *   every supplied difference (title, date, project or explicitly supplied
 *   notes) is reported as a conflict and is never written.
 * - A repeat aimed at another meeting leaves that target unchanged and returns
 *   the canonical meeting with an explanation.
 * - Different content aimed at a meeting that already holds an attachment is
 *   refused before anything is written: an attachment is never replaced.
 * - A new content for any other supplied meeting becomes that meeting's own
 *   transcript, in its own engagement, once.
 * - Each distinct original (bytes) is retained with its own extracted text and
 *   mappings, and each stored source id is derived from the canonical content,
 *   the original's bytes and the original's kind, so a paste and a file with the
 *   same bytes are distinct originals. An exact repeat of a stored original
 *   reuses its stored source id and first filename: it attaches nothing, records
 *   no activity, and is persisted through the ordinary no-op save path.
 *
 * Durability and failure rules:
 *
 * - Every import is one admission to the workspace store's own mutation queue,
 *   so its argument, parent and lifecycle validation, its blob publication and
 *   its JSON commit are serialized with every ordinary store operation; inside
 *   its turn it commits directly and never enqueues again, and a meeting id is
 *   allocated from the draft that is actually persisted. An import accepted
 *   before `close` finishes and commits while close waits for the queue, exactly
 *   like an ordinary mutation close drains; a call after close is refused.
 * - The complete proposed metadata is validated before any blob is published,
 *   so a validation failure writes nothing at all, blobs included.
 * - Original files are published and verified before the JSON that names them
 *   is committed; on a persistence failure no new memory or success result is
 *   published, and the published blobs stay in place (unreferenced originals are
 *   retained, never collected). A failed commit exposes no new source ids; a
 *   retry or a reopen verifies and reuses the retained blobs.
 * - Meeting create (for creation), attachment or a new original (one edit) or a
 *   fresh transcript that attaches once (one edit) are recorded as one activity
 *   event together with the metadata and counters.
 * - Source reads require committed metadata and verified originals, return
 *   detached values and never expose a path into the hash repository. A missing
 *   or corrupt original fails the read without any repair, and the other
 *   records stay usable.
 *
 * Error classes follow the store's: a missing record is `MissingRecordError`,
 * invalid arguments, parents, lifecycle or content are `ValidationError`, a
 * parser refusal is classified (`parser_refused`, keeping the adapter's code
 * and guidance), and storage or integrity failures are `PersistenceError`.
 */
import { createHash } from "node:crypto";
import {
  canonicalize,
  canonicalIdentityOf,
  importFileBytes,
  importPastedText,
  isWellFormedUnicode,
  MAX_CONTENT_BYTES,
  SUPPORTED_EXPORTS,
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
  type Snapshot,
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
  /** New content given its own transcript on the supplied meeting. */
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
  readSource(
    transcriptId: unknown,
    sourceId: unknown,
    engagementId?: unknown,
  ): Promise<TranscriptSourceRead>;
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

/** The accepted result of a successful import outcome. */
function importedResult(outcome: ImportOutcome): ImportResult {
  if (!outcome.ok) throw new ValidationError("unreachable: a refused import has no result");
  return (outcome as { ok: true; result: ImportResult }).result;
}

/** The source id for an original of a transcript: the canonical content and its distinct bytes. */
function sourceIdFor(canonicalText: string, originalSha256: string): string {
  const canonical = canonicalIdentityOf(canonicalText);
  return `${canonical.slice("sha256:".length)}.${originalSha256}`;
}

/** The parsed import a call carries, before anything is written. */
interface PreparedImport {
  readonly result: ImportResult;
  /** True when the original is a file's bytes, published to the hash store. */
  readonly file: boolean;
  /** The original's exact text when it is a paste, otherwise undefined. */
  readonly pastedText: string | undefined;
  /** The exact bytes of the original. */
  readonly originalBytes: Uint8Array;
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
  originalFiles(): OriginalStore;
  /** The failure that refuses a write on a store whose state is not committed. */
  writeBlock(): PersistenceError | null;
}

/** The supplied meeting create, normalized after validation. */
interface NormalizedCreate {
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId: string | undefined;
  readonly title: string;
  readonly date: string;
  readonly notes: string;
}

/** What a commit resolves with, before the committed records are looked up. */
interface CommittedOutcome {
  readonly outcome: "created" | "attached" | "reused" | "new_source" | "new_transcript";
  /** The engagement that authoritatively holds the transcript. */
  readonly engagementId: string;
  readonly meetingId: string;
  readonly createdMeeting: boolean;
  readonly attachedOriginal: boolean;
  readonly conflicts: TranscriptConflict[];
  /** True when nothing was written: an exact repeat or a read-like outcome. */
  readonly noop: boolean;
  readonly explanationCode?: TranscriptExplanation["code"];
  /** The supplied target meeting, for a result aimed at another meeting. */
  readonly wantedMeetingId?: string;
}

/** The content the engagement already holds, if any. */
interface CanonicalMatch {
  readonly meeting: Meeting;
  readonly transcript: Transcript;
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

  /** The failure that refuses an accepted import's write when it is blocked. */
  private writeBlock(): PersistenceError | null {
    return this.internals().writeBlock();
  }

  /**
   * Import exactly one raw paste or file. The whole import (its argument and
   * parent validation, the complete metadata validation, the blob publication
   * and the JSON commit) is the one admission to the workspace store's own
   * mutation queue and commits inside that turn, so it is serialized with every
   * ordinary store operation: the association is allocated from the id actually
   * committed, and an intervening store write cannot move it. Close drains an
   * accepted import before releasing ownership, and refuses later calls. A
   * malformed call, a parser refusal or an invalid parent writes nothing.
   */
  importTranscript(input: TranscriptInput, target: TranscriptTarget): Promise<TranscriptImportResult> {
    return this.exclusive(async () => {
      // Admission was decided when this import entered the store's queue: an
      // import accepted before close keeps running while close drains the queue.
      // A store that became blocked may not build on uncommitted state.
      const blocked = this.writeBlock();
      if (blocked !== null) throw blocked;
      // The arguments are checked before any read or write, so a malformed
      // call writes nothing at all.
      const parsed = this.parseTarget(target);
      const prepared = await this.prepare(input);
      const snapshot = this.store.snapshot();
      const committed =
        parsed.create !== undefined
          ? this.planCreate(prepared, parsed.create, snapshot)
          : this.planTarget(prepared, parsed.meetingId!, snapshot);
      return this.commit(prepared, committed);
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
    // The adapters classify an unsupported extension (`unsupported_format`) and
    // an oversized original (`too_large`) as content refusals, not argument
    // errors; the import keeps that classification and writes nothing.
    const format = fileFormat(filename);
    if (format === "unsupported") throw unsupportedFormat(filename);
    if (bytes.length > MAX_TRANSCRIPT_BYTES) throw tooLarge("original", bytes.length);
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
    const pastedText = file ? undefined : result.originalText;
    return {
      result,
      file,
      pastedText,
      originalBytes: pastedText === undefined ? new Uint8Array(result.originalBytes) : new Uint8Array(
        new TextEncoder().encode(pastedText),
      ),
    };
  }

  /** Validate the target: exactly one of a meeting create or a meeting id. */
  private parseTarget(
    target: TranscriptTarget,
  ): { create?: TranscriptMeetingCreate; meetingId?: string } {
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
      return { create };
    }
    const meetingId = requireNonblank(record.meetingId, "transcript target.meetingId");
    return { meetingId };
  }

  /**
   * Normalize and validate a supplied meeting create against the store's
   * hierarchy before anything is written: the meeting's own fields (title,
   * date, notes) are validated as a meeting, then its client, engagement and
   * project links form one valid chain. A missing record is `MissingRecordError`,
   * a mismatched link is `ValidationError`.
   */
  private requireCreateParents(snapshot: Snapshot, create: TranscriptMeetingCreate): NormalizedCreate {
    const clientId = create.clientId as string;
    const engagementId = create.engagementId as string;
    const projectId = optionalNonblank(create.projectId, "transcript target.create.projectId");
    const notes = create.notes === undefined ? "" : (create.notes as string);
    const meeting = parseMeeting({
      id: "meeting-1",
      clientId,
      engagementId,
      ...(projectId === undefined ? {} : { projectId }),
      title: create.title,
      date: create.date,
      notes,
    });
    const client = snapshot.clients.find((c) => c.id === clientId);
    if (client === undefined) throw new MissingRecordError(`No client with id ${JSON.stringify(clientId)}`);
    const engagement = snapshot.engagements.find((e) => e.id === engagementId);
    if (engagement === undefined) throw new MissingRecordError(`No engagement with id ${JSON.stringify(engagementId)}`);
    if (engagement.clientId !== clientId) {
      throw new ValidationError(
        `engagementId ${JSON.stringify(engagementId)} does not belong to clientId ${JSON.stringify(clientId)}`,
      );
    }
    if (projectId !== undefined) {
      const project = snapshot.projects.find((p) => p.id === projectId);
      if (project === undefined) throw new MissingRecordError(`No project with id ${JSON.stringify(projectId)}`);
      if (project.engagementId !== engagementId) {
        throw new ValidationError(
          `projectId ${JSON.stringify(projectId)} does not belong to engagementId ${JSON.stringify(engagementId)}`,
        );
      }
    }
    return { clientId, engagementId, projectId, title: meeting.title, date: meeting.date, notes: meeting.notes };
  }

  /**
   * The meeting with the given id whose authoritative parent chain is valid, or
   * a classified refusal: a missing meeting is `MissingRecordError`, an invalid
   * ancestry is `ValidationError`.
   */
  private findMeeting(snapshot: Snapshot, meetingId: string): Meeting {
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
   * The meeting and transcript that authoritatively hold the canonical content
   * in an engagement, or undefined. The engagement is resolved through the
   * meeting's own valid parent chain, so a caller's scope is never trusted and
   * an identical transcript in another engagement is never mistaken for this one.
   */
  private canonicalFor(snapshot: Snapshot, engagementId: string, canonicalText: string): CanonicalMatch | undefined {
    for (const transcript of snapshot.transcripts ?? []) {
      if (transcript.canonicalText !== canonicalText) continue;
      const holder = snapshot.meetings.find((m) => m.id === transcript.meetingId);
      if (holder !== undefined && holder.engagementId === engagementId) {
        return { meeting: holder, transcript };
      }
    }
    return undefined;
  }

  /** The transcript held by exactly this meeting, or undefined. */
  private transcriptOf(snapshot: Snapshot, meetingId: string): Transcript | undefined {
    return (snapshot.transcripts ?? []).find((transcript) => transcript.meetingId === meetingId);
  }

  /**
   * Whether the canonical meeting's engagement or client is archived. Archived
   * canonical meetings are reused like active ones, and the result says so.
   */
  private isArchived(snapshot: Snapshot, meeting: Meeting): boolean {
    const engagement = snapshot.engagements.find((e) => e.id === meeting.engagementId);
    const client = snapshot.clients.find((c) => c.id === meeting.clientId);
    return engagement?.archived === true || client?.archived === true;
  }

  /**
   * The stored source of the transcript whose original is exactly this import's
   * original, or undefined. A file original is matched by its exact bytes' hash,
   * a paste by its exact text; the same text pasted and saved as a `.txt` file
   * are distinct originals, each retained with its own id.
   */
  private existingSource(transcript: Transcript, prepared: PreparedImport): TranscriptSource | undefined {
    const wantedSha256 = sha256Hex(prepared.originalBytes);
    const wantedText = prepared.pastedText;
    return transcript.sources.find((source) =>
      source.format === "paste"
        ? wantedText !== undefined && source.originalText === wantedText
        : wantedText === undefined && source.originalSha256 === wantedSha256,
    );
  }

  /**
   * The stored source for a new original of a transcript, keeping the adapter's
   * extracted text and passage mappings under a source identity derived from the
   * canonical content and the original's exact bytes.
   */
  private newSource(prepared: PreparedImport): TranscriptSource {
    const result = prepared.result;
    const id = sourceIdFor(result.canonicalText, `${prepared.file ? "file" : "paste"}.${result.originalSha256}`);
    const passages: readonly Passage[] = result.passages.map((passage) => ({
      ...passage,
      sourceId: id,
    }));
    if (prepared.pastedText !== undefined) {
      return {
        id,
        format: "paste",
        filename: result.filename,
        originalText: prepared.pastedText,
        extractedText: result.extractedText,
        passages,
      };
    }
    return {
      id,
      format: result.format,
      filename: result.filename,
      originalSha256: result.originalSha256,
      originalLength: prepared.originalBytes.length,
      extractedText: result.extractedText,
      passages,
    };
  }

  /** The stored source list as it will be committed after adding `source`. */
  private proposedSources(transcript: Transcript, source: TranscriptSource): TranscriptSource[] {
    return [...transcript.sources, source];
  }

  /**
   * Validate the complete metadata a commit would produce before anything is
   * published: a fresh transcript must be accepted exactly as reopening would
   * accept it, and a transcript gaining an original must stay one canonical
   * transcript. A validation failure writes nothing.
   */
  private validateProposal(
    snapshot: Snapshot,
    meeting: Meeting,
    transcript: { id: string; canonicalText: string; meetingId: string; sources: readonly TranscriptSource[] },
  ): void {
    validateTranscripts([transcript], { ...snapshot, meetings: [...snapshot.meetings, meeting] } as Snapshot);
  }

  /**
   * The supplied differences from the preserved meeting, reported as conflicts
   * and never written. A supplied title, date, project or notes that differs
   * from the preserved value is reported, including an explicitly supplied
   * blank notes (`""`) that differs from preserved notes; notes that were not
   * supplied at all are not a difference.
   */
  private conflicts(create: TranscriptMeetingCreate, meeting: Meeting): TranscriptConflict[] {
    const conflicts: TranscriptConflict[] = [];
    const title = create.title as string;
    if (title !== meeting.title) {
      conflicts.push({ field: "title", supplied: title, preserved: meeting.title });
    }
    const date = create.date as string;
    if (date !== meeting.date) {
      conflicts.push({ field: "date", supplied: date, preserved: meeting.date });
    }
    // An omitted project is not a supplied one: only a project the caller
    // actually supplied and that differs from the preserved project is a
    // difference.
    const projectId = create.projectId as string | undefined;
    if (projectId !== undefined && projectId !== meeting.projectId) {
      conflicts.push({ field: "projectId", supplied: projectId, preserved: meeting.projectId ?? "" });
    }
    if (create.notes !== undefined && create.notes !== meeting.notes) {
      conflicts.push({ field: "notes", supplied: create.notes as string, preserved: meeting.notes });
    }
    return conflicts;
  }

  /**
   * Plan an import whose target is a meeting create. The create is validated as
   * a meeting with valid parents; content the engagement already holds reuses
   * its canonical meeting (archived included) instead of creating a second one,
   * and its supplied differences are reported. Any other content creates one
   * meeting and its transcript with the supplied metadata.
   */
  private planCreate(
    prepared: PreparedImport,
    create: TranscriptMeetingCreate,
    snapshot: Snapshot,
  ): CommitPlan {
    const normalized = this.requireCreateParents(snapshot, create);
    const canonical = this.canonicalFor(snapshot, normalized.engagementId, prepared.result.canonicalText);
    if (canonical !== undefined) {
      return this.planReuse(prepared, canonical, this.conflicts(create, canonical.meeting));
    }
    // The proposed metadata, transcript and source are all validated before the
    // blob is published.
    const meeting = parseMeeting({
      id: "meeting-1",
      clientId: normalized.clientId,
      engagementId: normalized.engagementId,
      ...(normalized.projectId === undefined ? {} : { projectId: normalized.projectId }),
      title: normalized.title,
      date: normalized.date,
      notes: normalized.notes,
    });
    const transcript = {
      id: prepared.result.id,
      canonicalText: prepared.result.canonicalText,
      meetingId: meeting.id,
      sources: [this.newSource(prepared)],
    };
    this.validateProposal(snapshot, meeting, transcript);
    return {
      outcome: "created",
      engagementId: normalized.engagementId,
      meetingId: "", // allocated from the committed draft
      createdMeeting: true,
      write: "create",
      meeting: { ...meeting, id: "", clientId: normalized.clientId, engagementId: normalized.engagementId },
      transcript,
      conflicts: [],
      attachedOriginal: true,
    };
  }

  /**
   * Plan an import whose target is a supplied meeting. The meeting and its
   * ancestry are validated first. Content the engagement already holds reuses
   * its canonical meeting and leaves the target unchanged. Otherwise the target
   * accepts its first attachment once, keeping its metadata (its notes
   * included), when it holds no transcript; a meeting that holds a transcript
   * already is refused before anything is written, because an attachment is
   * never replaced and different content never becomes a second transcript.
   */
  private planTarget(prepared: PreparedImport, meetingId: string, snapshot: Snapshot): CommitPlan {
    const target = this.findMeeting(snapshot, meetingId);
    const canonical = this.canonicalFor(snapshot, target.engagementId, prepared.result.canonicalText);
    if (canonical !== undefined) {
      return this.planReuse(prepared, canonical, [], target.id);
    }
    if (this.transcriptOf(snapshot, target.id) !== undefined) {
      // The target already holds an attachment and this content is different:
      // an attachment is never replaced, and nothing of the target changes.
      throw new ValidationError(
        `meeting ${JSON.stringify(target.id)} already holds a transcript of different content; ` +
          "an attachment is never replaced and a different original cannot be added to it",
      );
    }
    // A meeting without a transcript receives its first attachment, keeping its
    // metadata (its notes included when it has any).
    const transcript = {
      id: prepared.result.id,
      canonicalText: prepared.result.canonicalText,
      meetingId: target.id,
      sources: [this.newSource(prepared)],
    };
    this.validateProposal(snapshot, target, transcript);
    return {
      outcome: "attached",
      engagementId: target.engagementId,
      meetingId: target.id,
      createdMeeting: false,
      write: "attach",
      meeting: null,
      transcript,
      conflicts: [],
      attachedOriginal: true,
    };
  }

  /**
   * Plan reusing the engagement's canonical meeting for this content. An exact
   * repeat of a stored original is a no-op through the store's own persistence
   * path: it saves the committed state exactly as before, records no event and
   * adds nothing. A distinct original is published and attached with one edit.
   * The canonical meeting, its metadata and project are preserved either way.
   */
  private planReuse(
    prepared: PreparedImport,
    canonical: CanonicalMatch,
    conflicts: readonly TranscriptConflict[],
    wantedMeetingId?: string,
  ): CommitPlan {
    const { meeting, transcript } = canonical;
    const base = {
      engagementId: meeting.engagementId,
      meetingId: meeting.id,
      createdMeeting: false,
      conflicts: [...conflicts],
      wantedMeetingId,
    };
    if (this.existingSource(transcript, prepared) !== undefined) {
      return {
        ...base,
        outcome: "reused",
        write: "noop",
        meeting: null,
        transcript: null,
        attachedOriginal: false,
      };
    }
    const proposed = {
      id: transcript.id,
      canonicalText: transcript.canonicalText,
      meetingId: meeting.id,
      sources: this.proposedSources(transcript, this.newSource(prepared)),
    };
    this.validateProposal(this.store.snapshot(), meeting, proposed);
    return {
      ...base,
      outcome: "new_source",
      write: "edit",
      meeting: null,
      transcript: proposed,
      attachedOriginal: true,
    };
  }

  /**
   * Carry out a planned import: publish the blob (for a file original that is
   * not already stored), then run the one metadata commit (or the no-op save)
   * and look the committed records up. Nothing is published as memory before
   * the whole commit succeeds.
   */
  private async commit(prepared: PreparedImport, plan: CommitPlan): Promise<TranscriptImportResult> {
    if (plan.write !== "noop") await this.publish(prepared);
    if (plan.write === "noop") {
      await this.noop();
    } else if (plan.write === "create") {
      await this.writeCreate(prepared, plan);
    } else {
      await this.writeEdit(prepared, plan);
    }
    return this.result(plan);
  }

  /** Publish the prepared file original before the JSON that names it. */
  private async publish(prepared: PreparedImport): Promise<void> {
    if (!prepared.file) return;
    let reference: { sha256: string; byteLength: number };
    try {
      reference = await this.originals.put(prepared.originalBytes);
    } catch (cause) {
      throw new PersistenceError("Failed to publish the transcript original", { cause });
    }
    if (
      reference.sha256 !== sha256Hex(prepared.originalBytes) ||
      reference.byteLength !== prepared.originalBytes.length
    ) {
      throw new PersistenceError(
        "The published transcript original does not verify against its stored hash",
      );
    }
  }

  /**
   * Create one meeting, its transcript and one create event in a single write.
   * The meeting id is allocated from the draft that is actually persisted, so
   * the meeting, its transcript's association and its event all name that id.
   */
  private async writeCreate(prepared: PreparedImport, plan: CommitPlan): Promise<void> {
    const meeting = plan.meeting!;
    const transcript = plan.transcript!;
    await this.internals().commitTranscripts((draft) => {
      const id = this.internals().nextId(draft, "meetings");
      const created = parseMeeting({ ...meeting, id });
      draft.meetings.push(created);
      draft.transcripts.push({ ...transcript, id: prepared.result.id, meetingId: id });
      plan.meetingId = id;
      return { value: undefined, event: { action: "create", targetKind: "meeting", targetId: id } };
    });
  }

  /**
   * Commit one edit: a fresh transcript that attaches once to the supplied
   * meeting, or a new original added to the canonical transcript. The draft is
   * re-checked inside the serialized write: the target must still hold no
   * transcript of its own, and the engagement must still not hold this content
   * elsewhere.
   */
  private async writeEdit(prepared: PreparedImport, plan: CommitPlan): Promise<void> {
    const proposed = plan.transcript!;
    await this.internals().commitTranscripts((draft) => {
      const meeting = draft.meetings.find((m) => m.id === plan.meetingId);
      if (meeting === undefined) throw new MissingRecordError(`No meeting with id ${JSON.stringify(plan.meetingId)}`);
      const current = draft.transcripts.find((t) => t.meetingId === meeting.id);
      if (current === undefined) {
        const clash = draft.transcripts.some(
          (t) =>
            t.canonicalText === proposed.canonicalText &&
            draft.meetings.some((m) => m.id === t.meetingId && m.engagementId === meeting.engagementId),
        );
        if (clash) {
          throw new ValidationError(
            `engagement ${JSON.stringify(meeting.engagementId)} already holds this canonical transcript`,
          );
        }
        draft.transcripts.push(proposed);
      } else {
        if (current.id !== proposed.id) {
          throw new ValidationError(
            `meeting ${JSON.stringify(meeting.id)} holds transcript ${JSON.stringify(current.id)}, not ` +
              JSON.stringify(proposed.id),
          );
        }
        draft.transcripts[draft.transcripts.indexOf(current)] = { ...current, sources: proposed.sources };
      }
      return { value: undefined, event: { action: "edit", targetKind: "meeting", targetId: meeting.id } };
    });
  }

  /**
   * Persist an exact repeat through the ordinary no-op path: the commit's draft
   * is unchanged, so the store validates the committed state, saves it exactly
   * as before and records no event. A save failure rejects exactly as for any
   * other write and adds nothing.
   */
  private async noop(): Promise<void> {
    await this.internals().commitTranscripts(() => ({ value: undefined }));
  }

  /**
   * Resolve a committed plan into the public result, looking the records up in
   * the committed snapshot scoped by their authoritative meeting and explaining
   * any outcome that did not write to the supplied target.
   */
  private result(plan: CommitPlan): TranscriptImportResult {
    const snapshot = this.store.snapshot();
    const meeting = snapshot.meetings.find((m) => m.id === plan.meetingId);
    if (meeting === undefined) {
      throw new PersistenceError(`the committed meeting ${JSON.stringify(plan.meetingId)} is missing`);
    }
    if (meeting.engagementId !== plan.engagementId) {
      throw new PersistenceError(`the committed meeting ${JSON.stringify(meeting.id)} is not in the planned engagement`);
    }
    const transcript = this.transcriptOf(snapshot, meeting.id);
    if (transcript === undefined) {
      throw new PersistenceError(`the committed meeting ${JSON.stringify(meeting.id)} holds no transcript`);
    }
    const aimedElsewhere = plan.wantedMeetingId !== undefined && plan.wantedMeetingId !== meeting.id;
    const archived = plan.outcome === "reused" || plan.outcome === "new_source"
      ? this.isArchived(snapshot, meeting)
      : false;
    const explanation = this.explain(plan, meeting, aimedElsewhere, archived);
    return deepFreeze({
      outcome: plan.outcome,
      meeting,
      transcript,
      ...(aimedElsewhere ? { canonicalMeetingId: meeting.id } : {}),
      sourceIds: transcript.sources.map((source) => source.id),
      createdMeeting: plan.createdMeeting,
      attachedOriginal: plan.attachedOriginal,
      conflicts: plan.conflicts,
      ...(explanation === undefined ? {} : { explanation }),
    });
  }

  /** The explanation a committed outcome carries, when it has one. */
  private explain(
    plan: CommitPlan,
    meeting: Meeting,
    aimedElsewhere: boolean,
    archived: boolean,
  ): TranscriptExplanation | undefined {
    if (aimedElsewhere) {
      return {
        code: "other_meeting",
        message:
          `The target meeting ${JSON.stringify(plan.wantedMeetingId)} was left unchanged; ` +
          `the canonical meeting is ${JSON.stringify(meeting.id)}.`,
      };
    }
    if (plan.outcome === "reused" || plan.outcome === "new_source") {
      const held = archived
        ? "The engagement already holds this canonical content on an archived meeting; that meeting is reused and stays archived."
        : "The engagement already holds this canonical content; its canonical meeting is reused.";
      const code = archived ? "archived_canonical" : plan.outcome === "reused" ? "exact_repeat" : "new_original";
      if (plan.outcome === "reused") {
        return {
          code,
          message: `${held} This exact original is already stored and was reused; nothing was written.`,
        };
      }
      return {
        code,
        message: `${held} A distinct original was retained with its own text and mappings.`,
      };
    }
    if (plan.write === "attach") {
      return {
        code: "attached_notes_only",
        message: "The new transcript was attached once to the notes-only meeting; its metadata is kept.",
      };
    }
    return undefined;
  }

  /**
   * Read one committed source. The metadata must be committed and validated
   * (reopening refuses anything else, and this store validates it too); the
   * original must verify against its stored hash or exact text, or the read
   * fails without any repair. The result holds detached values only: never a
   * path, handle or the store's buffers. A canonical transcript id is unique
   * within an engagement but may name a transcript in each of several
   * engagements, so the read resolves the id against the meetings' authoritative
   * parents: a supplied `engagementId` scopes it, and without one the read is
   * refused as ambiguous when several engagements hold the id.
   */
  readSource(
    transcriptId: unknown,
    sourceId: unknown,
    engagementId?: unknown,
  ): Promise<TranscriptSourceRead> {
    return this.exclusive(async () => {
      // Admission was decided when this read entered the store's queue; a store
      // that became blocked refuses the read like any other write-side check.
      const blocked = this.writeBlock();
      if (blocked !== null) throw blocked;
      const wantedTranscript = requireNonblank(transcriptId, "transcriptId");
      const wantedSource = requireNonblank(sourceId, "sourceId");
      const wantedEngagement =
        engagementId === undefined ? undefined : requireNonblank(engagementId, "engagementId");
      const snapshot = this.store.snapshot();
      const holders = (snapshot.transcripts ?? []).flatMap((transcript) => {
        const meeting = snapshot.meetings.find((m) => m.id === transcript.meetingId);
        if (meeting === undefined || transcript.id !== wantedTranscript) return [];
        if (wantedEngagement !== undefined && meeting.engagementId !== wantedEngagement) return [];
        return [{ transcript, meeting }];
      });
      if (holders.length === 0) {
        throw new MissingRecordError(`No transcript with id ${JSON.stringify(wantedTranscript)}`);
      }
      if (holders.length > 1) {
        throw new ValidationError(
          `transcript id ${JSON.stringify(wantedTranscript)} is held by several engagements; a source read needs one scope`,
        );
      }
      const { transcript, meeting } = holders[0];
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
    return { bytes: new Uint8Array(reference.bytes), sha256: source.originalSha256 };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

/** A validated plan for one import, before its blob and JSON are committed. */
interface CommitPlan {
  readonly outcome: CommittedOutcome["outcome"];
  readonly engagementId: string;
  /** The meeting the import commits to (allocated for a create at write time). */
  meetingId: string;
  readonly createdMeeting: boolean;
  /** What the commit does: a no-op save, a create, or one edit. */
  readonly write: "noop" | "create" | "attach" | "edit";
  /** The meeting to create (a create only), with an id to be allocated. */
  readonly meeting: Meeting | null;
  /** The whole transcript as it will be committed, or null for a no-op. */
  readonly transcript: Transcript | null;
  readonly conflicts: TranscriptConflict[];
  readonly attachedOriginal: boolean;
  /** The supplied target meeting, when the import was aimed at one. */
  readonly wantedMeetingId?: string;
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

/**
 * A classified parser refusal as a `ValidationError`: `parser_refused` with the
 * adapter's own refusal code and guidance, exactly like a refusal the adapters
 * return.
 */
function refusedImport(code: string, message: string): ValidationError {
  const error = new ValidationError(`transcript_refused: ${message}`);
  const refusal = Object.freeze({ code, message, supportedExports: SUPPORTED_EXPORTS });
  (error as ValidationError & { code?: string; refusal?: unknown }).code = "parser_refused";
  (error as ValidationError & { code?: string; refusal?: unknown }).refusal = refusal;
  return error;
}

/** The refusal for a filename whose extension names no supported format. */
function unsupportedFormat(filename: string): ValidationError {
  return refusedImport(
    "unsupported_format",
    `The file ${JSON.stringify(filename)} is not a supported format; import pasted text, or a UTF-8 .txt or .md file.`,
  );
}

/** The refusal for content that exceeds the inclusive byte limit. */
function tooLarge(what: string, length: number): ValidationError {
  return refusedImport(
    "too_large",
    `The ${what} content is ${length} bytes; it must be at most ${MAX_TRANSCRIPT_BYTES} bytes. Nothing was truncated.`,
  );
}

/** Require the import's text to be well-formed Unicode within the limit. */
function requireWellFormed(result: ImportResult): void {
  if (canonicalize(result.extractedText) !== result.canonicalText) {
    throw new ValidationError("the import's canonical text is not its extracted text's canonical content");
  }
  for (const [what, text] of [
    ["originalText", result.originalText],
    ["extractedText", result.extractedText],
  ] as const) {
    if (!isWellFormedUnicode(text)) {
      throw new ValidationError(`the import's ${what} is not well-formed Unicode`);
    }
    if (utf8Length(text) > MAX_TRANSCRIPT_BYTES) {
      throw tooLarge(what, utf8Length(text));
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

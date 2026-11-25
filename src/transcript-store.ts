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
 *   every supplied difference (title, date, project — an explicit blank
 *   engagement-only selection included — or explicitly supplied notes) is
 *   reported as a conflict and is never written.
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
 *   like an ordinary mutation close drains; a call admitted after close is
 *   refused. The submission handler hands the service one resolver that reads
 *   the URL record and checks the submitted assertions; the service admits the
 *   whole submission as one queue turn, runs the resolver against the committed
 *   state at admission and again at the start of the turn, and commits the
 *   import inside that turn without enqueuing again.
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
import { isEffectivelyArchived } from "./archive.ts";
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
  | "new_source";

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
    | "exact_repeat";
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
export interface TranscriptStoreOptions extends StoreOptions, TranscriptServiceOptions {}

/**
 * Options accepted by `transcriptService`: only the adapters that a borrowed
 * service needs, since the workspace store it borrows is already open and its
 * filesystem, clock, originals and lock are the open store's own.
 */
export interface TranscriptServiceOptions {
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
  /**
   * Handle one submission (see `transcript-import.ts`) as one admission to the
   * workspace store's own queue: the resolver reads the URL record and checks
   * the submitted assertions inside that turn, and the import commits there.
   */
  submitImport(resolve: SubmissionResolver): Promise<TranscriptImportResult>;
  /** Read one committed source with its verified original and detached values. */
  readSource(
    transcriptId: unknown,
    sourceId: unknown,
    engagementId?: unknown,
  ): Promise<TranscriptSourceRead>;
  /** Detached, read-only committed transcript metadata. */
  transcripts(): readonly Transcript[];
  /**
   * Release this service's ownership of the workspace. A service built by
   * `openTranscriptStore` owns the store it opened and closes it; a service
   * built by `transcriptService` borrows an already-open store and leaves it
   * open, so the caller keeps the store and closes it (`close` is then a no-op).
   */
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

/** The mutable workspace draft a commit is applied to: the committed state. */
interface DraftState extends Snapshot {
  meetings: Meeting[];
  transcripts: Transcript[];
}

/** The store's internal transcript commit, over the committed state. */
interface CommitStore {
  /** Allocate the next id of a collection from the draft that is persisted. */
  nextId(draft: DraftState, key: "meetings"): string;
  /**
   * Apply one mutation to a draft of the committed state, validate the
   * resulting transcripts exactly as reopening would, persist the draft and
   * record the mutation's one event, if any. This never enqueues: it is called
   * inside the turn `runExclusive` admitted, so the whole import commits with
   * that one admission and no further turn waits behind it.
   */
  commitTranscripts(
    mutate: (draft: DraftState) => {
      value: unknown;
      event?: { action: "create" | "edit"; targetKind: "meeting"; targetId: string };
    },
  ): Promise<unknown>;
  originalFiles(): OriginalStore;
  /** The failure that refuses a write on a store whose state is not committed. */
  writeBlock(): PersistenceError | null;
  /**
   * The store's own queue admission: it decides acceptance now and runs the
   * operation later. A store that has been closed or blocked is refused at
   * admission, so a submission that is admitted before close is still admitted
   * after it.
   */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * The submission handler's resolution of one submission against the committed
 * state: it reads the URL record and the submitted assertions from the
 * snapshot it is given and returns the one raw import and validated target the
 * import commits. It is run inside the service's queue turn, once with the
 * committed state at admission and again at the start of the turn, so the
 * assertions and the import are checked against the records the import is
 * applied to.
 */
export type SubmissionResolver = (snapshot: Snapshot) => SubmissionImport;

/** What a submission resolver returns: one raw import, its target, and the private blank selection. */
export interface SubmissionImport {
  readonly input: TranscriptInput;
  readonly target: TranscriptTarget;
  /** True when the submission explicitly left the project blank (engagement only). */
  readonly engagementOnly?: boolean;
}

/**
 * The shape-checked import request an import operation runs: the submission
 * resolver's result, validated before any read or write. The explicit blank
 * selection travels privately here, never through the public `TranscriptTarget`
 * parser.
 */
interface SubmissionImportRequest {
  readonly input: TranscriptInput;
  readonly target: TranscriptTarget;
  readonly engagementOnly?: boolean;
}

/**
 * Shape-check a resolver's result for the import operation: exactly one input
 * and one target, and the private blank marker only when it is true. Only the
 * submission's own resolver produces these, so the marker is never a
 * caller-supplied control.
 */
function importRequest(submission: SubmissionImport): SubmissionImportRequest {
  const shape = requireRecord(submission, "transcript submission import", [
    "input",
    "target",
    "engagementOnly",
  ] as const);
  if (shape.engagementOnly !== undefined && shape.engagementOnly !== true) {
    throw new ValidationError("transcript submission import.engagementOnly must be true when present");
  }
  return submission as SubmissionImportRequest;
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
  readonly outcome: "created" | "attached" | "reused" | "new_source";
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
  /** Whether this service owns the store it was built over and closes it. */
  private readonly ownsStore: boolean;

  constructor(
    store: Store,
    originals: OriginalStore,
    docxParser: DocxParser | undefined,
    pdfParser: PdfParser | undefined,
    ownsStore: boolean,
  ) {
    this.store = store;
    this.originals = originals;
    this.docxParser = docxParser;
    this.pdfParser = pdfParser;
    this.ownsStore = ownsStore;
  }

  transcripts(): readonly Transcript[] {
    return deepFreeze(clone(this.store.snapshot().transcripts ?? []));
  }

  /** Run an operation inside the workspace store's own mutation queue. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.internals().runExclusive(operation);
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
    // The public target parser accepts only the supplied create keys; a direct
    // import therefore never carries the handler's private blank marker.
    return this.exclusive(() => this.importResolved(() => ({ input, target })));
  }

  /**
   * Handle one submission as one admission to the store's own mutation queue.
   * The service's resolver reads the URL record and checks the submitted
   * assertions against the committed state, so URL resolution, assertion
   * checks and the import's commit are all admitted together by the store: a
   * store closed or blocked before admission is refused, and an assertion that
   * held at admission is re-checked at the start of the turn against every
   * write queued before it. The import commits inside that turn and never
   * enqueues again, since a turn awaiting its own admission would leave the
   * queue unsettled. A malformed resolver writes nothing and enters no queue.
   */
  submitImport(resolve: SubmissionResolver): Promise<TranscriptImportResult> {
    if (typeof resolve !== "function") {
      throw new ValidationError("a transcript submission needs a resolver function");
    }
    // The submission is resolved against the committed state when admission is
    // decided, so a refused submission never enters the queue; the resolver is
    // run again inside the turn, where it sees every write queued before it.
    return this.exclusive(() => this.importResolved(resolve));
  }

  /**
   * The import itself, run inside the workspace store's queue turn this call was
   * admitted to (both `importTranscript` and `submitImport` admit it with the
   * store's own queue). The resolver is applied to the committed state at the
   * start of the turn, so a submission's URL record and assertion checks see
   * every write queued before it; this method then prepares, plans and commits
   * inside that turn and never enqueues again.
   */
  private importResolved(resolve: SubmissionResolver): Promise<TranscriptImportResult> {
    return (async () => {
      // Admission was decided when this import entered the store's queue: an
      // import accepted before close keeps running while close drains the queue.
      // A store that became blocked may not build on uncommitted state.
      const blocked = this.writeBlock();
      if (blocked !== null) throw blocked;
      // The resolver runs here against the committed state every queued write
      // has already updated, so the URL record and the submitted assertions are
      // checked against the records the import is applied to. A stale assertion
      // is refused before anything is read or written.
      const request = importRequest(resolve(this.store.snapshot()));
      const parsed = this.parseTarget(request.target, request.engagementOnly === true);
      const prepared = await this.prepare(request.input);
      // The complete proposal is validated against the committed state before
      // any blob is published, and the blob is published before the JSON that
      // names it. The plan is then applied to the store's own draft inside this
      // turn's single commit, which re-checks the proposal against the records
      // actually persisted and allocates the meeting id from them.
      const plan =
        parsed.create !== undefined
          ? this.planCreate(prepared, parsed.create, request.engagementOnly === true)
          : this.planTarget(prepared, parsed.meetingId!);
      if (plan.write !== "noop") await this.publish(prepared);
      await this.internals().commitTranscripts((draft) => this.commitChange(prepared, plan, draft));
      return this.result(plan);
    })();
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
    engagementOnly = false,
  ): { create?: TranscriptMeetingCreate; meetingId?: string } {
    const record = requireRecord(target, "transcript target", TARGET_KEYS);
    const hasCreate = record.create !== undefined;
    const hasMeeting = record.meetingId !== undefined;
    if (hasCreate === hasMeeting) {
      throw new ValidationError("transcript target must carry either a meeting create or a target meetingId");
    }
    if (hasCreate) {
      // The public parser accepts only the supplied create keys; the handler's
      // private engagement-only marker is carried separately, never here.
      const create = requireRecord(record.create, "transcript target.create", CREATE_KEYS);
      if (engagementOnly && create.projectId !== undefined) {
        throw new ValidationError("transcript target.create cannot carry a project and an engagement-only selection");
      }
      requireNonblank(create.clientId, "transcript target.create.clientId");
      requireNonblank(create.engagementId, "transcript target.create.engagementId");
      optionalNonblank(create.projectId, "transcript target.create.projectId");
      requireNonblank(create.title, "transcript target.create.title");
      requireNonblank(create.date, "transcript target.create.date");
      optionalText(create.notes, "transcript target.create.notes");
      return { create: create as unknown as TranscriptMeetingCreate };
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
  private canonicalFor(
    snapshot: Snapshot,
    engagementId: string,
    canonicalText: string,
  ): CanonicalMatch | undefined {
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
   * Whether the canonical meeting is effectively archived: its client, its
   * engagement or its own project carries the flag. Archived canonical meetings
   * are reused like active ones, and the result says so.
   */
  private isArchived(snapshot: Snapshot, meeting: Meeting): boolean {
    return isEffectivelyArchived(snapshot, meeting);
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
  private conflicts(
    create: TranscriptMeetingCreate,
    meeting: Meeting,
    engagementOnly = false,
  ): TranscriptConflict[] {
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
    // difference. An explicitly blank project selects the engagement only
    // (supplied as "") and differs from a preserved project like any other
    // selection; the canonical holder's project is still preserved.
    const projectId = create.projectId as string | undefined;
    const suppliedProject = engagementOnly ? "" : projectId;
    if (suppliedProject !== undefined && suppliedProject !== (meeting.projectId ?? "")) {
      conflicts.push({
        field: "projectId",
        supplied: suppliedProject,
        preserved: meeting.projectId ?? "",
      });
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
    engagementOnly = false,
  ): CommitPlan {
    const snapshot = this.store.snapshot();
    const normalized = this.requireCreateParents(snapshot, create);
    const canonical = this.canonicalFor(snapshot, normalized.engagementId, prepared.result.canonicalText);
    if (canonical !== undefined) {
      return this.planReuse(prepared, canonical, this.conflicts(create, canonical.meeting, engagementOnly));
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
    // The proposed metadata, transcript and source are validated as if the
    // meeting already existed; its id is allocated from the draft the store
    // actually persists, so the meeting, its transcript's association and its
    // event all name that id.
    this.validateProposal(snapshot, meeting, transcript);
    return {
      outcome: "created",
      engagementId: normalized.engagementId,
      meetingId: "", // allocated from the committed draft
      createdMeeting: true,
      write: "create",
      canonicalText: prepared.result.canonicalText,
      meeting: { ...meeting, id: "" },
      transcript: { ...transcript, meetingId: "" },
      event: { action: "create", targetKind: "meeting", targetId: "" },
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
  private planTarget(prepared: PreparedImport, meetingId: string): CommitPlan {
    const snapshot = this.store.snapshot();
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
    // The proposed metadata, transcript and source are validated before the
    // store saves the draft.
    this.validateProposal(snapshot, target, transcript);
    return {
      outcome: "attached",
      engagementId: target.engagementId,
      meetingId: target.id,
      createdMeeting: false,
      write: "attach",
      canonicalText: prepared.result.canonicalText,
      transcript,
      event: { action: "edit", targetKind: "meeting", targetId: target.id },
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
        attachedOriginal: false,
      };
    }
    return {
      ...base,
      outcome: "new_source",
      write: "edit",
      planTranscriptId: transcript.id,
      originalBytes: prepared.originalBytes,
      originalPastedText: prepared.pastedText,
      event: { action: "edit", targetKind: "meeting", targetId: meeting.id },
      attachedOriginal: true,
    };
  }

  /**
   * The change a plan makes to the draft that the store persists: a no-op save
   * for an exact repeat, the planned meeting and its new transcript for a create,
   * the new transcript for an attachment, or the edit that adds a distinct
   * original to the canonical transcript. The draft is re-checked inside the
   * serialized commit so a plan never commits onto state it did not plan on, and
   * the store then validates it exactly as reopening would, saves it and records
   * the plan's one activity event, if any.
   */
  private commitChange(
    prepared: PreparedImport,
    plan: CommitPlan,
    draft: DraftState,
  ): {
    value: CommitPlan;
    event?: { action: "create" | "edit"; targetKind: "meeting"; targetId: string };
  } {
    const meetings = draft.meetings as Meeting[];
    const transcripts = draft.transcripts as Transcript[];
    if (plan.write === "create") {
      // The meeting id is allocated from the draft that is actually persisted,
      // so the meeting, its transcript's association and its event all name it.
      this.recheckNewContent(draft, plan);
      const id = this.internals().nextId(draft, "meetings");
      const created = parseMeeting({ ...plan.meeting!, id });
      plan.meetingId = id;
      if (plan.event !== undefined) plan.event.targetId = id;
      meetings.push(created);
      transcripts.push({ ...plan.transcript!, meetingId: id });
    } else if (plan.write === "attach") {
      this.recheckNewContent(draft, plan);
      transcripts.push(plan.transcript!);
    } else if (plan.write === "edit") {
      // The draft must still hold the canonical transcript this original joins.
      const index = transcripts.findIndex(
        (t) => t.id === plan.planTranscriptId && t.meetingId === plan.meetingId,
      );
      const transcript = index < 0 ? undefined : transcripts[index];
      if (transcript === undefined) {
        throw new ValidationError(`transcript ${JSON.stringify(plan.planTranscriptId)} is no longer stored`);
      }
      transcripts[index] = {
        ...transcript,
        sources: this.proposedSources(transcript, this.newSource({ ...prepared, ...planOriginals(plan) })),
      };
    }
    return plan.event === undefined ? { value: plan } : { value: plan, event: plan.event };
  }

  /**
   * Re-check a plan that adds content to the committed draft: the engagement
   * must still hold no transcript of this canonical content, and a target
   * meeting must still hold no transcript of its own (a create's meeting is
   * new, so this only guards an attachment).
   */
  private recheckNewContent(draft: DraftState, plan: CommitPlan): void {
    const meeting = draft.meetings.find((m) => m.id === plan.meetingId);
    if (plan.write !== "create" && meeting === undefined) {
      throw new MissingRecordError(`No meeting with id ${JSON.stringify(plan.meetingId)}`);
    }
    if (plan.write === "attach" && meeting !== undefined && this.transcriptOf(draft, meeting.id) !== undefined) {
      throw new ValidationError(
        `meeting ${JSON.stringify(meeting.id)} already holds a transcript of different content; ` +
          "an attachment is never replaced",
      );
    }
    const engagementId = meeting?.engagementId ?? plan.engagementId;
    const clash = (draft.transcripts ?? []).some(
      (t) =>
        t.canonicalText === plan.canonicalText &&
        draft.meetings.some((m) => m.id === t.meetingId && m.engagementId === engagementId),
    );
    if (clash) {
      throw new ValidationError(
        `engagement ${JSON.stringify(engagementId)} already holds this canonical transcript`,
      );
    }
  }

  /**
   * Publish and verify a prepared file original in the workspace's own original
   * repository, before the JSON that names it is committed. The published bytes
   * are retained even when the commit later fails, and a retry or a reopen
   * verifies and reuses them.
   */
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
    // A borrowed store stays open: the caller that opened it closes it.
    if (!this.ownsStore) return;
    await this.store.close();
  }
}

/** A validated plan for one import, applied to the draft that is committed. */
interface CommitPlan {
  readonly outcome: CommittedOutcome["outcome"];
  readonly engagementId: string;
  /** The meeting the import commits to (allocated for a create in the draft). */
  meetingId: string;
  readonly createdMeeting: boolean;
  /** What the commit does: a no-op save, a create, an attachment or one edit. */
  readonly write: "noop" | "create" | "attach" | "edit";
  /** The one activity event the commit records, if it records any. */
  event?: { action: "create" | "edit"; targetKind: "meeting"; targetId: string };
  /** The canonical transcript that gains a new original (an edit only). */
  readonly planTranscriptId?: string;
  /** The canonical content a create or attachment adds (for its draft re-check). */
  readonly canonicalText?: string;
  /** The exact bytes of the new original this edit adds. */
  readonly originalBytes?: Uint8Array;
  /** The original's exact text when it is a paste. */
  readonly originalPastedText?: string;
  /** The meeting a create adds to the draft. */
  readonly meeting?: Meeting;
  /** The transcript a create or attachment adds to the draft. */
  readonly transcript?: Transcript;
  readonly conflicts: TranscriptConflict[];
  readonly attachedOriginal: boolean;
  /** The supplied target meeting, when the import was aimed at one. */
  readonly wantedMeetingId?: string;
}

/** The original a plan's edit adds, as the prepared import's own fields. */
function planOriginals(plan: CommitPlan): Pick<PreparedImport, "originalBytes" | "pastedText"> {
  if (plan.originalBytes === undefined) {
    throw new ValidationError("an edit plan carries its new original");
  }
  return { originalBytes: plan.originalBytes, pastedText: plan.originalPastedText };
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
 * Build a transcript service over an already-open workspace store. The service
 * shares that store's own mutation queue and original-file store, so an import
 * and an ordinary store write are serialized together and name originals in the
 * same repository the workspace keeps. The service does not own the store: the
 * caller keeps it open and closes it, and closing the borrowed service is a
 * no-op. Only the adapters a borrowed service needs can be overridden; the
 * workspace's filesystem, clock, originals and lock stay the open store's own.
 */
export function transcriptService(
  store: Store,
  options: TranscriptServiceOptions = {},
): TranscriptStore {
  const internals = store as unknown as CommitStore;
  return new TranscriptStoreImpl(store, internals.originalFiles(), options.docxParser, options.pdfParser, false);
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
    // An opened store is owned by its service: closing the service closes it.
    return new TranscriptStoreImpl(
      store,
      internals.originalFiles(),
      options.docxParser,
      options.pdfParser,
      true,
    );
  } catch (cause) {
    await store.close();
    throw cause;
  }
}

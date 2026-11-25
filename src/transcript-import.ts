/**
 * Internal transcript submission handler: turns one accepted submission for an
 * engagement, project or meeting URL into a committed transcript import.
 *
 * The handler is not registered on any HTTP route and never touches the
 * filesystem itself: it resolves the URL record from the workspace, derives the
 * client and engagement that authoritatively hold the record, reads the decoded
 * form controls and the separately submitted file, and then hands one raw import
 * and one validated target to the transcript service (`transcript-store.ts`),
 * which shares the workspace store's own mutation queue and originals.
 *
 * The URL is authoritative:
 *
 * - `kind` and `rawId` name the record: `engagement`, `project` or `meeting`.
 *   The raw id is decoded here; a malformed escape or a missing record is a
 *   `MissingRecordError` (a 404 for the shell). A record with broken ancestry is
 *   refused as invalid.
 * - The client and engagement are derived from the URL record, never from the
 *   submission: an engagement names its client, a project names its engagement
 *   (and so its client), and a meeting names its engagement and project.
 * - A supplied identity or parent control (`id`, `meetingId`, `clientId`,
 *   `engagementId`, `projectId`) that asserts a value other than the derived one
 *   is a conflicting assertion, refused with `ValidationError` (400). A blank
 *   assertion conflicts too, exactly like the archive pages: it names no record,
 *   so it cannot name the URL's own. Only an omitted control asserts nothing.
 *   The one exception is the project selection on a create, where an explicit
 *   blank means the engagement only. Other controls the handler does not use are
 *   ignored.
 *
 * What a submission asks for:
 *
 * - An engagement or project URL creates a meeting in that engagement. `title`
 *   and `date` are required (the store validates the date as a real calendar
 *   date); `notes` is passed only when the control was supplied, so an omitted
 *   notes leaves the meeting without one and an explicitly blank notes is kept
 *   blank. The project is the URL project when the control is omitted under a
 *   project URL; an explicit blank selects the engagement only (no project); any
 *   other value must be a project of that engagement, otherwise the selection
 *   is refused as invalid input (400), never as a missing record.
 * - A meeting URL attaches to exactly that meeting. Its fields are preserved:
 *   the submission's title, date and notes are ignored, and only the meeting in
 *   the URL is the target.
 *
 * Exactly one raw import must be submitted: a nonempty `paste` text control or a
 * selected file. Whitespace in the paste is preserved exactly as submitted, and
 * a named file with zero bytes is a selected file, so the adapters validate both
 * as they would any other import. Submitting both or neither is refused with
 * `ValidationError` (400) before anything is written.
 *
 * A successful commit resolves with the store's `TranscriptImportResult`; a
 * refused submission writes nothing, including blobs.
 */
import { MissingRecordError, ValidationError } from "./model.ts";
import type { Engagement, Meeting, Project, Snapshot } from "./store.ts";
import {
  type SubmissionImport,
  type TranscriptImportResult,
  type TranscriptInput,
  type TranscriptStore,
  type TranscriptTarget,
} from "./transcript-store.ts";

/** The record kind a submission URL names. */
export type SubmissionRouteKind = "engagement" | "project" | "meeting";

/** The separately submitted file, as the multipart decoder returns it. */
export interface SubmissionFile {
  /** The plain, nonempty filename parameter, exactly as submitted. */
  readonly filename: string;
  /** The file payload's exact bytes. */
  readonly bytes: Uint8Array;
}

/** One accepted submission for an engagement, project or meeting URL. */
export interface TranscriptSubmission {
  /** The record kind the URL resolved to. */
  readonly kind: SubmissionRouteKind;
  /** The raw, still percent-encoded id path segment of the URL. */
  readonly rawId: string;
  /** The decoded text controls of the accepted body. */
  readonly fields: Readonly<Record<string, string>>;
  /** The selected file, or null when none was selected. */
  readonly file: SubmissionFile | null;
}

/** The text control that carries pasted transcript text. */
const PASTE_CONTROL = "paste";

/** The resolved URL record and the authoritative parents derived from it. */
interface ResolvedScope {
  /** The record kind the URL names. */
  readonly kind: SubmissionRouteKind;
  /** The raw, still encoded id the URL names. */
  readonly rawId: string;
  /** The id of the record the URL names. */
  readonly recordId: string;
  readonly clientId: string;
  readonly engagementId: string;
  /** The project the URL names, when the URL names a project. */
  readonly urlProjectId?: string;
  /** The meeting the URL names, when the URL names a meeting. */
  readonly meeting?: Meeting;
}

/** Decode a raw path id; a malformed escape names no record. */
function decodeId(rawId: unknown, kind: SubmissionRouteKind): string {
  if (typeof rawId !== "string" || rawId === "") {
    throw new MissingRecordError(`No ${kind} for that path`);
  }
  try {
    return decodeURIComponent(rawId);
  } catch {
    throw new MissingRecordError(`No ${kind} for that path`);
  }
}

/** A missing record: the URL record (404). */
function missing(kind: string, id: string): MissingRecordError {
  return new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
}

/**
 * The engagement a project belongs to, with a valid client. A broken chain is
 * invalid stored metadata, refused rather than trusted.
 */
function engagementOf(snapshot: Snapshot, project: Project): Engagement {
  const engagement = snapshot.engagements.find((e) => e.id === project.engagementId);
  if (engagement === undefined) {
    throw new ValidationError(
      `project ${JSON.stringify(project.id)} references a missing engagement`,
    );
  }
  if (!snapshot.clients.some((c) => c.id === engagement.clientId)) {
    throw new ValidationError(
      `engagement ${JSON.stringify(engagement.id)} references a missing client`,
    );
  }
  return engagement;
}

/** Resolve the URL record and derive its authoritative client and engagement. */
function resolveScope(snapshot: Snapshot, kind: SubmissionRouteKind, rawId: string): ResolvedScope {
  if (kind === "engagement") {
    const id = decodeId(rawId, kind);
    const engagement = snapshot.engagements.find((e) => e.id === id);
    if (engagement === undefined) throw missing("engagement", id);
    if (!snapshot.clients.some((c) => c.id === engagement.clientId)) {
      throw new ValidationError(
        `engagement ${JSON.stringify(engagement.id)} references a missing client`,
      );
    }
    return {
      kind,
      rawId,
      recordId: engagement.id,
      clientId: engagement.clientId,
      engagementId: engagement.id,
    };
  }
  if (kind === "project") {
    const id = decodeId(rawId, kind);
    const project = snapshot.projects.find((p) => p.id === id);
    if (project === undefined) throw missing("project", id);
    const engagement = engagementOf(snapshot, project);
    return {
      kind,
      rawId,
      recordId: project.id,
      clientId: engagement.clientId,
      engagementId: engagement.id,
      urlProjectId: project.id,
    };
  }
  const id = decodeId(rawId, kind);
  const meeting = snapshot.meetings.find((m) => m.id === id);
  if (meeting === undefined) throw missing("meeting", id);
  const engagement = snapshot.engagements.find((e) => e.id === meeting.engagementId);
  if (engagement === undefined) {
    throw new ValidationError(
      `meeting ${JSON.stringify(meeting.id)} references a missing engagement`,
    );
  }
  if (engagement.clientId !== meeting.clientId) {
    throw new ValidationError(
      `meeting ${JSON.stringify(meeting.id)} has mismatched client and engagement links`,
    );
  }
  if (!snapshot.clients.some((c) => c.id === meeting.clientId)) {
    throw new ValidationError(
      `meeting ${JSON.stringify(meeting.id)} references a missing client`,
    );
  }
  if (meeting.projectId !== undefined) {
    const project = snapshot.projects.find((p) => p.id === meeting.projectId);
    if (project === undefined || project.engagementId !== meeting.engagementId) {
      throw new ValidationError(
        `meeting ${JSON.stringify(meeting.id)} references a missing or mismatched project`,
      );
    }
  }
  return {
    kind,
    rawId,
    recordId: meeting.id,
    clientId: meeting.clientId,
    engagementId: meeting.engagementId,
    ...(meeting.projectId === undefined ? {} : { urlProjectId: meeting.projectId }),
    meeting,
  };
}

/** Require the decoded controls to be an object whose known values are strings. */
function requireFields(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("transcript submission fields must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "id",
    "meetingId",
    "clientId",
    "engagementId",
    "projectId",
    "title",
    "date",
    "notes",
    PASTE_CONTROL,
  ]) {
    if (Object.hasOwn(record, key) && typeof record[key] !== "string") {
      throw new ValidationError(`transcript submission field ${JSON.stringify(key)} must be a string`);
    }
  }
  return record as Readonly<Record<string, string>>;
}

/**
 * Refuse a supplied identity or parent control that asserts a value other than
 * the derived one, inside the import's own queue turn so the comparison uses
 * the committed records the import will be applied to. An omitted control
 * asserts nothing; a present value, including a blank one, must name exactly
 * the derived value (the archive pages' rule: an empty clientId is a conflict).
 * An `id` control names the record of the URL, so on both routes it must equal
 * the record the URL names. A `meetingId` control names the attachment target
 * and asserts nothing on a create, which names no meeting, so any such value
 * conflicts there. On a create the project control is an ordinary selection
 * (blank means the engagement only) and is validated by `createTarget`; on an
 * attachment it is a parent assertion against the preserved meeting.
 */
function requireAssertions(
  fields: Readonly<Record<string, string>>,
  scope: ResolvedScope,
  create: boolean,
): void {
  const assert = (name: string, expected: string): void => {
    if (!Object.hasOwn(fields, name)) return;
    const supplied = fields[name];
    if (supplied !== expected) {
      throw new ValidationError(
        `Submitted ${name} ${JSON.stringify(supplied)} conflicts with the URL's ${name} ${JSON.stringify(expected)}`,
      );
    }
  };
  assert("clientId", scope.clientId);
  assert("engagementId", scope.engagementId);
  // A meeting control names no meeting on a create, so it conflicts there too.
  if (Object.hasOwn(fields, "meetingId")) {
    if (create) {
      throw new ValidationError(
        `Submitted meetingId ${JSON.stringify(fields.meetingId)} conflicts with a create that names no meeting`,
      );
    }
    assert("meetingId", scope.meeting?.id ?? "");
  }
  if (!create && Object.hasOwn(fields, "projectId")) {
    assert("projectId", scope.meeting?.projectId ?? "");
  }
  assert("id", scope.recordId);
}

/** The one raw import a submission carries: exactly one paste or one file. */
function requireInput(
  fields: Readonly<Record<string, string>>,
  file: SubmissionFile | null,
): TranscriptInput {
  let paste: string | undefined;
  if (Object.hasOwn(fields, PASTE_CONTROL)) {
    paste = fields[PASTE_CONTROL];
  }
  const hasPaste = paste !== undefined && paste !== "";
  const hasFile = file !== null;
  if (hasPaste === hasFile) {
    throw new ValidationError(
      "Submit exactly one transcript: a nonempty paste or a selected file, never both and never neither",
    );
  }
  if (hasFile) {
    const selected = file as SubmissionFile;
    if (
      typeof selected.filename !== "string" ||
      selected.filename === "" ||
      !(selected.bytes instanceof Uint8Array)
    ) {
      throw new ValidationError("the submitted file must have a nonempty filename and bytes");
    }
    return { kind: "file", bytes: new Uint8Array(selected.bytes), filename: selected.filename };
  }
  return { kind: "paste", text: paste };
}

/**
 * The meeting create a submission asks for, with the URL-derived parents, the
 * required title and date, the notes only when supplied, and the project chosen
 * by the control or defaulted to the URL project. An explicit blank project
 * selects the engagement only and is marked as such privately, so a reuse of the
 * canonical meeting reports it as a supplied difference without the marker
 * reaching the public target parser. Any other selected project must
 * be a project of the URL engagement: a selection that is not (an unknown id, a
 * project of another engagement, or a malformed value) is invalid input refused
 * with `ValidationError` (400), never a missing record, before anything is
 * imported.
 */
function createTarget(
  snapshot: Snapshot,
  fields: Readonly<Record<string, string>>,
  scope: ResolvedScope,
): { target: TranscriptTarget; engagementOnly: boolean } {
  if (!Object.hasOwn(fields, "title") || !Object.hasOwn(fields, "date")) {
    throw new ValidationError("creating a meeting needs a title and a date");
  }
  let projectId: string | undefined;
  let engagementOnly = false;
  if (Object.hasOwn(fields, "projectId")) {
    const supplied = fields.projectId;
    if (supplied === "") {
      engagementOnly = true;
    } else {
      const selected = snapshot.projects.find((p) => p.id === supplied);
      if (selected === undefined || selected.engagementId !== scope.engagementId) {
        throw new ValidationError(
          `Submitted projectId ${JSON.stringify(supplied)} is not a project of engagement ${JSON.stringify(scope.engagementId)}`,
        );
      }
      projectId = selected.id;
    }
  } else {
    projectId = scope.urlProjectId;
  }
  return {
    target: {
      create: {
        clientId: scope.clientId,
        engagementId: scope.engagementId,
        ...(projectId === undefined ? {} : { projectId }),
        title: fields.title,
        date: fields.date,
        ...(Object.hasOwn(fields, "notes") ? { notes: fields.notes } : {}),
      },
    },
    engagementOnly,
  };
}

/**
 * Handle one accepted submission for an engagement, project or meeting URL and
 * commit its transcript import through the supplied service. The service is
 * built over the already-open workspace store (`transcriptService`), so the
 * import and any ordinary store write share one queue and one originals store.
 */
export function submitTranscript(
  service: TranscriptStore,
  submission: TranscriptSubmission,
): Promise<TranscriptImportResult> {
  // A refused submission resolves like any other failure: a rejected promise,
  // never a synchronous throw, and nothing is written.
  try {
    return thisSubmission();
  } catch (cause) {
    return Promise.reject(cause);
  }

  function thisSubmission(): Promise<TranscriptImportResult> {
    if (typeof submission !== "object" || submission === null) {
      throw new ValidationError("transcript submission must be an object");
    }
    const kind = submission.kind;
    if (kind !== "engagement" && kind !== "project" && kind !== "meeting") {
      throw new ValidationError('transcript submission kind must be "engagement", "project" or "meeting"');
    }
    const fields = requireFields(submission.fields);
    const file = submission.file ?? null;
    // The whole submission is resolved and checked inside one admission to the
    // service's own store queue: the URL record and its derived parents, the
    // assertions against them, the input and the target are read from the
    // committed state the resolver is given, and the import commits inside that
    // same turn. The resolver runs when admission is decided and again at the
    // start of the turn (where it sees every write queued before this
    // submission), so an assertion that held for the old records cannot commit
    // after a queued move to a new parent; a store closed or blocked before
    // admission is refused.
    function resolve(snapshot: Snapshot): SubmissionImport {
      const scope = resolveScope(snapshot, kind, submission.rawId);
      const create = kind !== "meeting";
      requireAssertions(fields, scope, create);
      const input = requireInput(fields, file);
      let target: TranscriptTarget;
      let engagementOnly = false;
      if (create) {
        const built = createTarget(snapshot, fields, scope);
        target = built.target;
        engagementOnly = built.engagementOnly;
      } else {
        target = { meetingId: scope.meeting!.id };
      }
      return {
        input,
        target,
        ...(engagementOnly ? { engagementOnly } : {}),
      };
    }
    return service.submitImport(resolve);
  }
}

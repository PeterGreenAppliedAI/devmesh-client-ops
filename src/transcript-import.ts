/**
 * Internal transcript submission handler: turns one accepted submission for an
 * engagement, project or meeting URL into a committed transcript import.
 *
 * The handler is not registered on any HTTP route and never touches the
 * filesystem itself: it shape-checks the submission it was handed (the resolved
 * route kind, the raw id path segment, the decoded form controls and the
 * separately submitted file) and passes it as data to the transcript service
 * (`transcript-store.ts`), which shares the workspace store's own mutation
 * queue and originals. The service resolves the URL record, derives the client
 * and engagement, checks the submitted assertions and validates the target
 * inside its one admitted queue turn, so every decision is made against the
 * committed records the import is applied to, and the handler chooses nothing
 * the submission does not settle.
 *
 * The URL is authoritative:
 *
 * - `kind` and `rawId` name the record: `engagement`, `project` or `meeting`.
 *   The raw id is decoded there; a malformed escape or a missing record is a
 *   `MissingRecordError` (a 404 for the shell). A record with broken ancestry is
 *   refused as invalid.
 * - The client and engagement are derived from the URL record, never from the
 *   submission.
 * - A supplied identity or parent control that asserts a value other than the
 *   derived one is a conflicting assertion, refused with `ValidationError`
 *   (400). Other controls the handler does not use are ignored.
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
import { ValidationError } from "./model.ts";
import {
  type SubmissionFile,
  type SubmissionRouteKind,
  type TranscriptImportResult,
  type TranscriptStore,
  type TranscriptSubmission,
} from "./transcript-store.ts";

// The submission's shapes belong to the service that reads them; this handler
// re-exports them so callers can name one submission's route, controls and file.
export type { SubmissionFile, SubmissionRouteKind, TranscriptSubmission };

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
    return service.submitTranscript(submission);
  }
}

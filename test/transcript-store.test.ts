import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsModule from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync as renameSyncImpl,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  MissingRecordError,
  openStore,
  PersistenceError,
  ValidationError,
  type FileSystem,
  type Store,
} from "../src/store.ts";
import { openTranscriptStore, type TranscriptStore } from "../src/transcript-store.ts";
import { ORIGINALS_DIRECTORY, type OriginalFileSystem } from "../src/transcript-files.ts";
import { canonicalize, importPastedText, MAX_CONTENT_BYTES } from "../src/transcript.ts";
import { docxBytes, docxOfLength } from "./fixtures/transcript-docx.ts";
import { pdfBytes, pdfOfLength } from "./fixtures/transcript-pdf.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-store-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

function encoder(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Assert a rejection is a classified parser refusal carrying `refusalCode`. */
function refusal(error: unknown, refusalCode: string): boolean {
  assert.ok(error instanceof ValidationError, String(error));
  assert.equal((error as { code?: string }).code, "parser_refused");
  assert.equal((error as { refusal?: { code: string } }).refusal?.code, refusalCode);
  assert.ok(Array.isArray((error as { refusal?: { supportedExports: unknown } }).refusal?.supportedExports));
  return true;
}

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

const PASTED_TEXT = "Alice: Hello there.\n\nBob: Hi, how are you?\n\nAlice: Fine, thanks.";

/** Create one client and engagement and return their ids. */
async function hierarchy(store: Store): Promise<{ clientId: string; engagementId: string }> {
  const client = await store.createClient({ name: "Acme" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  return { clientId: client.id, engagementId: engagement.id };
}

function createFor(
  parents: { clientId: string; engagementId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    create: {
      clientId: parents.clientId,
      engagementId: parents.engagementId,
      title: "Kickoff",
      date: "2026-01-02",
      ...overrides,
    },
  };
}

async function freshStore(
  dir: string,
  options: Parameters<typeof openTranscriptStore>[1] = {},
): Promise<{ ts: TranscriptStore; parents: { clientId: string; engagementId: string } }> {
  const ts = await openTranscriptStore(dir, options);
  const parents = await hierarchy(ts.store);
  return { ts, parents };
}

/** The activity journal's entries, for asserting exactly what was recorded. */
function activity(store: Store) {
  return store.snapshot().activity ?? [];
}

describe("transcript store: create, attach and reopen", () => {
  it("creates a meeting for a pasted import and records one create event", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const result = await ts.importTranscript(
        { kind: "paste", text: PASTED_TEXT },
        createFor(parents),
      );
      assert.equal(result.outcome, "created");
      assert.equal(result.createdMeeting, true);
      assert.equal(result.attachedOriginal, true);
      assert.equal(result.meeting.title, "Kickoff");
      assert.equal(result.meeting.date, "2026-01-02");
      assert.equal(result.transcript.meetingId, result.meeting.id);
      assert.equal(result.transcript.canonicalText, importPastedText(PASTED_TEXT).ok
        ? (importPastedText(PASTED_TEXT) as { result: { canonicalText: string } }).result.canonicalText
        : "");
      assert.equal(result.sourceIds.length, 1);
      assert.deepEqual(result.sourceIds, result.transcript.sources.map((s) => s.id));
      assert.equal(result.conflicts.length, 0);

      // The setup's own client and engagement creates are recorded too; the
      // import records exactly one further event: its meeting create.
      const events = activity(ts.store);
      assert.equal(events.length, 3);
      assert.equal(events[0].targetKind, "client");
      assert.equal(events[1].targetKind, "engagement");
      assert.equal(events[2].action, "create");
      assert.equal(events[2].targetKind, "meeting");
      assert.equal(events[2].targetId, result.meeting.id);

      // The pasted original is the exact text in the JSON, and the extracted
      // text matches the source exactly.
      const source = result.transcript.sources[0];
      assert.equal(source.format, "paste");
      assert.equal(source.originalText, PASTED_TEXT);
      assert.equal(source.extractedText, PASTED_TEXT);
    } finally {
      await ts.close();
    }
    // The committed document holds the record, its counter and its event.
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 6);
    assert.equal(saved.transcripts.length, 1);
    assert.equal(saved.meetings.length, 1);
    assert.equal(saved.activity.length, 3);
    assert.equal(saved.nextIds.meetings, 2);
  });

  it("attaches once to a notes-only meeting, keeping its metadata", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const meeting = await ts.store.createMeeting({
        ...parents,
        title: "Notes only",
        date: "2026-03-04",
        notes: "",
      });
      const result = await ts.importTranscript(
        { kind: "paste", text: PASTED_TEXT },
        { meetingId: meeting.id },
      );
      assert.equal(result.outcome, "attached");
      assert.equal(result.meeting.id, meeting.id);
      assert.equal(result.meeting.title, "Notes only");
      assert.equal(result.meeting.date, "2026-03-04");
      assert.equal(result.meeting.notes, "");
      assert.equal(result.createdMeeting, false);
      assert.equal(result.attachedOriginal, true);
      assert.equal(result.explanation?.code, "attached_notes_only");
      const events = activity(ts.store);
      assert.equal(events.length, 4, "two setup creates, one meeting create and one edit");
      assert.equal(events[3].action, "edit");
      assert.equal(events[3].targetId, meeting.id);
    } finally {
      await ts.close();
    }
    // Reopening finds the transcript on the notes-only meeting, unchanged.
    const reopened = await openTranscriptStore(dir);
    try {
      const transcripts = reopened.transcripts();
      assert.equal(transcripts.length, 1);
      assert.equal(transcripts[0].meetingId, "meeting-1");
      const meeting = reopened.store.snapshot().meetings[0];
      assert.equal(meeting.title, "Notes only");
      assert.equal(meeting.notes, "");
      const read = await reopened.readSource(transcripts[0].id, transcripts[0].sources[0].id);
      assert.equal(read.extractedText, PASTED_TEXT);
      assert.equal(new TextDecoder().decode(read.originalBytes), PASTED_TEXT);
    } finally {
      await reopened.close();
    }
  });

  it("creates a file original in the hash repository and reopens it verified", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    const bytes = encoder(PASTED_TEXT);
    let transcriptId = "";
    let sourceId = "";
    try {
      const result = await ts.importTranscript(
        { kind: "file", bytes, filename: "kickoff.txt" },
        createFor(parents),
      );
      assert.equal(result.outcome, "created");
      const source = result.transcript.sources[0];
      assert.equal(source.format, "txt");
      assert.equal(source.filename, "kickoff.txt");
      assert.equal(source.originalSha256, sha256(bytes));
      assert.equal(source.originalLength, bytes.length);
      assert.equal(source.originalText, undefined);
      transcriptId = result.transcript.id;
      sourceId = source.id;
      // The file original is published under its hash name, and the JSON holds
      // the hash reference rather than base64 or text.
      const original = join(dir, ORIGINALS_DIRECTORY, sha256(bytes));
      assert.equal(existsSync(original), true);
      assert.deepEqual(new Uint8Array(readFileSync(original)), bytes);
      const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
      assert.equal(saved.transcripts[0].sources[0].originalSha256, sha256(bytes));
      assert.equal("originalText" in saved.transcripts[0].sources[0], false);
    } finally {
      await ts.close();
    }
    const reopened = await openTranscriptStore(dir);
    try {
      const read = await reopened.readSource(transcriptId, sourceId);
      assert.deepEqual(read.originalBytes, bytes);
      assert.deepEqual(read.reference, { sha256: sha256(bytes), byteLength: bytes.length });
      assert.equal(read.filename, "kickoff.txt");
      assert.equal(read.format, "txt");
    } finally {
      await reopened.close();
    }
  });
});

describe("transcript store: equivalence across formats", () => {
  it("treats whitespace-only differences as the same canonical content and attaches a distinct original", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Alice: Hello there.\n\nBob: Hi,   how are you?\n\nAlice: Fine,\tthanks.  " },
        createFor(parents),
      );
      const canonical = first.transcript.canonicalText;
      // The same words through CRLF whitespace runs: a distinct original, the
      // same canonical content.
      const second = await ts.importTranscript(
        { kind: "paste", text: " Alice:  Hello there.\r\n\r\nBob: Hi, how are you?\r\n\r\nAlice: Fine, thanks.\n" },
        { meetingId: first.meeting.id },
      );
      assert.equal(second.outcome, "new_source");
      assert.equal(second.transcript.id, first.transcript.id);
      assert.equal(second.transcript.canonicalText, canonical);
      // Both originals are retained as separate sources, each with its own
      // exact text and mappings.
      assert.equal(second.transcript.sources.length, 2);
      assert.notEqual(second.transcript.sources[0].originalText, second.transcript.sources[1].originalText);
      assert.equal(second.transcript.sources[1].extractedText, " Alice:  Hello there.\r\n\r\nBob: Hi, how are you?\r\n\r\nAlice: Fine, thanks.\n");
      assert.equal(second.transcript.sources[1].passages[0].sourceId, second.transcript.sources[1].id);
      assert.equal(second.attachedOriginal, true);
      const events = activity(ts.store);
      assert.equal(events.length, 4, "two setup creates, one create and one edit");
      assert.equal(events[3].action, "edit");
      assert.equal(events[3].targetId, first.meeting.id);
    } finally {
      await ts.close();
    }
  });

  it("collapses case-sensitively: case is significant", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Alice: Hello." },
        createFor(parents),
      );
      // Different case is different canonical content: the target already holds
      // an attachment, so it is refused and nothing is written.
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: "alice: hello." },
          { meetingId: first.meeting.id },
        ),
        ValidationError,
      );
      assert.equal(ts.transcripts().length, 1);
      assert.equal(ts.transcripts()[0].sources.length, 1);
      assert.notEqual(
        ts.transcripts()[0].canonicalText,
        canonicalize("alice: hello."),
        "case is significant in the canonical content",
      );
    } finally {
      await ts.close();
    }
  });

  it("reuses the canonical transcript for the same words in a .txt file, retaining a distinct original", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Line one.\n\nLine two." },
        createFor(parents),
      );
      const second = await ts.importTranscript(
        { kind: "file", bytes: encoder("Line one.\r\n\r\nLine two.\r\n"), filename: "lines.txt" },
        { meetingId: first.meeting.id },
      );
      assert.equal(second.transcript.id, first.transcript.id);
      assert.equal(second.outcome, "new_source");
      assert.equal(second.transcript.sources[1].format, "txt");
      assert.equal(second.transcript.sources[1].filename, "lines.txt");
      assert.equal(second.transcript.sources[1].originalSha256, sha256(encoder("Line one.\r\n\r\nLine two.\r\n")));
    } finally {
      await ts.close();
    }
  });

  it("reads a DOCX and a PDF through the adapters into distinct originals of the same content", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const docx = docxBytes(["Alpha meeting.", "Second paragraph."]);
      const pdf = pdfBytes([["Alpha meeting."], ["Second paragraph."]]);
      const first = await ts.importTranscript(
        { kind: "file", bytes: docx, filename: "kickoff.docx" },
        createFor(parents),
      );
      assert.equal(first.outcome, "created");
      const second = await ts.importTranscript(
        { kind: "file", bytes: pdf, filename: "kickoff.pdf" },
        { meetingId: first.meeting.id },
      );
      assert.equal(second.transcript.id, first.transcript.id, "the same extracted words are the same content");
      assert.equal(second.outcome, "new_source");
      assert.equal(second.transcript.sources.length, 2);
      const pdfSource = second.transcript.sources[1];
      assert.equal(pdfSource.format, "pdf");
      assert.ok(pdfSource.passages.every((passage) => passage.page !== undefined));
      assert.equal(pdfSource.originalSha256, sha256(pdf));
      // Each source keeps its own text and mappings, named by its own id.
      for (const source of second.transcript.sources) {
        assert.ok(source.passages.every((passage) => passage.sourceId === source.id));
      }
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: exact repeats across formats", () => {
  it("retains a paste and a file with identical bytes as distinct originals", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript({ kind: "paste", text: "Hello" }, createFor(parents));
      // The same bytes as a .txt file: the same canonical content, a distinct
      // original, committed with one edit instead of a duplicate-id refusal.
      const asFile = await ts.importTranscript(
        { kind: "file", bytes: encoder("Hello"), filename: "hello.txt" },
        { meetingId: first.meeting.id },
      );
      assert.equal(asFile.outcome, "new_source");
      assert.equal(asFile.transcript.id, first.transcript.id);
      assert.equal(asFile.transcript.sources.length, 2);
      const [pasteSource, fileSource] = asFile.transcript.sources;
      assert.equal(pasteSource.format, "paste");
      assert.equal(fileSource.format, "txt");
      assert.notEqual(pasteSource.id, fileSource.id, "a paste and a file never share a stored source id");
      // The file is a new original: exactly one edit was recorded.
      assert.equal(activity(ts.store).at(-1)!.action, "edit");
      // Exact repeats of each original across formats reuse its stored id: the
      // file's bytes as a paste is still the file's own source.
      const repeatFile = await ts.importTranscript(
        { kind: "file", bytes: encoder("Hello"), filename: "renamed.txt" },
        { meetingId: first.meeting.id },
      );
      assert.equal(repeatFile.outcome, "reused");
      assert.equal(repeatFile.explanation?.code, "exact_repeat");
      assert.deepEqual(repeatFile.sourceIds, asFile.sourceIds);
      const repeatPaste = await ts.importTranscript({ kind: "paste", text: "Hello" }, { meetingId: first.meeting.id });
      assert.equal(repeatPaste.outcome, "reused");
      assert.deepEqual(repeatPaste.sourceIds, asFile.sourceIds);
      assert.equal(repeatPaste.transcript.sources[0].filename, "Pasted text", "the first filename is kept");
    } finally {
      await ts.close();
    }
  });

  it("writes no blob when the proposed metadata fails validation", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript({ kind: "paste", text: "Validated words." }, createFor(parents));
      const original = join(dir, ORIGINALS_DIRECTORY);
      const before = existsSync(original) ? readdirSync(original) : [];
      // A file original whose metadata cannot be committed: the target already
      // holds a transcript of different content.
      await assert.rejects(
        ts.importTranscript(
          { kind: "file", bytes: encoder("Different file words."), filename: "different.txt" },
          { meetingId: first.meeting.id },
        ),
        ValidationError,
      );
      const after = existsSync(original) ? readdirSync(original) : [];
      assert.deepEqual(after, before, "nothing was published before the validation failed");
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: exact repeats, distinct originals and reuse", () => {
  it("reuses stored ids on an exact repeat and writes nothing", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "file", bytes: encoder(PASTED_TEXT), filename: "first.txt" },
        createFor(parents),
      );
      const eventsBefore = activity(ts.store).length;
      const fileBefore = readFileSync(storePath(dir), "utf8");
      // The same bytes under a different filename: an exact repeat.
      const repeat = await ts.importTranscript(
        { kind: "file", bytes: encoder(PASTED_TEXT), filename: "renamed.txt" },
        { meetingId: first.meeting.id },
      );
      assert.equal(repeat.outcome, "reused");
      assert.equal(repeat.attachedOriginal, false);
      assert.deepEqual(repeat.sourceIds, first.sourceIds);
      assert.equal(repeat.transcript.sources[0].filename, "first.txt", "the first filename is kept");
      assert.equal(repeat.explanation?.code, "exact_repeat");
      assert.equal(activity(ts.store).length, eventsBefore, "an exact repeat records no event");
      assert.equal(readFileSync(storePath(dir), "utf8"), fileBefore, "an exact repeat writes nothing");

      // A pasted repeat of a pasted original also reuses its stored id.
      const pasted = await ts.importTranscript(
        { kind: "paste", text: "Pasted once." },
        createFor(parents, { title: "Pasted" }),
      );
      const pastedRepeat = await ts.importTranscript(
        { kind: "paste", text: "Pasted once." },
        { meetingId: pasted.meeting.id },
      );
      assert.equal(pastedRepeat.outcome, "reused");
      assert.deepEqual(pastedRepeat.sourceIds, pasted.sourceIds);
    } finally {
      await ts.close();
    }
  });

  it("keeps each distinct original with its own text and mappings", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const base = await ts.importTranscript(
        { kind: "paste", text: "Words that stay the same." },
        createFor(parents),
      );
      const variants = [
        encoder("Words that stay the same.\r\n"),
        encoder("Words that stay the same.\n\n\n"),
        encoder("Words that stay the same.\n"),
      ];
      let last = base;
      for (let index = 0; index < variants.length; index += 1) {
        last = await ts.importTranscript(
          { kind: "file", bytes: variants[index], filename: `variant-${index}.txt` },
          { meetingId: base.meeting.id },
        );
        assert.equal(last.outcome, "new_source");
      }
      const sources = last.transcript.sources;
      assert.equal(sources.length, 4);
      const ids = new Set(sources.map((source) => source.id));
      assert.equal(ids.size, 4, "every distinct original has its own source id");
      const originals = new Set(sources.map((source) => source.originalText ?? source.originalSha256));
      assert.equal(originals.size, 4, "every original is distinct");
      // Each source's extracted text is its own exact bytes, decoded.
      for (let index = 0; index < variants.length; index += 1) {
        const source = sources[index + 1];
        assert.equal(source.extractedText, new TextDecoder().decode(variants[index]));
      }
    } finally {
      await ts.close();
    }
  });

  it("reuses the canonical meeting for a create with the same content and reports supplied differences", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Agenda.\n\nDecisions." },
        createFor(parents, { title: "Original", notes: "kept notes" }),
      );
      const meetingBefore = ts.store.snapshot().meetings[0];
      const eventsBefore = activity(ts.store).length;
      // The same content pasted again with its own whitespace is a distinct
      // original, attached with one edit while the create's differences are
      // reported and never written.
      const again = await ts.importTranscript(
        { kind: "paste", text: "Agenda.\r\n\r\nDecisions.\n" },
        createFor(parents, { title: "Different title", notes: "different notes" }),
      );
      assert.equal(again.outcome, "new_source");
      assert.equal(again.createdMeeting, false);
      assert.equal(again.meeting.id, first.meeting.id);
      assert.deepEqual(again.conflicts, [
        { field: "title", supplied: "Different title", preserved: "Original" },
        { field: "notes", supplied: "different notes", preserved: "kept notes" },
      ]);
      assert.equal(again.explanation?.code, "new_original");
      // The preserved metadata and project are untouched; no meeting was made.
      assert.deepEqual(ts.store.snapshot().meetings[0], meetingBefore);
      assert.equal(ts.store.snapshot().meetings.length, 1);
      // Only the one new distinct original was attached (one edit), and no
      // meeting was created for it.
      assert.equal(again.transcript.sources.length, 2);
      assert.equal(again.createdMeeting, false);
      assert.equal(activity(ts.store).length, eventsBefore + 1);
      assert.equal(activity(ts.store).at(-1)!.action, "edit");
      assert.equal(activity(ts.store).at(-1)!.targetId, first.meeting.id);
    } finally {
      await ts.close();
    }
  });

  it("reports differing supplied dates, projects and explicitly blank notes", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const project = await ts.store.createProject({ engagementId: parents.engagementId, name: "P" });
      const first = await ts.importTranscript(
        { kind: "paste", text: "Dated words." },
        createFor(parents, { title: "Same", date: "2026-01-02", projectId: project.id, notes: "kept notes" }),
      );
      const meetingBefore = ts.store.snapshot().meetings[0];
      const again = await ts.importTranscript(
        { kind: "paste", text: "Dated words." },
        createFor(parents, { title: "Same", date: "2026-02-03", notes: "" }),
      );
      assert.equal(again.outcome, "reused");
      assert.equal(again.explanation?.code, "exact_repeat");
      assert.deepEqual(again.conflicts, [
        { field: "date", supplied: "2026-02-03", preserved: "2026-01-02" },
        { field: "projectId", supplied: "", preserved: project.id },
        { field: "notes", supplied: "", preserved: "kept notes" },
      ]);
      // The preserved metadata and project are untouched; nothing was written.
      assert.deepEqual(ts.store.snapshot().meetings[0], meetingBefore);
      assert.equal(ts.store.snapshot().meetings.length, 1);
      // Notes that were not supplied at all are not a difference.
      const omitted = await ts.importTranscript(
        { kind: "paste", text: "Dated words." },
        createFor(parents, { title: "Same", date: "2026-01-02", projectId: project.id }),
      );
      assert.deepEqual(omitted.conflicts, []);
      assert.equal(omitted.meeting.id, first.meeting.id);
    } finally {
      await ts.close();
    }
  });

  it("records no activity for a no-op repeat and rejects a failed no-op save", async () => {
    const dir = tempDir();
    const setup = await openTranscriptStore(dir);
    const parents = await hierarchy(setup.store);
    const first = await setup.importTranscript({ kind: "paste", text: "No-op words." }, createFor(parents));
    await setup.close();
    // Reopen with a failing rename, so even the no-op save cannot be written.
    const failing = await openTranscriptStore(dir, { fs: workspaceAdapter({ renameSync: true }) });
    try {
      const before = failing.transcripts();
      const eventsBefore = activity(failing.store).length;
      await assert.rejects(
        failing.importTranscript({ kind: "paste", text: "No-op words." }, { meetingId: first.meeting.id }),
        PersistenceError,
      );
      // Nothing added: no source, no counter, no event, no memory change.
      assert.deepEqual(failing.transcripts(), before);
      assert.equal(failing.transcripts()[0].sources.length, 1);
      assert.equal(activity(failing.store).length, eventsBefore);
      assert.equal(failing.store.snapshot().meetings.length, 1);
    } finally {
      await failing.close();
    }
    // Reopened, the repeat succeeds as a no-op and records no event.
    const reopened = await openTranscriptStore(dir);
    try {
      const eventsBefore = activity(reopened.store).length;
      const repeat = await reopened.importTranscript(
        { kind: "paste", text: "No-op words." },
        { meetingId: first.meeting.id },
      );
      assert.equal(repeat.outcome, "reused");
      assert.equal(repeat.explanation?.code, "exact_repeat");
      assert.deepEqual(repeat.sourceIds, first.sourceIds);
      assert.equal(activity(reopened.store).length, eventsBefore, "a no-op repeat records no event");
    } finally {
      await reopened.close();
    }
  });

  it("reports no conflict when the supplied metadata equals the preserved one", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Same words." },
        createFor(parents, { title: "Same", notes: "same notes" }),
      );
      const same = await ts.importTranscript(
        { kind: "paste", text: "Same words." },
        createFor(parents, { title: "Same", notes: "same notes" }),
      );
      // An exact repeat is a no-op: the stored source is reused, no conflict is
      // reported and no event is recorded.
      assert.equal(same.outcome, "reused");
      assert.deepEqual(same.conflicts, []);
      assert.equal(same.transcript.id, first.transcript.id);
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: another target meeting", () => {
  it("leaves the other target unchanged and returns the canonical meeting with an explanation", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const canonical = await ts.importTranscript(
        { kind: "paste", text: "The canonical words." },
        createFor(parents, { title: "Canonical" }),
      );
      const other = await ts.store.createMeeting({
        ...parents,
        title: "Other",
        date: "2026-05-06",
        notes: "",
      });
      const otherBefore = ts.store.snapshot().meetings.find((m) => m.id === other.id)!;
      const eventsBefore = activity(ts.store).length;
      const result = await ts.importTranscript(
        { kind: "paste", text: "The canonical words." },
        { meetingId: other.id },
      );
      assert.equal(result.outcome, "reused");
      assert.equal(result.meeting.id, canonical.meeting.id);
      assert.equal(result.canonicalMeetingId, canonical.meeting.id);
      assert.equal(result.explanation?.code, "other_meeting");
      assert.match(result.explanation!.message, /left unchanged/);
      // The other meeting is unchanged and holds no transcript.
      assert.deepEqual(ts.store.snapshot().meetings.find((m) => m.id === other.id), otherBefore);
      assert.ok(ts.transcripts().every((t) => t.meetingId !== other.id));
      assert.equal(activity(ts.store).length, eventsBefore, "nothing recorded");
    } finally {
      await ts.close();
    }
  });

  it("keeps an exact repeat aimed at another meeting free of writes", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const canonical = await ts.importTranscript(
        { kind: "paste", text: "Repeat words." },
        createFor(parents),
      );
      const other = await ts.store.createMeeting({
        ...parents,
        title: "Elsewhere",
        date: "2026-06-07",
        notes: "has notes",
      });
      const before = readFileSync(storePath(dir), "utf8");
      const result = await ts.importTranscript(
        { kind: "paste", text: "Repeat words." },
        { meetingId: other.id },
      );
      assert.equal(result.outcome, "reused");
      assert.equal(result.attachedOriginal, false);
      assert.equal(result.meeting.id, canonical.meeting.id);
      assert.match(result.explanation!.message, /left unchanged/);
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: replacement refusal and separate engagements", () => {
  it("never replaces the attachment of a meeting that carries notes", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "First conversation." },
        createFor(parents),
      );
      const firstSourceIds = first.sourceIds;
      // A notes-only meeting (a manual record with notes) receives its first
      // attachment once, keeping its metadata, including its notes.
      const meeting = await ts.store.createMeeting({
        ...parents,
        title: "With notes",
        date: "2026-07-08",
        notes: "Some notes",
      });
      const meetingBefore = ts.store.snapshot().meetings.find((m) => m.id === meeting.id)!;
      const attached = await ts.importTranscript(
        { kind: "paste", text: "Its own transcript." },
        { meetingId: meeting.id },
      );
      assert.equal(attached.outcome, "attached");
      assert.equal(attached.meeting.id, meeting.id);
      assert.deepEqual(attached.meeting, meetingBefore, "the meeting's metadata, notes included, is kept");
      const attachedSourceIds = attached.sourceIds;
      const eventsBefore = activity(ts.store).length;
      // Different content aimed at that meeting is refused before writing: the
      // attachment it holds is never replaced and no second transcript is made.
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: "A completely different conversation." },
          { meetingId: meeting.id },
        ),
        ValidationError,
      );
      assert.equal(ts.transcripts().length, 2);
      // The existing attachment and its sources are unchanged.
      const stored = ts.transcripts().find((t) => t.id === attached.transcript.id)!;
      assert.deepEqual(stored.sources.map((s) => s.id), attachedSourceIds);
      assert.deepEqual(ts.store.snapshot().meetings.find((m) => m.id === meeting.id), meetingBefore);
      // The first meeting's transcript is untouched too.
      const untouched = ts.transcripts().find((t) => t.id === first.transcript.id)!;
      assert.deepEqual(untouched.sources.map((s) => s.id), firstSourceIds);
      assert.equal(activity(ts.store).length, eventsBefore, "the refused attempt records nothing");
    } finally {
      await ts.close();
    }
  });

  it("rejects different content for an already-attached target before writing", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      // An empty (notes-only) meeting, created as a manual record.
      const meeting = await ts.store.createMeeting({
        ...parents,
        title: "First attachment",
        date: "2026-08-09",
        notes: "",
      });
      const first = await ts.importTranscript(
        { kind: "paste", text: "The first attachment." },
        { meetingId: meeting.id },
      );
      assert.equal(first.outcome, "attached");
      const meetingBefore = ts.store.snapshot().meetings.find((m) => m.id === meeting.id)!;
      const eventsBefore = activity(ts.store).length;
      // Different content aimed at the same, now-attached meeting: refused
      // before anything is written.
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: "Content that would replace it." },
          { meetingId: meeting.id },
        ),
        ValidationError,
      );
      // Nothing changed: the attachment, the meeting and the journal are as they
      // were before the refused attempt.
      assert.equal(ts.transcripts().length, 1);
      assert.deepEqual(ts.transcripts()[0].sources.map((s) => s.id), first.sourceIds);
      assert.deepEqual(ts.store.snapshot().meetings.find((m) => m.id === meeting.id), meetingBefore);
      assert.equal(activity(ts.store).length, eventsBefore);
    } finally {
      await ts.close();
    }
  });

  it("scopes an attachment to the target's engagement, not the first engagement", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Shared words." },
        createFor(parents),
      );
      const other = await ts.store.createClient({ name: "Other client" });
      const otherEngagement = await ts.store.createEngagement({ clientId: other.id, name: "Other eng" });
      const target = await ts.store.createMeeting({
        clientId: other.id,
        engagementId: otherEngagement.id,
        title: "Elsewhere",
        date: "2026-09-10",
        notes: "",
      });
      // The same words are new content in the target's engagement: they attach
      // to that target with their own source, not to the first engagement's
      // canonical meeting.
      const elsewhere = await ts.importTranscript(
        { kind: "paste", text: "Shared words." },
        { meetingId: target.id },
      );
      assert.equal(elsewhere.outcome, "attached");
      assert.equal(elsewhere.transcript.id, first.transcript.id);
      assert.equal(elsewhere.meeting.id, target.id);
      assert.equal(elsewhere.canonicalMeetingId, undefined);
      assert.equal(elsewhere.attachedOriginal, true);
      assert.equal(ts.transcripts().length, 2);
      // The first engagement's transcript is not appended to.
      const firstStored = ts.transcripts().find((t) => t.meetingId === first.meeting.id)!;
      assert.deepEqual(firstStored.sources.map((s) => s.id), first.sourceIds);
      // A repeat aimed at the target reuses that engagement's own transcript
      // and leaves the first engagement's canonical meeting alone.
      const repeat = await ts.importTranscript(
        { kind: "paste", text: "Shared words." },
        { meetingId: target.id },
      );
      assert.equal(repeat.outcome, "reused");
      assert.equal(repeat.meeting.id, target.id);
      assert.deepEqual(repeat.sourceIds, elsewhere.sourceIds);
      assert.equal(ts.transcripts().length, 2);
    } finally {
      await ts.close();
    }
  });

  it("adds a repeat to the target engagement's transcript, not the first engagement's", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript({ kind: "paste", text: "Shared words." }, createFor(parents));
      const other = await ts.store.createClient({ name: "Other client" });
      const otherEngagement = await ts.store.createEngagement({ clientId: other.id, name: "Other eng" });
      const target = await ts.store.createMeeting({
        clientId: other.id,
        engagementId: otherEngagement.id,
        title: "Elsewhere",
        date: "2026-09-10",
        notes: "",
      });
      const elsewhere = await ts.importTranscript({ kind: "paste", text: "Shared words." }, { meetingId: target.id });
      // A distinct original (whitespace) aimed at the target is attached to the
      // target engagement's own transcript; the first engagement's transcript
      // is never appended to.
      const distinct = await ts.importTranscript(
        { kind: "paste", text: " Shared words.\r\n" },
        { meetingId: target.id },
      );
      assert.equal(distinct.outcome, "new_source");
      assert.equal(distinct.meeting.id, target.id);
      assert.equal(distinct.transcript.sources.length, 2);
      const firstStored = ts.transcripts().find((t) => t.meetingId === first.meeting.id)!;
      assert.deepEqual(firstStored.sources.map((s) => s.id), first.sourceIds, "the first engagement is untouched");
      const elsewhereStored = ts.transcripts().find((t) => t.meetingId === target.id)!;
      assert.deepEqual(elsewhereStored.sources.map((s) => s.id), distinct.sourceIds);
      assert.deepEqual(distinct.sourceIds.slice(0, 1), elsewhere.sourceIds);
      // A source read returns the value scoped to the target engagement.
      const read = await ts.readSource(distinct.transcript.id, distinct.sourceIds[1], otherEngagement.id);
      assert.equal(read.engagementId, otherEngagement.id);
      assert.equal(read.meetingId, target.id);
      assert.equal(read.extractedText, " Shared words.\r\n");
    } finally {
      await ts.close();
    }
  });

  it("reads a source in its own engagement when the id is held once", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const other = await ts.store.createClient({ name: "Other client" });
      const otherEngagement = await ts.store.createEngagement({ clientId: other.id, name: "Other eng" });
      const first = await ts.importTranscript({ kind: "paste", text: "One engagement." }, createFor(parents));
      const elsewhere = await ts.importTranscript(
        { kind: "paste", text: "Another engagement." },
        createFor({ clientId: other.id, engagementId: otherEngagement.id }),
      );
      const firstRead = await ts.readSource(first.transcript.id, first.sourceIds[0]);
      const elsewhereRead = await ts.readSource(elsewhere.transcript.id, elsewhere.sourceIds[0]);
      assert.equal(firstRead.engagementId, parents.engagementId);
      assert.equal(elsewhereRead.engagementId, otherEngagement.id);
      assert.equal(firstRead.meetingId, first.meeting.id);
      assert.equal(elsewhereRead.meetingId, elsewhere.meeting.id);
      assert.equal(firstRead.transcriptId, first.transcript.id);
      assert.equal(elsewhereRead.transcriptId, elsewhere.transcript.id);
      assert.equal(firstRead.extractedText, "One engagement.");
      assert.equal(elsewhereRead.extractedText, "Another engagement.");
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: archives", () => {
  it("reuses an archived canonical meeting and leaves it archived", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const first = await ts.importTranscript(
        { kind: "paste", text: "Archived words." },
        createFor(parents),
      );
      await ts.store.setArchived("engagement", parents.engagementId, true);
      const result = await ts.importTranscript(
        { kind: "paste", text: "Archived words." },
        createFor(parents, { title: "New title" }),
      );
      assert.equal(result.outcome, "reused");
      assert.equal(result.meeting.id, first.meeting.id);
      assert.equal(result.explanation?.code, "archived_canonical");
      assert.deepEqual(result.conflicts, [
        { field: "title", supplied: "New title", preserved: "Kickoff" },
      ]);
      const engagement = ts.store.snapshot().engagements[0];
      assert.equal(engagement.archived, true, "the engagement stays archived");
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: concurrent repeats", () => {
  it("serializes concurrent repeats so only the first writes and the rest reuse", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const text = "Concurrent words.\n\nSecond paragraph.";
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          ts.importTranscript({ kind: "paste", text }, createFor(parents)),
        ),
      );
      const transcripts = ts.transcripts();
      assert.equal(transcripts.length, 1, "one canonical transcript");
      assert.equal(transcripts[0].sources.length, 1, "one original for one exact content");
      assert.equal(results[0].outcome, "created");
      assert.equal(results[1].outcome, "reused");
      assert.equal(results[2].outcome, "reused");
      assert.equal(
        activity(ts.store).filter((event) => event.targetKind === "meeting").length,
        1,
        "only the first import recorded a meeting event",
      );
      assert.equal(ts.store.snapshot().meetings.length, 1);
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: validation, ancestry and lifecycle", () => {
  it("refuses malformed input and targets without writing", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const before = readFileSync(storePath(dir), "utf8");
      const badInputs: unknown[] = [
        undefined,
        null,
        {},
        { kind: "paste", text: 123 },
        { kind: "paste", text: PASTED_TEXT, bytes: encoder(PASTED_TEXT), filename: "x.txt" },
        { kind: "file", bytes: "not bytes", filename: "x.txt" },
        { kind: "file", bytes: encoder(PASTED_TEXT), filename: "" },
        { kind: "file", bytes: encoder(PASTED_TEXT), filename: "x.rtf" },
      ];
      for (const input of badInputs) {
        await assert.rejects(
          ts.importTranscript(input as never, createFor(parents)),
          ValidationError,
          `input ${JSON.stringify(input)}`,
        );
      }
      const badTargets: unknown[] = [
        {},
        { create: undefined, meetingId: undefined },
        { meetingId: "" },
        { create: { ...createFor(parents).create, meetingId: "meeting-1" } as never, meetingId: "meeting-1" },
      ];
      for (const target of badTargets) {
        await assert.rejects(
          ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, target as never),
          ValidationError,
        );
      }
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
      assert.equal(ts.transcripts().length, 0);
      assert.equal(ts.store.snapshot().meetings.length, 0);
      assert.equal(activity(ts.store).length, 2, "only the setup's creates");
    } finally {
      await ts.close();
    }
  });

  it("validates a supplied create even when its content is reused", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      await ts.importTranscript({ kind: "paste", text: "Existing words." }, createFor(parents));
      const before = readFileSync(storePath(dir), "utf8");
      // The content is known, but the supplied date is impossible and the parent
      // is missing: both are refused before anything is written.
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: "Existing words." },
          createFor(parents, { date: "2023-02-29" }),
        ),
        ValidationError,
      );
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: "Existing words." },
          createFor({ ...parents, engagementId: "engagement-9" }),
        ),
        MissingRecordError,
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
    } finally {
      await ts.close();
    }
  });

  it("refuses a non-meeting title and an impossible date without writing", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const before = readFileSync(storePath(dir), "utf8");
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor(parents, { title: "  " })),
        ValidationError,
      );
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor(parents, { date: "2023-02-29" })),
        ValidationError,
      );
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor(parents, { date: "01/02/2026" })),
        ValidationError,
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
      assert.equal(ts.store.snapshot().meetings.length, 0);
      assert.equal(activity(ts.store).length, 2, "only the setup's creates");
    } finally {
      await ts.close();
    }
  });

  it("refuses missing and mismatched parents before any write", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const other = await ts.store.createClient({ name: "Other" });
      // A project from another engagement is prepared first, so the snapshot
      // taken next is exactly the state the refused imports must leave.
      const foreign = await ts.store.createProject({ engagementId: parents.engagementId, name: "P" });
      const otherEngagement = await ts.store.createEngagement({ clientId: other.id, name: "OE" });
      const otherProject = await ts.store.createProject({ engagementId: otherEngagement.id, name: "OP" });
      const before = readFileSync(storePath(dir), "utf8");
      // A missing client or engagement is a missing record.
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor({ ...parents, clientId: "client-9" })),
        MissingRecordError,
      );
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor({ ...parents, engagementId: "engagement-9" })),
        MissingRecordError,
      );
      // An engagement that belongs to another client is a validation failure.
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: PASTED_TEXT },
          createFor({ clientId: other.id, engagementId: parents.engagementId }),
        ),
        ValidationError,
      );
      // A project from another engagement is refused.
      await assert.rejects(
        ts.importTranscript(
          { kind: "paste", text: PASTED_TEXT },
          createFor(parents, { projectId: otherProject.id }),
        ),
        ValidationError,
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
      // A valid project in the same engagement is accepted and kept.
      const withProject = await ts.importTranscript(
        { kind: "paste", text: PASTED_TEXT },
        createFor(parents, { projectId: foreign.id }),
      );
      assert.equal(withProject.meeting.projectId, foreign.id);
    } finally {
      await ts.close();
    }
  });

  it("refuses a target meeting with bad ancestry and a missing target", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, { meetingId: "meeting-9" }),
        MissingRecordError,
      );
      // A stored document whose engagement is missing is refused at open, so
      // no target with that ancestry can be reached.
      await ts.store.createMeeting({ ...parents, title: "M", date: "2026-01-01" });
      await ts.close();
      const document = JSON.parse(readFileSync(storePath(dir), "utf8"));
      document.engagements = [];
      const content = JSON.stringify(document);
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError, "a document with a dangling engagement is refused");
      assert.equal(readFileSync(storePath(dir), "utf8"), content, "the refused document is left untouched");
      assert.equal(existsSync(join(dir, "workspace.lock")), false, "lock released");
    } finally {
      await ts.close();
    }
  });

  it("refuses operations after close", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    const result = await ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor(parents));
    await ts.close();
    await assert.rejects(
      ts.importTranscript({ kind: "paste", text: "More." }, { meetingId: result.meeting.id }),
      PersistenceError,
    );
    await assert.rejects(ts.readSource(result.transcript.id, result.sourceIds[0]), PersistenceError);
  });
});

describe("transcript store: classified parser refusals", () => {
  it("keeps a parser refusal classified and writes nothing", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const before = readFileSync(storePath(dir), "utf8");
      // A corrupt DOCX is refused by the installed parser.
      await assert.rejects(
        ts.importTranscript(
          { kind: "file", bytes: encoder("not a docx"), filename: "bad.docx" },
          createFor(parents),
        ),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError, String(error));
          assert.equal((error as { code?: string }).code, "parser_refused");
          assert.ok((error as { refusal?: { code: string } }).refusal);
          return true;
        },
      );
      // A file refused for its bytes being corrupt is the PDF adapter's
      // refusal, classified the same way.
      await assert.rejects(
        ts.importTranscript(
          { kind: "file", bytes: encoder("not a pdf"), filename: "bad.pdf" },
          createFor(parents),
        ),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError, String(error));
          assert.equal((error as { code?: string }).code, "parser_refused");
          assert.equal((error as { refusal?: { code: string } }).refusal?.code, "unreadable_document");
          return true;
        },
      );
      // A whitespace-only paste is refused with the core's refusal code.
      await assert.rejects(
        ts.importTranscript({ kind: "paste", text: "   \n\t " }, createFor(parents)),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "parser_refused");
          assert.equal((error as { refusal?: { code: string } }).refusal?.code, "whitespace_only");
          return true;
        },
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
    } finally {
      await ts.close();
    }
  });

  it("keeps oversized originals and unsupported formats classified and writes nothing", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const before = readFileSync(storePath(dir), "utf8");
      // An unsupported extension is the adapter's `unsupported_format` refusal.
      await assert.rejects(
        ts.importTranscript(
          { kind: "file", bytes: encoder(PASTED_TEXT), filename: "notes.rtf" },
          createFor(parents),
        ),
        (error: unknown) => refusal(error, "unsupported_format"),
      );
      // An oversized original is a `too_large` refusal at the inclusive limit.
      const oversized = new Uint8Array(MAX_CONTENT_BYTES + 1);
      oversized.fill(65);
      await assert.rejects(
        ts.importTranscript({ kind: "file", bytes: oversized, filename: "big.txt" }, createFor(parents)),
        (error: unknown) => refusal(error, "too_large"),
      );
      // An oversized DOCX original is classified the same way, before its
      // parser is asked to read it.
      await assert.rejects(
        ts.importTranscript({ kind: "file", bytes: oversized, filename: "big.docx" }, createFor(parents)),
        (error: unknown) => refusal(error, "too_large"),
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "nothing written");
      assert.equal(ts.transcripts().length, 0);
      assert.equal(ts.store.snapshot().meetings.length, 0);
    } finally {
      await ts.close();
    }
  });

  it("accepts a good DOCX and a good PDF through their adapters", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    try {
      const docx = await ts.importTranscript(
        { kind: "file", bytes: docxBytes(["Docx body."]), filename: "doc.docx" },
        createFor(parents),
      );
      assert.equal(docx.outcome, "created");
      assert.equal(docx.transcript.sources[0].format, "docx");
      const pdf = await ts.importTranscript(
        { kind: "file", bytes: pdfBytes([["Pdf body."]]), filename: "doc.pdf" },
        createFor(parents, { title: "Pdf", date: "2026-02-02" }),
      );
      assert.equal(pdf.outcome, "created");
      assert.equal(pdf.transcript.sources[0].format, "pdf");
    } finally {
      await ts.close();
    }
  });
});

describe("transcript store: verified source reads", () => {
  it("returns detached values and never a path into the hash repository", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    const bytes = encoder(PASTED_TEXT);
    const result = await ts.importTranscript({ kind: "file", bytes, filename: "f.txt" }, createFor(parents));
    try {
      const read = await ts.readSource(result.transcript.id, result.sourceIds[0]);
      assert.deepEqual(read.originalBytes, bytes);
      assert.equal(read.extractedText, PASTED_TEXT);
      assert.equal(read.sourceId, result.sourceIds[0]);
      assert.equal(read.meetingId, result.meeting.id);
      assert.ok(Object.isFrozen(read));
      assert.ok(Object.isFrozen(read.reference));
      // The values are detached; changing them changes nothing stored.
      read.originalBytes.fill(0);
      const again = await ts.readSource(result.transcript.id, result.sourceIds[0]);
      assert.deepEqual(again.originalBytes, bytes);
      // A caller path or arbitrary hash never reaches the filesystem.
      await assert.rejects(ts.readSource(result.transcript.id, join(dir, "workspace.json")), MissingRecordError);
      await assert.rejects(ts.readSource(result.transcript.id, "0".repeat(64)), MissingRecordError);
      await assert.rejects(ts.readSource("", result.sourceIds[0]), ValidationError);
    } finally {
      await ts.close();
    }
  });

  it("refuses a read of a missing or corrupt original without repairing it", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    const bytes = encoder(PASTED_TEXT);
    const result = await ts.importTranscript({ kind: "file", bytes, filename: "f.txt" }, createFor(parents));
    await ts.close();

    const original = join(dir, ORIGINALS_DIRECTORY, sha256(bytes));
    // A corrupt original fails the read and is left untouched.
    writeFileSync(original, "corrupt bytes", "utf8");
    const reopened = await openTranscriptStore(dir);
    try {
      await assert.rejects(
        reopened.readSource(result.transcript.id, result.sourceIds[0]),
        PersistenceError,
      );
      assert.equal(readFileSync(original, "utf8"), "corrupt bytes", "corrupt original left untouched");
      // Metadata edits preserve sources, and the manual records stay usable.
      const meeting = await reopened.store.updateMeeting(result.meeting.id, { title: "Edited" });
      assert.equal(meeting.title, "Edited");
      assert.deepEqual(
        reopened.transcripts()[0].sources.map((s) => s.id),
        result.sourceIds,
      );
    } finally {
      await reopened.close();
    }

    // A missing original fails the read and is not recreated.
    rmSync(original);
    const reopenedAgain = await openTranscriptStore(dir);
    try {
      await assert.rejects(
        reopenedAgain.readSource(result.transcript.id, result.sourceIds[0]),
        PersistenceError,
      );
      assert.equal(existsSync(original), false, "a missing original is not repaired");
    } finally {
      await reopenedAgain.close();
    }
  });

  it("refuses an unknown transcript or source as a missing record", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    const result = await ts.importTranscript({ kind: "paste", text: PASTED_TEXT }, createFor(parents));
    try {
      await assert.rejects(ts.readSource("sha256:" + "0".repeat(64), result.sourceIds[0]), MissingRecordError);
      await assert.rejects(ts.readSource(result.transcript.id, "missing"), MissingRecordError);
    } finally {
      await ts.close();
    }
  });
});

/** An original store adapter over node:fs, with optional injected failures. */
function originalsAdapter(overrides: Partial<OriginalFileSystem> = {}): Partial<OriginalFileSystem> {
  const fs: OriginalFileSystem = {
    existsSync: (path) => existsSync(path),
    mkdirSync: (path, options) => fsModule.mkdirSync(path, options),
    openSync: (path, flags) => fsModule.openSync(path, flags),
    writeSync: (fd, data) => fsModule.writeSync(fd, data),
    fsyncSync: (fd) => fsModule.fsyncSync(fd),
    closeSync: (fd) => fsModule.closeSync(fd),
    renameSync: (oldPath, newPath) => fsModule.renameSync(oldPath, newPath),
    unlinkSync: (path) => fsModule.unlinkSync(path),
    readFileSync: (path) => new Uint8Array(fsModule.readFileSync(path)),
    fsyncDirectorySync: undefined as unknown as () => void,
  };
  return Object.assign(fs, overrides);
}

/** A workspace adapter over node:fs with one injected failure, directory flush on. */
function workspaceAdapter(failOn: { renameSync?: boolean; readFileSyncBytes?: boolean } = {}): Partial<FileSystem> {
  return {
    renameSync: (oldPath, newPath) => {
      if (failOn.renameSync) throw fsError("EIO");
      renameSyncImpl(oldPath, newPath);
    },
    // The default directory flush is deliberately absent, so it runs through
    // this adapter's own open, flush and close.
    readFileSync: ((path: string, encoding?: "utf8"): string | Uint8Array => {
      if (encoding === undefined) {
        if (failOn.readFileSyncBytes) throw fsError("EIO");
        return new Uint8Array(fsModule.readFileSync(path));
      }
      return fsModule.readFileSync(path, "utf8") as string;
    }) as FileSystem["readFileSync"],
    openSync: (path, flags) => openSync(path, flags),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
  };
}

describe("transcript store: blob and JSON failures", () => {
  it("publishes no metadata on an original publication failure and leaves no temporary file", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir, {
      originalsFs: originalsAdapter({
        renameSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    try {
      const before = readFileSync(storePath(dir), "utf8");
      await assert.rejects(
        ts.importTranscript(
          { kind: "file", bytes: encoder(PASTED_TEXT), filename: "f.txt" },
          createFor(parents),
        ),
        PersistenceError,
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "no metadata published");
      assert.equal(ts.transcripts().length, 0);
      assert.equal(ts.store.snapshot().meetings.length, 0);
      assert.equal(activity(ts.store).length, 2, "only the setup's creates");
      const originalsDir = join(dir, ORIGINALS_DIRECTORY);
      const files = existsSync(originalsDir) ? readdirSync(originalsDir) : [];
      assert.deepEqual(files.filter((name) => !name.endsWith(".tmp")), [], "no published original");
      assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "temporary file cleaned up");
    } finally {
      await ts.close();
    }
  });

  it("retains the published blob after a JSON failure, and a retry verifies and reuses it", async () => {
    const dir = tempDir();
    const bytes = encoder(PASTED_TEXT);
    // The workspace and its hierarchy are committed first; then the store is
    // reopened with a rename that fails, so only the import's commit fails.
    const setup = await openTranscriptStore(dir);
    const parents = await hierarchy(setup.store);
    await setup.close();
    const failing = await openTranscriptStore(dir, {
      fs: workspaceAdapter({ renameSync: true }),
      originalsFs: originalsAdapter(),
    });
    let meetingId = "";
    try {
      await assert.rejects(
        failing.importTranscript({ kind: "file", bytes, filename: "f.txt" }, createFor(parents)),
        PersistenceError,
      );
      // No memory or success result was published.
      assert.equal(failing.transcripts().length, 0);
      assert.equal(failing.store.snapshot().meetings.length, 0);
      // The blob stays, unreferenced.
      const original = join(dir, ORIGINALS_DIRECTORY, sha256(bytes));
      assert.equal(existsSync(original), true);
      assert.deepEqual(new Uint8Array(readFileSync(original)), bytes);
    } finally {
      await failing.close();
    }

    // Reopen and retry: the existing blob is verified and reused, and the
    // commit succeeds.
    const reopened = await openTranscriptStore(dir);
    try {
      const result = await reopened.importTranscript(
        { kind: "file", bytes, filename: "f.txt" },
        createFor(parents),
      );
      assert.equal(result.outcome, "created");
      meetingId = result.meeting.id;
      assert.deepEqual(readdirSync(join(dir, ORIGINALS_DIRECTORY)), [sha256(bytes)], "reused, not rewritten");
      const read = await reopened.readSource(result.transcript.id, result.sourceIds[0]);
      assert.deepEqual(read.originalBytes, bytes);
    } finally {
      await reopened.close();
    }
    assert.ok(meetingId);
  });

  it("rolls back a journal/JSON failure without exposing new source ids", async () => {
    const dir = tempDir();
    const setup = await openTranscriptStore(dir);
    const parents = await hierarchy(setup.store);
    const first = await setup.importTranscript({ kind: "paste", text: "First." }, createFor(parents));
    // A second meeting, ready to receive its own first attachment.
    const second = await setup.store.createMeeting({
      ...parents,
      title: "Second meeting",
      date: "2026-03-04",
      notes: "",
    });
    await setup.close();
    // Reopen with a failing rename, so the new commit cannot be written.
    const failing = await openTranscriptStore(dir, { fs: workspaceAdapter({ renameSync: true }) });
    try {
      const committedBefore = failing.transcripts();
      const meetingEventsBefore = activity(failing.store).filter((e) => e.targetKind === "meeting").length;
      await assert.rejects(
        failing.importTranscript({ kind: "paste", text: "Second, different." }, { meetingId: second.id }),
        PersistenceError,
      );
      // The failed commit's new transcript and source ids are not exposed.
      assert.deepEqual(failing.transcripts(), committedBefore);
      assert.equal(failing.transcripts().length, 1);
      assert.equal(failing.transcripts()[0].sources.length, 1);
      assert.equal(
        activity(failing.store).filter((e) => e.targetKind === "meeting").length,
        meetingEventsBefore,
        "no meeting event from the failed commit",
      );
    } finally {
      await failing.close();
    }
    // The committed file still holds only the first commit.
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.transcripts.length, 1);
    assert.equal(saved.transcripts[0].id, first.transcript.id);
    const reopened = await openTranscriptStore(dir);
    try {
      assert.equal(reopened.transcripts().length, 1);
    } finally {
      await reopened.close();
    }
  });

  it("reads a source only when committed metadata and verified originals agree", async () => {
    const dir = tempDir();
    const { ts, parents } = await freshStore(dir);
    const bytes = encoder(PASTED_TEXT);
    const result = await ts.importTranscript({ kind: "file", bytes, filename: "f.txt" }, createFor(parents));
    await ts.close();
    // A failing byte read is a persistence failure, not a repair attempt.
    const failing = await openTranscriptStore(dir, {
      originalsFs: originalsAdapter({
        readFileSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    try {
      await assert.rejects(
        failing.readSource(result.transcript.id, result.sourceIds[0]),
        PersistenceError,
      );
    } finally {
      await failing.close();
    }
  });
});

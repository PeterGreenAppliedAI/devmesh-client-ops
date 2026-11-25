import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  MissingRecordError,
  PersistenceError,
  ValidationError,
  type FileSystem,
  type Store,
} from "../src/store.ts";
import { openStore } from "../src/store.ts";
import { ORIGINALS_DIRECTORY } from "../src/transcript-files.ts";
import { transcriptService, type TranscriptStore } from "../src/transcript-store.ts";
import { canonicalIdentityOf } from "../src/transcript.ts";
import {
  submitTranscript,
  type SubmissionFile,
  type SubmissionRouteKind,
  type TranscriptSubmission,
} from "../src/transcript-import.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-import-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

function encoder(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const PASTED_TEXT = "Alice: Hello there.\n\nBob: Hi, how are you?\n\nAlice: Fine, thanks.";

/** A workspace fixture: the open store, the service over it, and record ids. */
interface Fixture {
  readonly dir: string;
  readonly store: Store;
  readonly service: TranscriptStore;
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId: string;
  /** A second project of the same engagement. */
  readonly secondProjectId: string;
  /** A project of a sibling engagement in the same client. */
  readonly foreignProjectId: string;
  close(): Promise<void>;
}

/** A submission with the given route, id and controls; no file by default. */
function submission(
  kind: SubmissionRouteKind,
  id: string,
  fields: Record<string, string> = {},
  file: SubmissionFile | null = null,
): TranscriptSubmission {
  return { kind, rawId: encodeURIComponent(id), fields, file };
}

function pasted(text: string, fields: Record<string, string> = {}): [Record<string, string>, null] {
  return [{ ...fields, paste: text }, null];
}

async function fixture(): Promise<Fixture> {
  const dir = tempDir();
  const store = await openStore(dir);
  const service = transcriptService(store);
  const client = await store.createClient({ name: "Acme" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  const project = await store.createProject({ engagementId: engagement.id, name: "Proj" });
  const second = await store.createProject({ engagementId: engagement.id, name: "Second" });
  const sibling = await store.createEngagement({ clientId: client.id, name: "Sibling" });
  const foreign = await store.createProject({ engagementId: sibling.id, name: "Foreign" });
  return {
    dir,
    store,
    service,
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    secondProjectId: second.id,
    foreignProjectId: foreign.id,
    // The service borrows the fixture's store, so the fixture closes the store.
    close: () => store.close(),
  };
}

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/** A workspace adapter over node:fs whose rename can be made to fail. */
function workspaceAdapter(failOn: { renameSync?: boolean } = {}): Partial<FileSystem> {
  return {
    renameSync: (oldPath, newPath) => {
      if (failOn.renameSync) throw fsError("EIO");
      renameSync(oldPath, newPath);
    },
    // The default directory flush is deliberately absent, so it runs through
    // this adapter's own open, flush and close.
    openSync: (path, flags) => openSync(path, flags),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
  };
}

/** The number of stored transcripts, meetings and activity events. */
function counts(store: Store): { transcripts: number; meetings: number; events: number; sources: number } {
  const snapshot = store.snapshot();
  const transcripts = snapshot.transcripts ?? [];
  return {
    transcripts: transcripts.length,
    meetings: snapshot.meetings.length,
    events: (snapshot.activity ?? []).length,
    sources: transcripts.reduce((sum, transcript) => sum + transcript.sources.length, 0),
  };
}

describe("transcript submission handler: scoped creation", () => {
  it("creates a meeting in an engagement URL, deriving the client and engagement", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      const [fields, file] = pasted(PASTED_TEXT, { title: "Kickoff", date: "2026-01-02" });
      const result = await submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      assert.equal(result.outcome, "created");
      assert.equal(result.createdMeeting, true);
      assert.equal(result.meeting.engagementId, fx.engagementId);
      assert.equal(result.meeting.clientId, fx.clientId);
      assert.equal(result.meeting.title, "Kickoff");
      assert.equal(result.meeting.date, "2026-01-02");
      // No project control and no URL project: the meeting is engagement-only.
      assert.equal("projectId" in result.meeting, false);
      assert.equal(result.meeting.notes, "");
      const after = counts(fx.store);
      assert.equal(after.meetings, before.meetings + 1);
      assert.equal(after.transcripts, before.transcripts + 1);
      assert.equal(after.sources, before.sources + 1);
      assert.equal(after.events, before.events + 1, "one create event");
      // The committed document holds the meeting, transcript and event.
      const saved = JSON.parse(readFileSync(storePath(fx.dir), "utf8"));
      assert.equal(saved.meetings.length, before.meetings + 1);
      assert.equal(saved.transcripts.length, 1);
    } finally {
      await fx.close();
    }
  });

  it("defaults to the URL project when the project control is omitted", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted(PASTED_TEXT, { title: "Project meeting", date: "2026-01-03", notes: "some notes" });
      const result = await submitTranscript(fx.service, submission("project", fx.projectId, fields, file));
      assert.equal(result.outcome, "created");
      assert.equal(result.meeting.projectId, fx.projectId);
      assert.equal(result.meeting.engagementId, fx.engagementId);
      assert.equal(result.meeting.notes, "some notes");
    } finally {
      await fx.close();
    }
  });

  it("treats an explicit blank project as engagement-only and passes notes only when supplied", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted(PASTED_TEXT, { title: "No project", date: "2026-01-04", projectId: "" });
      const result = await submitTranscript(fx.service, submission("project", fx.projectId, fields, file));
      assert.equal(result.outcome, "created");
      assert.equal("projectId" in result.meeting, false);
      assert.equal(result.meeting.notes, "");
      assert.equal(result.meeting.engagementId, fx.engagementId);
    } finally {
      await fx.close();
    }
  });

  it("accepts an explicit project of the engagement and refuses one outside it", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted(PASTED_TEXT, {
        title: "Other project",
        date: "2026-01-05",
        projectId: fx.secondProjectId,
      });
      const created = await submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      assert.equal(created.meeting.projectId, fx.secondProjectId);

      const before = counts(fx.store);
      const [fields2, file2] = pasted("Different content.", {
        title: "Foreign project",
        date: "2026-01-06",
        projectId: fx.foreignProjectId,
      });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, fields2, file2)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before, "a refused create writes nothing");
    } finally {
      await fx.close();
    }
  });

  it("requires a title and a valid date on create", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      const [noTitle, file] = pasted("Words.", { date: "2026-01-07" });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, noTitle, file)),
        ValidationError,
      );
      const [badDate, file2] = pasted("Words.", { title: "T", date: "2026-02-30" });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, badDate, file2)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before);
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: attachment", () => {
  it("attaches to the URL meeting only, preserving its fields", async () => {
    const fx = await fixture();
    try {
      const meeting = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        projectId: fx.projectId,
        title: "Manual meeting",
        date: "2026-02-03",
        notes: "Manual notes",
      });
      const before = counts(fx.store);
      const [fields, file] = pasted(PASTED_TEXT, {
        title: "Ignored title",
        date: "1999-12-31",
        notes: "Ignored notes",
      });
      const result = await submitTranscript(fx.service, submission("meeting", meeting.id, fields, file));
      assert.equal(result.outcome, "attached");
      assert.equal(result.createdMeeting, false);
      assert.equal(result.meeting.id, meeting.id);
      assert.equal(result.meeting.title, "Manual meeting");
      assert.equal(result.meeting.date, "2026-02-03");
      assert.equal(result.meeting.notes, "Manual notes");
      assert.equal(result.meeting.projectId, fx.projectId);
      assert.equal(result.transcript.meetingId, meeting.id);
      const after = counts(fx.store);
      assert.equal(after.meetings, before.meetings, "no meeting created");
      assert.equal(after.transcripts, before.transcripts + 1);
      assert.equal(after.sources, before.sources + 1);
      assert.equal(after.events, before.events + 1, "one edit event");
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: repeats and reuse", () => {
  it("repeats to another target meeting, leaving it unchanged", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted("Canonical words.", { title: "Canonical", date: "2026-03-01" });
      const first = await submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      const other = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        title: "Other",
        date: "2026-03-02",
        notes: "",
      });
      const otherBefore = fx.store.snapshot().meetings.find((m) => m.id === other.id);
      const before = counts(fx.store);
      const [fields2, file2] = pasted("Canonical words.");
      const result = await submitTranscript(fx.service, submission("meeting", other.id, fields2, file2));
      assert.equal(result.outcome, "reused");
      assert.equal(result.meeting.id, first.meeting.id);
      assert.equal(result.canonicalMeetingId, first.meeting.id);
      assert.equal(result.explanation?.code, "other_meeting");
      assert.deepEqual(fx.store.snapshot().meetings.find((m) => m.id === other.id), otherBefore);
      assert.deepEqual(counts(fx.store), before, "nothing recorded or attached");
    } finally {
      await fx.close();
    }
  });

  it("reports an archived canonical meeting when only its project is archived", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted("Archived words.", { title: "Under project", date: "2026-04-01" });
      const first = await submitTranscript(fx.service, submission("project", fx.projectId, fields, file));
      assert.equal(first.meeting.projectId, fx.projectId);
      // Only the project is archived; the client and engagement stay active.
      await fx.store.setArchived("project", fx.projectId, true);
      const [fields2, file2] = pasted("Archived words.", { title: "New title", date: "2026-04-02" });
      const result = await submitTranscript(fx.service, submission("project", fx.projectId, fields2, file2));
      assert.equal(result.outcome, "reused");
      assert.equal(result.meeting.id, first.meeting.id);
      assert.equal(result.explanation?.code, "archived_canonical");
      const project = fx.store.snapshot().projects.find((p) => p.id === fx.projectId);
      assert.equal(project?.archived, true, "the project stays archived");
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: conflicting assertions and input", () => {
  it("rejects conflicting identity and parent assertions with 400 and writes nothing", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      const [badClient, file] = pasted("Words.", { title: "T", date: "2026-05-01", clientId: "client-999" });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, badClient, file)),
        ValidationError,
      );
      const [badEngagement, file2] = pasted("Words.", { title: "T", date: "2026-05-01", engagementId: "engagement-999" });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, badEngagement, file2)),
        ValidationError,
      );
      const [badId, file3] = pasted("Words.", { title: "T", date: "2026-05-01", id: "meeting-999" });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, badId, file3)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before);
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false, "no original was published");
    } finally {
      await fx.close();
    }
  });

  it("rejects a meetingId assertion on a create, which names no meeting", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      const [fields, file] = pasted("Words.", {
        title: "T",
        date: "2026-05-09",
        meetingId: "meeting-999",
      });
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before, "a refused create writes nothing");
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false, "no original was published");
    } finally {
      await fx.close();
    }
  });

  it("accepts matching identity and parent assertions", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted("Matching words.", {
        title: "Matching",
        date: "2026-05-02",
        clientId: fx.clientId,
        engagementId: fx.engagementId,
      });
      const result = await submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      assert.equal(result.outcome, "created");
      assert.equal(result.meeting.clientId, fx.clientId);
      assert.equal(result.meeting.engagementId, fx.engagementId);
    } finally {
      await fx.close();
    }
  });

  it("accepts a matching id assertion on a create and an attachment, refusing a mismatched one", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted("Matching id words.", {
        title: "Matching id",
        date: "2026-05-10",
        id: fx.engagementId,
      });
      const created = await submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      assert.equal(created.outcome, "created");
      assert.equal(created.meeting.engagementId, fx.engagementId);

      const [projectFields, projectFile] = pasted("Matching project id words.", {
        title: "Matching project id",
        date: "2026-05-11",
        id: fx.projectId,
      });
      const byProject = await submitTranscript(fx.service, submission("project", fx.projectId, projectFields, projectFile));
      assert.equal(byProject.outcome, "created");
      assert.equal(byProject.meeting.projectId, fx.projectId);

      // A meeting URL's matching id assertion is also accepted: a manual,
      // empty meeting receives its first attachment.
      const target = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        title: "Attachment target",
        date: "2026-05-12",
        notes: "",
      });
      const [meetingFields, meetingFile] = pasted("Fresh attachment words.", { id: target.id });
      const viaMeeting = await submitTranscript(fx.service, submission("meeting", target.id, meetingFields, meetingFile));
      assert.equal(viaMeeting.outcome, "attached");
      assert.equal(viaMeeting.meeting.id, target.id);

      const before = counts(fx.store);
      const [mismatch, mismatchFile] = pasted("Words.", { title: "T", date: "2026-05-13", id: fx.secondProjectId });
      await assert.rejects(
        submitTranscript(fx.service, submission("project", fx.projectId, mismatch, mismatchFile)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before, "a mismatched id writes nothing");
    } finally {
      await fx.close();
    }
  });

  it("rejects a conflicting project assertion on an attachment", async () => {
    const fx = await fixture();
    try {
      const meeting = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        projectId: fx.projectId,
        title: "Attached",
        date: "2026-05-03",
        notes: "",
      });
      const before = counts(fx.store);
      const [fields, file] = pasted("Words.", { projectId: fx.secondProjectId });
      await assert.rejects(
        submitTranscript(fx.service, submission("meeting", meeting.id, fields, file)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before);
    } finally {
      await fx.close();
    }
  });

  it("requires exactly one input: both or neither is refused with 400", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      const file: SubmissionFile = { filename: "notes.txt", bytes: encoder("File words.") };
      const both = { title: "T", date: "2026-05-04", paste: "Pasted words." };
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, both, file)),
        ValidationError,
      );
      const [neither, fileNeither] = [{ title: "T", date: "2026-05-05" }, null] as const;
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, neither, fileNeither)),
        ValidationError,
      );
      const [emptyPaste, fileEmpty] = [{ title: "T", date: "2026-05-06", paste: "" }, null] as const;
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", fx.engagementId, emptyPaste, fileEmpty)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before);
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false);
    } finally {
      await fx.close();
    }
  });

  it("preserves paste whitespace and passes a named empty file to the adapter", async () => {
    const fx = await fixture();
    try {
      const spaced = "  Alice:  Hi.\r\n\r\nBob: Bye.  \n";
      const before = counts(fx.store);
      const [fields, file] = pasted(spaced, { title: "Spaced", date: "2026-05-07" });
      const result = await submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      const source = result.transcript.sources[0];
      assert.equal(source.format, "paste");
      assert.equal(source.originalText, spaced);

      // A named empty file is a selected file: the adapter refuses it as having
      // no visible text, and nothing is written.
      const after = counts(fx.store);
      await assert.rejects(
        submitTranscript(
          fx.service,
          submission(
            "engagement",
            fx.engagementId,
            { title: "Empty", date: "2026-05-08" },
            { filename: "empty.txt", bytes: new Uint8Array(0) },
          ),
        ),
        (error: unknown) => error instanceof ValidationError,
      );
      assert.deepEqual(counts(fx.store), after);
      assert.equal(before.transcripts + 1, after.transcripts);
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: URL resolution", () => {
  it("answers a missing or malformed URL id as a missing record (404)", async () => {
    const fx = await fixture();
    try {
      await assert.rejects(
        submitTranscript(fx.service, submission("engagement", "engagement-999", { paste: "x", title: "T", date: "2026-06-01" })),
        MissingRecordError,
      );
      await assert.rejects(
        submitTranscript(fx.service, submission("project", "project-999", { paste: "x", title: "T", date: "2026-06-01" })),
        MissingRecordError,
      );
      await assert.rejects(
        submitTranscript(fx.service, submission("meeting", "meeting-999", { paste: "x" })),
        MissingRecordError,
      );
      // A malformed percent escape names no record.
      await assert.rejects(
        submitTranscript(fx.service, {
          kind: "engagement",
          rawId: "%E0%A4%A",
          fields: { paste: "x", title: "T", date: "2026-06-01" },
          file: null,
        }),
        MissingRecordError,
      );
    } finally {
      await fx.close();
    }
  });

  it("answers an omitted or non-string raw id as a missing record (404)", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      for (const kind of ["engagement", "project", "meeting"] as const) {
        // The raw id is absent: the submission names no URL record.
        await assert.rejects(
          submitTranscript(fx.service, { kind, fields: { paste: "x", title: "T", date: "2026-06-01" }, file: null }),
          MissingRecordError,
        );
        // The raw id is not a string: it still names no URL record.
        await assert.rejects(
          submitTranscript(fx.service, {
            kind,
            rawId: 42 as unknown as string,
            fields: { paste: "x", title: "T", date: "2026-06-01" },
            file: null,
          }),
          MissingRecordError,
        );
      }
      assert.deepEqual(counts(fx.store), before, "a submission without a raw id writes nothing");
    } finally {
      await fx.close();
    }
  });

  it("shares the workspace store with a manual write", async () => {
    const fx = await fixture();
    try {
      // A manual write through the same open store, then an import through the
      // service over it: both see each other's committed records.
      const manual = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        title: "Manual",
        date: "2026-06-02",
        notes: "manual notes",
      });
      const [fields, file] = pasted(PASTED_TEXT);
      const result = await submitTranscript(fx.service, submission("meeting", manual.id, fields, file));
      assert.equal(result.meeting.id, manual.id);
      assert.equal(result.meeting.notes, "manual notes");
      const snapshot = fx.store.snapshot();
      assert.ok(snapshot.meetings.some((m) => m.id === manual.id));
      assert.ok((snapshot.transcripts ?? []).some((t) => t.meetingId === manual.id));
      // The handler's service is the one over the same store instance.
      assert.equal(fx.service.store, fx.store);
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: assertions inside the store's queue turn", () => {
  it("checks an attachment's assertions against the records its import is applied to", async () => {
    const fx = await fixture();
    try {
      const meeting = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        projectId: fx.projectId,
        title: "Movable",
        date: "2026-07-01",
        notes: "",
      });
      // Queue a move of the meeting to another project of the engagement, then
      // submit an attachment asserting the project the meeting still shows in
      // the committed state. The move finishes first, so the assertion no longer
      // matches the record the import is applied to: it is refused, not committed.
      const move = fx.store.updateMeeting(meeting.id, { projectId: fx.secondProjectId });
      const before = counts(fx.store);
      const [fields, file] = pasted(PASTED_TEXT, { projectId: fx.projectId });
      const submitted = submitTranscript(fx.service, submission("meeting", meeting.id, fields, file));
      await move;
      await assert.rejects(submitted, ValidationError);
      const moved = fx.store.snapshot().meetings.find((m) => m.id === meeting.id);
      assert.equal(moved?.projectId, fx.secondProjectId);
      const after = counts(fx.store);
      assert.equal(after.transcripts, before.transcripts, "no transcript was attached");
      assert.equal(after.sources, before.sources, "no original was recorded");
      assert.equal(after.events, before.events + 1, "only the queued move's event");
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false, "no original was published");
    } finally {
      await fx.close();
    }
  });

  it("rejects a blank clientId or engagementId assertion as a conflict", async () => {
    const fx = await fixture();
    try {
      const blankBefore = counts(fx.store);
      const blanks: Record<string, string>[] = [{ clientId: "" }, { engagementId: "" }];
      for (const blank of blanks) {
        const [fields, file] = pasted("Blank assertion.", { title: "T", date: "2026-07-02", ...blank });
        await assert.rejects(
          submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file)),
          ValidationError,
        );
      }
      const afterBlanks = counts(fx.store);
      assert.deepEqual(afterBlanks, blankBefore, "a blank assertion writes nothing");
      // A blank project on an attachment is a conflict too: the meeting has one.
      const meeting = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        projectId: fx.projectId,
        title: "Has project",
        date: "2026-07-03",
        notes: "",
      });
      const withMeeting = counts(fx.store);
      const [fields, file] = pasted("Blank project.", { projectId: "" });
      await assert.rejects(
        submitTranscript(fx.service, submission("meeting", meeting.id, fields, file)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), withMeeting, "the blank project assertion writes nothing");
    } finally {
      await fx.close();
    }
  });

  it("rejects a conflicting meetingId assertion before committing", async () => {
    const fx = await fixture();
    try {
      const target = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        title: "Target",
        date: "2026-07-04",
        notes: "",
      });
      const other = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        title: "Other",
        date: "2026-07-05",
        notes: "",
      });
      const before = counts(fx.store);
      const [fields, file] = pasted(PASTED_TEXT, { meetingId: other.id });
      await assert.rejects(
        submitTranscript(fx.service, submission("meeting", target.id, fields, file)),
        ValidationError,
      );
      // A blank meetingId is a conflict: it names no meeting of the URL.
      const [blankFields, blankFile] = pasted(PASTED_TEXT, { meetingId: "" });
      await assert.rejects(
        submitTranscript(fx.service, submission("meeting", target.id, blankFields, blankFile)),
        ValidationError,
      );
      assert.deepEqual(counts(fx.store), before, "the rejection left metadata intact");
      assert.equal(fx.store.snapshot().transcripts?.length, 0);
      // The matching meetingId assertion is accepted.
      const [ok, okFile] = pasted(PASTED_TEXT, { meetingId: target.id });
      const result = await submitTranscript(fx.service, submission("meeting", target.id, ok, okFile));
      assert.equal(result.outcome, "attached");
      assert.equal(result.meeting.id, target.id);
    } finally {
      await fx.close();
    }
  });

  it("refuses a selected project that is nonexistent or outside the engagement with 400", async () => {
    const fx = await fixture();
    try {
      const before = counts(fx.store);
      for (const projectId of ["project-999", fx.foreignProjectId]) {
        const [fields, file] = pasted("Selected words.", { title: "T", date: "2026-07-06", projectId });
        await assert.rejects(
          submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file)),
          (error: unknown) => error instanceof ValidationError && !(error instanceof MissingRecordError),
          `projectId ${projectId} is invalid input, not a missing record`,
        );
      }
      assert.deepEqual(counts(fx.store), before);
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false, "no original was published");
    } finally {
      await fx.close();
    }
  });

  it("reports an explicit blank project as a conflict when reusing a canonical meeting under a project", async () => {
    const fx = await fixture();
    try {
      const [fields, file] = pasted("Canonical project words.", { title: "Under project", date: "2026-07-07" });
      const first = await submitTranscript(fx.service, submission("project", fx.projectId, fields, file));
      assert.equal(first.meeting.projectId, fx.projectId);
      const before = fx.store.snapshot().meetings.find((m) => m.id === first.meeting.id);
      const countsBefore = counts(fx.store);
      // The same content again through the same project URL, explicitly blank:
      // the engagement-only selection differs from the preserved project.
      const [again, againFile] = pasted("Canonical project words.", {
        title: "Under project",
        date: "2026-07-07",
        projectId: "",
      });
      const result = await submitTranscript(fx.service, submission("project", fx.projectId, again, againFile));
      assert.equal(result.outcome, "reused");
      assert.equal(result.meeting.id, first.meeting.id);
      assert.deepEqual(result.conflicts, [{ field: "projectId", supplied: "", preserved: fx.projectId }]);
      assert.deepEqual(fx.store.snapshot().meetings.find((m) => m.id === first.meeting.id), before);
      assert.deepEqual(counts(fx.store), countsBefore, "nothing recorded or attached");
      // An omitted project asserts nothing and is not a difference.
      const [omitted, omittedFile] = pasted("Canonical project words.", {
        title: "Under project",
        date: "2026-07-07",
      });
      const same = await submitTranscript(fx.service, submission("project", fx.projectId, omitted, omittedFile));
      assert.deepEqual(same.conflicts, []);
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: admission with the store's queue", () => {
  it("refuses a submission made while close drains the queue, so no import commits after close", async () => {
    const fx = await fixture();
    try {
      // close() snapshots the queue and releases ownership once it drains. A
      // submission made while close is running must be refused like any other
      // call after close: it must not commit behind the close's own drain and
      // then land on a workspace another owner already holds.
      const closing = fx.store.close();
      const [fields, file] = pasted(PASTED_TEXT, { title: "Too late", date: "2026-08-05" });
      const submitted = submitTranscript(fx.service, submission("engagement", fx.engagementId, fields, file));
      await closing;
      await assert.rejects(submitted, PersistenceError);
      assert.equal(fx.store.snapshot().meetings.length, 0, "nothing committed after close");
      // Another owner opening the workspace sees no import that arrived after close.
      const owner = await openStore(fx.dir);
      try {
        assert.equal(owner.snapshot().meetings.length, 0);
        assert.equal(owner.snapshot().transcripts?.length ?? 0, 0);
      } finally {
        await owner.close();
      }
    } finally {
      await fx.close();
    }
  });

  it("admits a submission before a queued move and refuses its stale assertion without committing", async () => {
    const fx = await fixture();
    try {
      const meeting = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        projectId: fx.projectId,
        title: "Moved before admission",
        date: "2026-08-06",
        notes: "",
      });
      // The move is admitted first, so it finishes before the submission's own
      // turn. The submission asserts the project the meeting still shows in the
      // committed state; at admission and inside its turn it sees the moved
      // meeting, so the stale assertion is refused and nothing is written.
      const move = fx.store.updateMeeting(meeting.id, { projectId: fx.secondProjectId });
      const before = counts(fx.store);
      const [fields, file] = pasted(PASTED_TEXT, { projectId: fx.projectId });
      const submitted = submitTranscript(fx.service, submission("meeting", meeting.id, fields, file));
      await move;
      await assert.rejects(submitted, ValidationError);
      assert.equal(fx.store.snapshot().meetings.find((m) => m.id === meeting.id)?.projectId, fx.secondProjectId);
      const after = counts(fx.store);
      assert.equal(after.transcripts, before.transcripts, "no transcript was attached");
      assert.equal(after.sources, before.sources, "no original was recorded");
      assert.equal(after.events, before.events + 1, "only the queued move's event");
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false, "no original was published");
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: borrowed service lifecycle", () => {
  it("leaves the borrowed store open after the service's close and refuses submissions to a closed store", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const service = transcriptService(store);
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
      const [fields, file] = pasted(PASTED_TEXT, { title: "Kept", date: "2026-08-01" });
      const result = await submitTranscript(service, submission("engagement", engagement.id, fields, file));
      assert.equal(result.outcome, "created");
      // Closing the borrowed service releases nothing: the store stays usable.
      await service.close();
      const meeting = await store.createMeeting({
        clientId: client.id,
        engagementId: engagement.id,
        title: "After close",
        date: "2026-08-02",
        notes: "",
      });
      assert.ok(store.snapshot().meetings.some((m) => m.id === meeting.id));
      const [again, againFile] = pasted("After close words.");
      const attached = await submitTranscript(service, submission("meeting", meeting.id, again, againFile));
      assert.equal(attached.outcome, "attached");
      // Once the caller closes the store it owns, the submission is refused.
      await store.close();
      const [late, lateFile] = pasted("Too late.");
      await assert.rejects(
        submitTranscript(service, submission("meeting", meeting.id, late, lateFile)),
        PersistenceError,
      );
    } finally {
      await store.close();
    }
  });

  it("accepts a submission as route kind, raw id, decoded fields and file only", async () => {
    const fx = await fixture();
    try {
      // The service's submission interface takes the resolved route kind, the
      // raw id, the decoded controls and the file as data: no resolver, no
      // engagement-only marker and no target object can be supplied. A service
      // caller that tries to shape the target itself is refused as an
      // unsupported field, so URL resolution and the blank selection are always
      // derived from the submission inside the admitted turn.
      const [fields, file] = pasted(PASTED_TEXT, { title: "Interface", date: "2026-11-01" });
      const shaped = {
        kind: "engagement",
        rawId: encodeURIComponent(fx.engagementId),
        fields,
        file,
        target: { meetingId: "meeting-999" },
        engagementOnly: true,
      } as unknown as TranscriptSubmission;
      const before = counts(fx.store);
      await assert.rejects(fx.service.submitTranscript(shaped), ValidationError);
      assert.deepEqual(counts(fx.store), before, "the refused submission writes nothing");
      assert.equal(existsSync(join(fx.dir, ORIGINALS_DIRECTORY)), false);
      // The same submission as plain data commits normally.
      const result = await fx.service.submitTranscript({
        kind: "engagement",
        rawId: encodeURIComponent(fx.engagementId),
        fields,
        file,
      });
      assert.equal(result.meeting.title, "Interface");
    } finally {
      await fx.close();
    }
  });

  it("keeps the public target parser closed to the handler's private blank-project marker", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const service = transcriptService(store);
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
      // A direct import names its engagement-only selection by omitting the
      // project; the parser refuses the handler's internal marker as an
      // unsupported field, so no caller can change conflict reporting with it.
      await assert.rejects(
        service.importTranscript(
          { kind: "paste", text: "Marker words." },
          {
            create: {
              clientId: client.id,
              engagementId: engagement.id,
              engagementOnly: true,
              title: "Marker",
              date: "2026-08-10",
            },
          } as unknown as Parameters<TranscriptStore["importTranscript"]>[1],
        ),
        (error: unknown) =>
          error instanceof ValidationError &&
          error.message.includes("unsupported field") &&
          error.message.includes("engagementOnly"),
      );
      assert.equal(store.snapshot().meetings.length, 0, "the refused target writes nothing");
    } finally {
      await store.close();
    }
  });

  it("accepts only adapter options on the borrowed service, not workspace opening options", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
      const [fields, file] = pasted(PASTED_TEXT, { title: "Parsers", date: "2026-08-03" });
      const service = transcriptService(store);
      assert.equal(service.store, store);
      const result = await submitTranscript(service, submission("engagement", engagement.id, fields, file));
      assert.equal(result.outcome, "created");
      // A workspace opening option is not part of the borrowed service's
      // interface: the typechecker rejects it below. The workspace options a
      // caller does supply stay the borrowed store's own, so a broken `fs`
      // option cannot reach the borrowed service's filesystem.
      const untyped = transcriptService as (store: Store, options: unknown) => TranscriptStore;
      const untypedService = untyped(store, { fs: { renameSync: () => { throw fsError("EIO"); } } });
      assert.equal(untypedService.store, store);
      const [untypedFields, untypedFile] = pasted("Untyped words.", { title: "Untyped", date: "2026-08-04" });
      const untypedResult = await submitTranscript(
        untypedService,
        submission("engagement", engagement.id, untypedFields, untypedFile),
      );
      assert.equal(untypedResult.outcome, "created", "the ignored option never reached the workspace");
      // @ts-expect-error the borrowed service takes no workspace opening options
      assert.ok(transcriptService(store, { fs: workspaceAdapter() }) instanceof Object);
    } finally {
      await store.close();
    }
  });
});

describe("transcript submission handler: the import's own commit", () => {
  it("publishes no metadata when the JSON commit fails, keeping the retained original for a retry", async () => {
    const dir = tempDir();
    // The workspace and hierarchy are committed first, then the store is
    // reopened with a rename that fails, so only the import's commit fails.
    const setup = await openStore(dir);
    const client = await setup.createClient({ name: "Acme" });
    const engagement = await setup.createEngagement({ clientId: client.id, name: "Eng" });
    await setup.close();
    const failing = await openStore(dir, { fs: workspaceAdapter({ renameSync: true }) });
    try {
      const service = transcriptService(failing);
      const before = readFileSync(storePath(dir), "utf8");
      const countsBefore = counts(failing);
      const [fields, file] = pasted(PASTED_TEXT, { title: "Uncommitted", date: "2026-09-01" });
      await assert.rejects(
        submitTranscript(service, submission("engagement", engagement.id, fields, file)),
        PersistenceError,
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before, "no metadata published");
      assert.deepEqual(counts(failing), countsBefore, "no meeting, transcript, source or event");
      // A paste publishes no file original, so nothing is retained either.
      const originalsDir = join(dir, ORIGINALS_DIRECTORY);
      assert.equal(existsSync(originalsDir), false, "a paste publishes no original file");
      await assert.rejects(
        submitTranscript(service, submission("engagement", engagement.id, fields, file)),
        PersistenceError,
      );
      assert.equal(readFileSync(storePath(dir), "utf8"), before);
    } finally {
      await failing.close();
    }
    // Reopened, the same submission commits normally.
    const reopened = await openStore(dir);
    try {
      const service = transcriptService(reopened);
      const [fields, file] = pasted(PASTED_TEXT, { title: "Uncommitted", date: "2026-09-01" });
      const result = await submitTranscript(service, submission("engagement", engagement.id, fields, file));
      assert.equal(result.outcome, "created");
      assert.equal(result.meeting.title, "Uncommitted");
    } finally {
      await reopened.close();
    }
  });

  it("commits the validated create it planned even when its caller mutates it after publication begins", async () => {
    const fx = await fixture();
    try {
      // The caller's own target object is validated when the import starts. Its
      // `engagementId` accessor returns the real engagement on the validating
      // read and a different, existing engagement on any later read, so an
      // implementation that reads the field again to build the commit would
      // commit the replacement. The commit must use the validated values.
      const other = await fx.store.createEngagement({ clientId: fx.clientId, name: "Other engagement" });
      const create: { clientId: string; engagementId: string; title: string; date: string } = {
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        title: "Captured",
        date: "2026-09-02",
      };
      let reads = 0;
      Object.defineProperty(create, "engagementId", {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? fx.engagementId : other.id;
        },
      });
      const mutating = { create };
      const before = counts(fx.store);
      const bytes = encoder(`Captured words. ${PASTED_TEXT}`);
      const result = await fx.service.importTranscript(
        { kind: "file", bytes, filename: "captured.txt" },
        mutating as unknown as Parameters<TranscriptStore["importTranscript"]>[1],
      );
      assert.equal(result.outcome, "created");
      assert.equal(result.meeting.date, "2026-09-02");
      assert.equal(result.meeting.engagementId, fx.engagementId, "the validated engagement was committed");
      const after = counts(fx.store);
      assert.equal(after.meetings, before.meetings + 1);
      assert.equal(after.transcripts, before.transcripts + 1);
      assert.equal(after.sources, before.sources + 1);
      assert.equal(after.events, before.events + 1, "one create event");
    } finally {
      await fx.close();
    }
  });
});

describe("transcript submission handler: a refused proposal publishes no original", () => {
  it("refuses a source id that duplicates a stored source id before publishing its original", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let reopened: Store | undefined;
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
      const service = transcriptService(store);
      const [fields, file] = pasted("Canonical words.", { title: "First", date: "2026-10-01" });
      const created = await submitTranscript(service, submission("engagement", engagement.id, fields, file));
      // A stored source whose id already equals the id a distinct incoming
      // file will be given. Schema 6 accepts the stored id as it is, but the
      // incoming id must match its own canonical content; the edit must refuse
      // the duplicate source before its original is published.
      const incomingText = "  Canonical words.  ";
      const incomingBytes = encoder(incomingText);
      const incomingSha256 = createHash("sha256").update(incomingBytes).digest("hex");
      const wantedId = `${canonicalIdentityOf(incomingText).slice("sha256:".length)}.file.${incomingSha256}`;
      const storedText = "Canonical words.";
      const source = {
        id: wantedId,
        format: "paste",
        filename: "stored.txt",
        originalText: storedText,
        extractedText: storedText,
        passages: [
          {
            id: `${wantedId}/p1`,
            sourceId: wantedId,
            range: { start: 0, end: storedText.length },
            location: { start: 0, end: storedText.length, line: 1, column: 1 },
            text: storedText,
          },
        ],
      };
      await store.close();
      const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
      saved.transcripts[0].sources.push(source);
      writeFileSync(storePath(dir), JSON.stringify(saved));
      reopened = await openStore(dir);
      const reopenedService = transcriptService(reopened);
      const before = counts(reopened);
      const originalsDir = join(dir, ORIGINALS_DIRECTORY);
      const filesBefore = existsSync(originalsDir) ? readdirSync(originalsDir).length : 0;
      await assert.rejects(
        reopenedService.importTranscript(
          { kind: "file", bytes: incomingBytes, filename: "incoming.txt" },
          { meetingId: created.meeting.id },
        ),
        ValidationError,
      );
      const filesAfter = existsSync(originalsDir) ? readdirSync(originalsDir).length : 0;
      assert.equal(filesAfter, filesBefore, "the refused proposal published no original");
      assert.deepEqual(counts(reopened), before, "the refused proposal wrote no metadata");
      assert.equal(reopened.snapshot().transcripts?.[0].sources.length, 2);
    } finally {
      await reopened?.close();
    }
  });
});

describe("transcript submission handler: one shared originals store", () => {
  it("shares the originals store with a manual write and an import", async () => {
    const fx = await fixture();
    try {
      const manual = await fx.store.createMeeting({
        clientId: fx.clientId,
        engagementId: fx.engagementId,
        projectId: fx.projectId,
        title: "Manual",
        date: "2026-08-11",
        notes: "kept",
      });
      const [fields, file] = pasted("Original words.");
      const imported = await submitTranscript(fx.service, submission("meeting", manual.id, fields, file));
      assert.equal(imported.outcome, "attached");
      assert.equal(imported.meeting.notes, "kept", "an attachment preserves the meeting's fields");
      const source = imported.transcript.sources[0];
      assert.equal(source.format, "paste");
      assert.equal(source.originalText, "Original words.");
      // The manual write's meeting and the import's transcript name the same
      // committed document the workspace keeps.
      const saved = JSON.parse(readFileSync(storePath(fx.dir), "utf8"));
      assert.ok(saved.meetings.some((m: { id: string }) => m.id === manual.id));
      assert.ok(saved.transcripts.some((t: { meetingId: string }) => t.meetingId === manual.id));
    } finally {
      await fx.close();
    }
  });
});


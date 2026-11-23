import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openStore, PersistenceError, type Snapshot } from "../src/store.ts";
import { importPastedText, type ImportResult } from "../src/transcript.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-storage-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

/** A pasted transcript core result; the text is the authority for its passages. */
function imported(text: string): ImportResult {
  const outcome = importPastedText(text);
  assert.equal(outcome.ok, true, "the sample text imports");
  return (outcome as { ok: true; result: ImportResult }).result;
}

const PASTED_TEXT =
  "Alice: Hello there.\n\nBob: Hi, how are you?\n\nAlice: Fine, thanks.";

/** A transcript as the store writes it, from a pasted import and a meeting. */
function storedTranscript(meetingId: string, text: string = PASTED_TEXT) {
  const result = imported(text);
  return {
    id: result.id,
    canonicalText: result.canonicalText,
    meetingId,
    sources: [
      {
        id: result.id,
        format: result.format,
        filename: result.filename,
        originalText: result.originalText,
        extractedText: result.extractedText,
        passages: result.passages.map((passage) => ({ ...passage })),
      },
    ],
  };
}

/** The base document of one meeting at a given schema version. */
function documentWithMeeting(schemaVersion: number): Record<string, unknown> {
  return {
    schemaVersion,
    clients: [
      {
        id: "client-1",
        name: "Acme",
        background: "",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      },
    ],
    engagements: [
      { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
    ],
    projects: [
      { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned" },
    ],
    tasks: [],
    items: [],
    meetings: [
      {
        id: "meeting-1",
        clientId: "client-1",
        engagementId: "engagement-1",
        title: "Kickoff",
        date: "2026-01-01",
        notes: "",
      },
    ],
    activity: [],
    nextActivityId: 1,
    nextIds: { clients: 2, engagements: 2, projects: 2, meetings: 2 },
    transcripts: [],
  };
}

/** Write a document, expect opening to fail with PersistenceError, keep the file. */
async function assertRefused(dir: string, value: unknown, pattern?: RegExp): Promise<void> {
  const content = JSON.stringify(value);
  writeFileSync(storePath(dir), content, "utf8");
  await assert.rejects(openStore(dir), (error: unknown) => {
    assert.ok(error instanceof PersistenceError, `expected PersistenceError, got ${String(error)}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
  assert.equal(readFileSync(storePath(dir), "utf8"), content, "stored file left untouched");
  assert.equal(existsSync(join(dir, "workspace.lock")), false, "lock released");
}

/** Deep clone a document with an override, without sharing mutable arrays. */
function withTranscripts(document: Record<string, unknown>, transcripts: unknown): Record<string, unknown> {
  return { ...structuredClone(document), transcripts };
}

describe("transcript storage: schema 6 round trips", () => {
  it("writes a schema 6 document and reads the same transcript back after restart", async () => {
    const dir = tempDir();
    const document = withTranscripts(documentWithMeeting(6), [storedTranscript("meeting-1")]);
    const content = JSON.stringify(document);
    writeFileSync(storePath(dir), content, "utf8");

    const store = await openStore(dir);
    try {
      const transcripts = store.snapshot().transcripts!;
      assert.equal(transcripts.length, 1);
      assert.deepEqual(transcripts[0], storedTranscript("meeting-1"));
      // The snapshot is detached and frozen.
      assert.ok(Object.isFrozen(transcripts));
      assert.ok(Object.isFrozen(transcripts[0]));
      assert.ok(Object.isFrozen(transcripts[0].sources[0].passages[0]));
      // Opening never rewrites the file.
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
    } finally {
      await store.close();
    }

    // An ordinary meeting edit keeps the transcript and its source content.
    const saving = await openStore(dir, { now: () => new Date("2026-02-03T04:05:06.007Z") });
    try {
      await saving.updateMeeting("meeting-1", { title: "Renamed" });
      assert.deepEqual(saving.snapshot().transcripts, [storedTranscript("meeting-1")]);
    } finally {
      await saving.close();
    }

    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 6);
    assert.deepEqual(saved.transcripts, [storedTranscript("meeting-1")]);
    assert.equal(saved.meetings[0].title, "Renamed");
    // The pasted original is a separate JSON string, never base64.
    assert.equal(saved.transcripts[0].sources[0].originalText, PASTED_TEXT);
    assert.equal("originalBytes" in saved.transcripts[0].sources[0], false);

    const reopened = await openStore(dir);
    try {
      assert.deepEqual(reopened.snapshot().transcripts, [storedTranscript("meeting-1")]);
    } finally {
      await reopened.close();
    }
  });

  it("stores a file original as a hash reference and the pasted original as text", async () => {
    const dir = tempDir();
    const result = imported(PASTED_TEXT);
    // A file original names its bytes by hash and length, never base64.
    const fileSource = {
      id: result.id,
      format: "txt",
      filename: "kickoff.txt",
      originalSha256: result.originalSha256,
      originalLength: result.originalBytes.length,
      extractedText: result.extractedText,
      passages: result.passages.map((passage) => ({ ...passage })),
    };
    const document = withTranscripts(documentWithMeeting(6), [
      { id: result.id, canonicalText: result.canonicalText, meetingId: "meeting-1", sources: [fileSource] },
    ]);
    writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
    const store = await openStore(dir);
    try {
      const source = store.snapshot().transcripts![0].sources[0];
      assert.equal(source.originalSha256, result.originalSha256);
      assert.equal(source.originalLength, result.originalBytes.length);
      assert.equal(source.originalText, undefined);
      assert.equal(source.extractedText, result.extractedText);
      // Stored source and passage ids load exactly as written.
      assert.deepEqual(
        source.passages.map((passage) => passage.id),
        result.passages.map((passage) => passage.id),
      );
    } finally {
      await store.close();
    }
  });

  it("keeps stored source and passage ids rather than regenerating them", async () => {
    const dir = tempDir();
    const transcript = structuredClone(storedTranscript("meeting-1"));
    // The ids are the stored identities; the validators do not rename them.
    transcript.sources[0].passages[0].id = `${transcript.id}/first`;
    transcript.sources[0].passages[1].id = `${transcript.id}/second`;
    transcript.sources[0].passages[2].id = `${transcript.id}/third`;
    writeFileSync(storePath(dir), JSON.stringify(withTranscripts(documentWithMeeting(6), [transcript])), "utf8");
    const store = await openStore(dir);
    try {
      const ids = store.snapshot().transcripts![0].sources[0].passages.map((p) => p.id);
      assert.deepEqual(ids, [`${transcript.id}/first`, `${transcript.id}/second`, `${transcript.id}/third`]);
    } finally {
      await store.close();
    }
  });
});

describe("transcript storage: strict refusal of malformed metadata", () => {
  it("refuses malformed transcript fields without rewriting the file", async () => {
    const dir = tempDir();
    const base = documentWithMeeting(6);
    const good = storedTranscript("meeting-1");
    const badCases: unknown[] = [
      // Not an array / not objects.
      withTranscripts(base, {}),
      withTranscripts(base, [{ ...good, extra: true }]),
      withTranscripts(base, [{ ...good, id: "not-an-identity" }]),
      withTranscripts(base, [{ ...good, canonicalText: "not the content" }]),
      withTranscripts(base, [{ ...good, meetingId: "" }]),
      withTranscripts(base, [{ ...good, sources: [] }]),
      // A source that names a different source than the transcript.
      withTranscripts(base, [{
        ...good,
        sources: [{ ...good.sources[0], id: "sha256:" + "0".repeat(64) }],
      }]),
      // A pasted source that also names a file hash is inconsistent; the
      // pasted shape refuses the extra fields, so the kinds never mix.
      withTranscripts(base, [{
        ...good,
        sources: [{ ...good.sources[0], originalSha256: "0".repeat(64), originalLength: 1 }],
      }]),
      // A malformed file hash.
      withTranscripts(base, [{
        ...good,
        sources: [{
          id: good.id,
          format: "txt",
          filename: "f.txt",
          originalSha256: "ABC",
          originalLength: 3,
          extractedText: good.sources[0].extractedText,
          passages: good.sources[0].passages,
        }],
      }]),
      // Malformed transcript list entries.
      withTranscripts(base, [null]),
      withTranscripts(base, ["transcript"]),
    ];
    for (const value of badCases) {
      await assertRefused(dir, value);
    }
  });

  it("refuses duplicate transcript identities", async () => {
    const dir = tempDir();
    const good = storedTranscript("meeting-1");
    await assertRefused(
      dir,
      withTranscripts(documentWithMeeting(6), [good, structuredClone(good)]),
      /duplicate/,
    );
  });

  it("refuses duplicate engagement canonical content across distinct originals", async () => {
    const dir = tempDir();
    const document = documentWithMeeting(6);
    // A second meeting in the same engagement, then two transcripts with the
    // same canonical content but different originals (line endings differ).
    (document.meetings as unknown[]).push({
      id: "meeting-2",
      clientId: "client-1",
      engagementId: "engagement-1",
      title: "Second",
      date: "2026-01-02",
      notes: "",
    });
    (document.nextIds as Record<string, number>).meetings = 3;
    const first = storedTranscript("meeting-1", PASTED_TEXT);
    // The same words with CRLF line endings: distinct original bytes, the same
    // canonical content.
    const second = storedTranscript("meeting-2", PASTED_TEXT.replace(/\n/g, "\r\n"));
    // The originals differ (different line endings) while the canonical content
    // collapses identically, so the two transcripts share a canonical identity:
    // one canonical transcript per engagement, never two.
    assert.notEqual(first.sources[0].originalText, second.sources[0].originalText);
    assert.equal(first.canonicalText, second.canonicalText);
    assert.equal(first.id, second.id);
    await assertRefused(
      dir,
      withTranscripts(document, [first, second]),
      /duplicate|two engagements/,
    );

    // The same content in a different engagement is not a clash: the second
    // client and engagement have their own transcript of the same content.
    const elsewhere = structuredClone(document);
    (elsewhere.clients as unknown[]).push({
      id: "client-2",
      name: "Other",
      background: "",
      contacts: "",
      stakeholders: "",
      requirements: "",
      objectives: "",
    });
    (elsewhere.engagements as unknown[]).push({
      id: "engagement-2",
      clientId: "client-2",
      name: "E2",
      objectives: "",
      status: "planned",
    });
    (elsewhere.meetings as Record<string, unknown>[])[0].clientId = "client-2";
    (elsewhere.meetings as Record<string, unknown>[])[0].engagementId = "engagement-2";
    (elsewhere.nextIds as Record<string, number>).clients = 3;
    (elsewhere.nextIds as Record<string, number>).engagements = 3;
    writeFileSync(storePath(dir), JSON.stringify(withTranscripts(elsewhere, [first])), "utf8");
    const store = await openStore(dir);
    try {
      assert.deepEqual(store.snapshot().transcripts![0].canonicalText, first.canonicalText);
    } finally {
      await store.close();
    }
  });

  it("refuses a transcript whose meeting is missing", async () => {
    const dir = tempDir();
    await assertRefused(
      dir,
      withTranscripts(documentWithMeeting(6), [storedTranscript("meeting-9")]),
      /missing meeting/,
    );
  });

  it("refuses invalid passage bounds, mismatched text and stored ids", async () => {
    const dir = tempDir();
    const base = documentWithMeeting(6);
    const good = storedTranscript("meeting-1");
    const mutated = (mutate: (passage: Record<string, unknown>) => void) => {
      const copy = structuredClone(good);
      mutate(copy.sources[0].passages[0] as unknown as Record<string, unknown>);
      return withTranscripts(base, [copy]);
    };
    const bad: unknown[] = [
      // A range past the end of the extracted text.
      mutated((p) => {
        (p.range as Record<string, number>).end = 10_000;
        (p.location as Record<string, number>).end = 10_000;
      }),
      // A range whose text does not match.
      mutated((p) => {
        (p.range as Record<string, number>).start = 1;
        (p.location as Record<string, number>).start = 1;
      }),
      // A location line that is not the real line.
      mutated((p) => {
        (p.location as Record<string, number>).line = 2;
      }),
      // A passage naming a different source than the source it sits in.
      mutated((p) => {
        p.sourceId = "sha256:" + "0".repeat(64);
      }),
      // A duplicated stored passage id.
      withTranscripts(base, [(() => {
        const copy = structuredClone(good);
        copy.sources[0].passages[1].id = copy.sources[0].passages[0].id;
        return copy;
      })()]),
      // Overlapping passages: the second begins inside the first.
      withTranscripts(base, [(() => {
        const copy = structuredClone(good);
        const passages = copy.sources[0].passages;
        const second = passages[1] as unknown as Record<string, unknown>;
        second.range = { start: 5, end: second.range ? (second.range as Record<string, number>).end : 42 };
        second.location = { start: 5, end: (second.range as Record<string, number>).end, line: 1, column: 6 };
        second.text = PASTED_TEXT.slice(5, (second.range as Record<string, number>).end).trim();
        return copy;
      })()]),
    ];
    for (const value of bad) {
      await assertRefused(dir, value);
    }
  });

  it("refuses a source whose extracted text disagrees with its identity", async () => {
    const dir = tempDir();
    const good = storedTranscript("meeting-1");
    const copy = structuredClone(good);
    const source = copy.sources[0];
    // Change the extracted text, and the pasted original with it, so the source
    // is internally consistent but no longer the content its stored id names.
    // The transcript's canonical text still names the old content.
    source.extractedText = "Bob: Hi, how are you?\n\nAlice: Fine, well.";
    source.originalText = source.extractedText;
    const retexted = imported(source.extractedText);
    assert.notEqual(retexted.canonicalText, copy.canonicalText);
    source.passages = retexted.passages.map((passage) => ({ ...passage }));
    await assertRefused(dir, withTranscripts(documentWithMeeting(6), [copy]), /canonical content/);
  });
});

describe("transcript storage: source consistency", () => {
  it("refuses a source whose extracted text is not the transcript's canonical content", async () => {
    const dir = tempDir();
    const copy = structuredClone(storedTranscript("meeting-1"));
    // Another, unrelated text as the transcript's second source.
    const other = imported("Charlie: Something else entirely.");
    copy.sources.push({
      id: copy.id,
      format: other.format,
      filename: other.filename,
      originalText: other.originalText,
      extractedText: other.extractedText,
      passages: other.passages.map((passage) => ({ ...passage })),
    });
    await assertRefused(dir, withTranscripts(documentWithMeeting(6), [copy]), /canonical content/);
  });

  it("refuses sources whose formats differ from one another", async () => {
    const dir = tempDir();
    // A second source of the same content imported from a file, with a PDF
    // format, cannot sit beside the pasted source.
    const result = imported(PASTED_TEXT);
    const copy = structuredClone(storedTranscript("meeting-1"));
    (copy.sources as unknown[]).push({
      id: copy.id,
      format: "pdf",
      filename: "kickoff.pdf",
      originalSha256: result.originalSha256,
      originalLength: result.originalBytes.length,
      extractedText: result.extractedText,
      passages: result.passages.map((passage) => ({ ...passage })),
    });
    await assertRefused(dir, withTranscripts(documentWithMeeting(6), [copy]), /format/);
  });

  it("refuses a source whose original length is outside the content limit", async () => {
    const dir = tempDir();
    const result = imported(PASTED_TEXT);
    const copy = storedTranscript("meeting-1");
    const fileSource = {
      id: result.id,
      format: "txt",
      filename: "kickoff.txt",
      originalSha256: result.originalSha256,
      originalLength: 10 * 1024 * 1024 + 1,
      extractedText: result.extractedText,
      passages: result.passages.map((passage) => ({ ...passage })),
    };
    assert.deepEqual(copy.sources[0].id, result.id);
    await assertRefused(
      dir,
      withTranscripts(documentWithMeeting(6), [
        { id: result.id, canonicalText: result.canonicalText, meetingId: "meeting-1", sources: [fileSource] },
      ]),
      /originalLength/,
    );
  });
});

describe("transcript storage: legacy documents and opening", () => {
  it("reads schemas 1, 3, 4 and 5 with no transcripts and does not rewrite them", async () => {
    const documents: unknown[] = [
      {
        schemaVersion: 1,
        clients: [
          { id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
        ],
        engagements: [],
        projects: [],
        nextIds: { clients: 2 },
      },
      {
        schemaVersion: 3,
        clients: [],
        engagements: [],
        projects: [],
        tasks: [],
        items: [],
        meetings: [],
        nextIds: {},
      },
      {
        schemaVersion: 4,
        clients: [],
        engagements: [],
        projects: [],
        tasks: [],
        items: [],
        meetings: [],
        nextIds: {},
      },
      {
        schemaVersion: 5,
        clients: [],
        engagements: [],
        projects: [],
        tasks: [],
        items: [],
        meetings: [],
        activity: [],
        nextActivityId: 1,
        nextIds: {},
      },
    ];
    for (const document of documents) {
      const dir = tempDir();
      const content = JSON.stringify(document);
      writeFileSync(storePath(dir), content, "utf8");
      const store = await openStore(dir);
      try {
        assert.deepEqual(store.snapshot().transcripts, [], `schema ${(document as { schemaVersion: number }).schemaVersion}`);
      } finally {
        await store.close();
      }
      assert.equal(readFileSync(storePath(dir), "utf8"), content, "legacy file not rewritten at open");
    }
  });

  it("refuses a legacy document that carries transcripts, leaving it intact", async () => {
    for (const version of [1, 3, 4, 5]) {
      const dir = tempDir();
      const base = documentWithMeeting(version);
      // Only versions 4 and 5 know the journal; version 1 knows no work at all.
      if (version === 1 || version === 3) {
        delete (base as Record<string, unknown>).activity;
        delete (base as Record<string, unknown>).nextActivityId;
      }
      if (version === 1) {
        delete (base as Record<string, unknown>).tasks;
        delete (base as Record<string, unknown>).items;
        delete (base as Record<string, unknown>).meetings;
      }
      const document = withTranscripts(base, [storedTranscript("meeting-1")]);
      await assertRefused(dir, document, /unsupported field|cannot contain/);
    }
  });

  it("refuses a schema 6 document that lacks the transcript list", async () => {
    const dir = tempDir();
    const document = documentWithMeeting(6);
    delete (document as Record<string, unknown>).transcripts;
    await assertRefused(dir, document, /unsupported field|missing field|invalid/);
  });

  it("refuses a schema 6 document whose meeting has an invalid parent link", async () => {
    const dir = tempDir();
    const document = documentWithMeeting(6);
    (document.meetings as Record<string, unknown>[])[0].projectId = "project-9";
    await assertRefused(dir, withTranscripts(document, [storedTranscript("meeting-1")]), /parent links/);
  });

  it("keeps business records and the journal when a schema 5 save adds no transcripts", async () => {
    const dir = tempDir();
    const document = documentWithMeeting(5);
    delete (document as Record<string, unknown>).transcripts;
    writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
    const store = await openStore(dir, { now: () => new Date("2026-02-03T04:05:06.007Z") });
    try {
      await store.updateMeeting("meeting-1", { title: "Changed" });
      const snapshot = store.snapshot();
      assert.deepEqual(snapshot.transcripts, []);
      assert.equal(snapshot.activity!.length, 1);
      assert.equal(snapshot.activity![0].targetId, "meeting-1");
    } finally {
      await store.close();
    }
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 6);
    assert.deepEqual(saved.transcripts, []);
    assert.equal(saved.meetings[0].title, "Changed");
    assert.equal(saved.activity.length, 1);
    assert.equal(saved.nextActivityId, 2);
    assert.deepEqual(saved.nextIds, document.nextIds);
  });

  it("permits a hand-built snapshot to omit transcripts and reads a store as none", async () => {
    const snapshot: Snapshot = {
      clients: [],
      engagements: [],
      projects: [],
      tasks: [],
      items: [],
      meetings: [],
    };
    assert.equal(snapshot.transcripts, undefined);
    const opened = await openStore(tempDir());
    try {
      assert.deepEqual(opened.snapshot().transcripts, []);
    } finally {
      await opened.close();
    }
  });
});

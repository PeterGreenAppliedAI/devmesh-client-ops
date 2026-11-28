/**
 * System-level checks for DOCX imports over the real application.
 *
 * Each test starts the application's own source in a disposable child over a
 * seeded temporary workspace, submits uploads through the rendered multipart
 * form over loopback HTTP, and reads the committed workspace and originals
 * afterwards. The uploads are synthetic: inert size declarations, an exact
 * 10 MiB archive, an archive whose parts expand to exactly 10 MiB, and a
 * truncated archive. The harness also exercises graceful stop and SIGKILL in
 * separate children, reporting each child's Linux peak-RSS bytes and actual
 * exit status or signal, reaping it and removing its directory.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openStore } from "../../src/store.ts";
import { MAX_CONTENT_BYTES } from "../../src/transcript.ts";
import { get, parseForm, submit } from "../fixtures/transcript-http.ts";
import {
  buildDocxWithExtraEntries,
  docxBytes,
  docxOfExpandedLength,
  docxOfLength,
  pseudoRandomBytes,
} from "../fixtures/transcript-docx.ts";
import { startDocxServer, type DocxTestServer } from "./harness.ts";

const MEMORY_LIMIT = 512_000_000;
const IMPORT_LIMIT_MS = 2000;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Seed the temporary workspace with one synthetic client and `count` meetings. */
async function seedMeetings(directory: string, count: number): Promise<string[]> {
  const store = await openStore(directory);
  try {
    const client = await store.createClient({ name: "Synthetic Client" });
    const engagement = await store.createEngagement({ clientId: client.id, name: "Synthetic Engagement" });
    const meetings: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const meeting = await store.createMeeting({
        clientId: client.id,
        engagementId: engagement.id,
        title: `Synthetic meeting ${index + 1}`,
        date: `2026-03-${String(index + 1).padStart(2, "0")}`,
      });
      meetings.push(meeting.id);
    }
    return meetings;
  } finally {
    await store.close();
  }
}

/** Submit one DOCX through the meeting's rendered multipart import form. */
async function importDocxFile(
  origin: string,
  meetingId: string,
  filename: string,
  body: Uint8Array,
) {
  const pagePath = `/meetings/${encodeURIComponent(meetingId)}/transcripts/import`;
  const page = await get(origin, pagePath);
  assert.equal(page.status, 200, `${pagePath} is rendered`);
  const form = parseForm(page.body);
  assert.equal(form.enctype, "multipart/form-data", "the import form is multipart");
  return submit(origin, pagePath, form, { file: { filename, body } });
}

/** The workspace bytes and every original file (name and bytes) in the directory. */
function workspaceSnapshot(directory: string): { workspace: Buffer; originals: { name: string; bytes: Buffer }[] } {
  const workspace = readFileSync(join(directory, "workspace.json"));
  const originalsDirectory = join(directory, "originals");
  const originals = existsSync(originalsDirectory)
    ? readdirSync(originalsDirectory)
        .sort()
        .map((name) => ({ name, bytes: readFileSync(join(originalsDirectory, name)) }))
    : [];
  return { workspace, originals };
}

/** Assert a refused submission changed neither the workspace JSON nor the originals. */
function assertWorkspaceUnchanged(
  before: { workspace: Buffer; originals: { name: string; bytes: Buffer }[] },
  after: { workspace: Buffer; originals: { name: string; bytes: Buffer }[] },
): void {
  assert.deepEqual(after.workspace, before.workspace, "workspace.json bytes are unchanged");
  assert.deepEqual(after.originals, before.originals, "the originals directory contents are unchanged");
}

/**
 * Find the source committed for `meetingId` with the upload's exact bytes,
 * verify the readable extraction and the stored original file, and return it.
 */
function storedSource(directory: string, meetingId: string, bytes: Uint8Array, visibleText: string) {
  const saved = JSON.parse(readFileSync(join(directory, "workspace.json"), "utf8")) as {
    transcripts?: { meetingId?: string; sources?: Record<string, unknown>[] }[];
  };
  const hash = sha256(bytes);
  for (const transcript of saved.transcripts ?? []) {
    if (transcript.meetingId !== meetingId) continue;
    for (const source of transcript.sources ?? []) {
      if (source.originalSha256 !== hash) continue;
      assert.equal(source.originalLength, bytes.length, "the stored source names the exact original length");
      assert.match(String(source.extractedText), new RegExp(visibleText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the extracted text is readable");
      assert.ok(Array.isArray(source.passages) && source.passages.length > 0, "the source carries readable passages");
      const originalPath = join(directory, "originals", hash);
      assert.ok(existsSync(originalPath), "the exact original is stored under its hash");
      assert.deepEqual(new Uint8Array(readFileSync(originalPath)), new Uint8Array(bytes), "the stored original bytes are exact");
      return { transcript, source };
    }
  }
  assert.fail(`no source for meeting ${meetingId} carries the supplied original ${hash}`);
}

describe("system DOCX import refusals", () => {
  it("row 1: refuses a 1 MB DOCX declaring about 300 MiB within 2 s, under 512 MB RSS, without changing the workspace", async () => {
    let meetings: string[] = [];
    let server: DocxTestServer | null = null;
    try {
      server = await startDocxServer(async (directory) => {
        meetings = await seedMeetings(directory, 1);
      });
      const before = workspaceSnapshot(server.directory);
      const filler = pseudoRandomBytes(1024 * 1024);
      const bytes = buildDocxWithExtraEntries(
        [
          {
            name: "customXml/large.bin",
            bytes: filler,
            method: 8,
            declaredUncompressedSize: 300 * 1024 * 1024,
          },
        ],
        [{ runs: ["Inert large declaration."] }],
      );
      assert.ok(bytes.length >= 1024 * 1024, "the submitted upload is about one megabyte");

      const started = performance.now();
      const reply = await importDocxFile(server.origin, meetings[0], "large-declaration.docx", bytes);
      const elapsed = performance.now() - started;

      assert.equal(reply.status, 400, `the refusal is correctable: ${reply.body.slice(0, 300)}`);
      assert.equal(String(reply.headers["content-type"]), "text/html; charset=utf-8", "the refusal is a form page");
      parseForm(reply.body);
      assert.ok(elapsed < IMPORT_LIMIT_MS, `the refusal took ${elapsed.toFixed(0)} ms`);
      const peak = server.memoryBytes();
      assert.ok(peak < MEMORY_LIMIT, `the child peak RSS was ${peak} bytes`);
      assertWorkspaceUnchanged(before, workspaceSnapshot(server.directory));
    } finally {
      await server?.cleanup();
    }
  });

  it("row 6: refuses a malformed or truncated ZIP directory with re-export guidance and no import write", async () => {
    let meetings: string[] = [];
    let server: DocxTestServer | null = null;
    try {
      server = await startDocxServer(async (directory) => {
        meetings = await seedMeetings(directory, 1);
      });
      const before = workspaceSnapshot(server.directory);
      const valid = docxBytes(["Malformed container."]);
      const truncated = valid.subarray(0, valid.length - 10);
      const reply = await importDocxFile(server.origin, meetings[0], "truncated.docx", truncated);

      assert.equal(reply.status, 400, `the truncated upload is refused: ${reply.body.slice(0, 300)}`);
      assert.match(
        reply.body,
        /Re-export the document as DOCX \(Word, \.docx\) or as UTF-8 text \(\.txt\)\./,
        "the refusal carries the DOCX re-export guidance",
      );
      parseForm(reply.body);
      assertWorkspaceUnchanged(before, workspaceSnapshot(server.directory));
    } finally {
      await server?.cleanup();
    }
  });
});

describe("system DOCX imports that fit the limits", () => {
  it("row 8: imports an exact 10 MiB upload and a separate exact 10 MiB expansion into fresh targets within 2 s", async () => {
    let meetings: string[] = [];
    let server: DocxTestServer | null = null;
    try {
      server = await startDocxServer(async (directory) => {
        meetings = await seedMeetings(directory, 3);
      });

      const exactOriginal = docxOfLength(MAX_CONTENT_BYTES);
      assert.equal(exactOriginal.length, MAX_CONTENT_BYTES);
      const firstStarted = performance.now();
      const first = await importDocxFile(server.origin, meetings[0], "exact-original.docx", exactOriginal);
      const firstElapsed = performance.now() - firstStarted;
      assert.equal(first.status, 200, `the exact 10 MiB original imports: ${first.body.slice(0, 300)}`);
      assert.ok(firstElapsed < IMPORT_LIMIT_MS, `the exact-original import took ${firstElapsed.toFixed(0)} ms`);
      const firstStored = storedSource(server.directory, meetings[0], exactOriginal, "Padded document.");
      assert.equal(firstStored.transcript.meetingId, meetings[0], "the first import committed to its fresh target");

      const exactExpansion = docxOfExpandedLength(MAX_CONTENT_BYTES);
      assert.ok(exactExpansion.length < MAX_CONTENT_BYTES, "the expanded archive's original is below its own limit");
      const secondStarted = performance.now();
      const second = await importDocxFile(server.origin, meetings[1], "exact-expansion.docx", exactExpansion);
      const secondElapsed = performance.now() - secondStarted;
      assert.equal(second.status, 200, `the exact 10 MiB expansion imports: ${second.body.slice(0, 300)}`);
      assert.ok(secondElapsed < IMPORT_LIMIT_MS, `the exact-expansion import took ${secondElapsed.toFixed(0)} ms`);
      const secondStored = storedSource(server.directory, meetings[1], exactExpansion, "Expanded document.");
      assert.equal(secondStored.transcript.meetingId, meetings[1], "the second import committed to its fresh target");
      assert.notEqual(firstStored.source.id, secondStored.source.id, "each import keeps its own source");
    } finally {
      await server?.cleanup();
    }
  });
});

describe("system harness lifecycle", () => {
  it("row 10: reads child memory, stops gracefully, SIGKILLs a separate run, reaps each child and cleans its directory", async () => {
    const graceful = await startDocxServer();
    const gracefulDirectory = graceful.directory;
    try {
      assert.ok(graceful.pid > 0, "the harness reports the child pid");
      assert.match(graceful.origin, /^http:\/\/127\.0\.0\.1:\d+$/, "the harness reports the ready origin");
      const memory = graceful.memoryBytes();
      assert.ok(Number.isSafeInteger(memory) && memory > 0, "the harness reports child memory in bytes");
      const exit = await graceful.stop();
      assert.equal(exit.code, 0, "a graceful SIGTERM stop exits with status 0");
      assert.equal(exit.signal, null, "a graceful stop is not a signal termination");
      assert.deepEqual(graceful.exitInfo(), exit, "the harness keeps the actual exit information");
    } finally {
      await graceful.cleanup();
    }
    assert.equal(existsSync(gracefulDirectory), false, "the graceful run's directory is removed");

    const forced = await startDocxServer();
    const forcedDirectory = forced.directory;
    try {
      assert.ok(forced.pid > 0, "the harness reports the second child pid");
      const memory = forced.memoryBytes();
      assert.ok(Number.isSafeInteger(memory) && memory > 0, "the harness reports memory for the SIGKILL run");
      const exit = await forced.kill();
      assert.equal(exit.code, null, "a SIGKILLed child has no exit code");
      assert.equal(exit.signal, "SIGKILL", "the harness reports the SIGKILL signal");
      assert.deepEqual(forced.exitInfo(), exit, "the harness keeps the SIGKILL exit information");
    } finally {
      await forced.cleanup();
    }
    assert.equal(existsSync(forcedDirectory), false, "the SIGKILL run's directory is removed");
  });
});

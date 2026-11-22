import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { registerRoutes } from "../src/index.ts";
import {
  clientMeetings,
  engagementMeetings,
  matchMeetingPath,
  meetingRoutes,
  projectMeetings,
  routeForMeetingPattern,
} from "../src/meeting-pages.ts";
import { startServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meeting-pages-"));
  roots.push(dir);
  return dir;
}

interface Running {
  readonly origin: string;
  readonly port: number;
  readonly store: Store;
  close(): Promise<void>;
}

/** Start a server over a real on-disk store, on an ephemeral port. */
async function running(directory = tempDir()): Promise<Running> {
  const store = await openStore(directory);
  const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
  return {
    origin: server.origin,
    port: server.port,
    store,
    async close() {
      await server.close();
      await store.close();
    },
  };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly origin?: string;
  readonly form?: Record<string, string>;
}

/** Send a request to the running server over loopback HTTP. */
function send(base: string, options: RequestOptions = {}): Promise<Reply> {
  const url = new URL(base);
  const method = options.method ?? "GET";
  const body = options.form === undefined ? "" : new URLSearchParams(options.form).toString();
  // The canonical Host authority is set explicitly, so the same request is
  // sent on every platform.
  const headers: Record<string, string | number> = {
    host: url.host,
    "content-length": Buffer.byteLength(body),
  };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers.origin = options.origin ?? base;
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method,
        path: options.path ?? "/",
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Follow one redirect from the reply, returning the target's path. */
function redirectTarget(reply: Reply): string {
  assert.equal(reply.status, 303);
  const location = String(reply.headers.location ?? "");
  assert.ok(location.startsWith("/"), `redirect location must be internal, got ${location}`);
  return location;
}

/** The id at the end of a detail path redirect, such as `/meetings/meeting-1`. */
function idOf(reply: Reply): string {
  return redirectTarget(reply).split("/").pop() as string;
}

function containsEscaped(body: string, text: string): boolean {
  return body.includes(escapeHtml(text));
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A rendered form as a browser would submit it. */
interface ParsedForm {
  readonly action: string;
  readonly controls: Map<string, string>;
}

function parseForm(document: string): ParsedForm {
  const controls = new Map<string, string>();
  const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(document);
  assert.ok(form !== null, "page has a form");
  const action = /<form[^>]*\saction="([^"]*)"/.exec(form[0]);
  assert.ok(action !== null, "the form has an action");
  const inner = form[1];
  for (const match of inner.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)];
    const selected = options.find((option) => option[2].includes("selected")) ?? options[0];
    controls.set(unescapeHtml(match[1]), selected === undefined ? "" : unescapeHtml(selected[1]));
  }
  return { action: unescapeHtml(action[1]), controls };
}

/**
 * A client with two engagements (one sibling of the other) and one project
 * each, plus a second client with its own engagement and meeting.
 */
async function hierarchy(store: Store) {
  const client = await store.createClient({ name: "Acme" });
  const otherClient = await store.createClient({ name: "Other" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  const sibling = await store.createEngagement({ clientId: client.id, name: "Sibling" });
  const otherEngagement = await store.createEngagement({
    clientId: otherClient.id,
    name: "OtherEng",
  });
  const project = await store.createProject({ engagementId: engagement.id, name: "P" });
  const secondProject = await store.createProject({ engagementId: engagement.id, name: "P2" });
  const siblingProject = await store.createProject({ engagementId: sibling.id, name: "SiblingP" });
  return {
    client,
    otherClient,
    engagement,
    sibling,
    otherEngagement,
    project,
    secondProject,
    siblingProject,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("meeting pages: creation", () => {
  it("creates a meeting with every field through the rendered form and redirects", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // The creation form is linked from the engagement page and posts to its
      // parent-scoped endpoint.
      const engagementPage = await send(server.origin, { path: `/engagements/${h.engagement.id}` });
      assert.equal(engagementPage.status, 200);
      assert.match(engagementPage.body, new RegExp(`href="/engagements/${h.engagement.id}/meetings/new"`));

      const formPage = await send(server.origin, {
        path: `/engagements/${h.engagement.id}/meetings/new`,
      });
      assert.equal(formPage.status, 200);
      const form = parseForm(formPage.body);
      assert.equal(form.action, `/engagements/${h.engagement.id}/meetings/new`);
      // The parent engagement travels as a hidden field.
      assert.equal(form.controls.get("engagementId"), h.engagement.id);
      // The project choices are only the projects of this engagement.
      assert.match(formPage.body, new RegExp(`<option value="${h.project.id}">P</option>`));
      assert.match(formPage.body, new RegExp(`<option value="${h.secondProject.id}">P2</option>`));
      assert.ok(!formPage.body.includes(`<option value="${h.siblingProject.id}">`));
      assert.equal(form.controls.get("projectId"), "");

      form.controls.set("title", "Plan <review>");
      form.controls.set("date", "2026-03-15");
      form.controls.set("notes", "Notes & <agenda>");
      form.controls.set("projectId", h.project.id);
      const created = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(created), /^\/meetings\/meeting-\d+$/);

      const stored = server.store.snapshot().meetings[0];
      assert.equal(stored.title, "Plan <review>");
      assert.equal(stored.date, "2026-03-15");
      assert.equal(stored.notes, "Notes & <agenda>");
      assert.equal(stored.projectId, h.project.id);
      // The client and engagement were derived from the parent, not the form.
      assert.equal(stored.clientId, h.client.id);
      assert.equal(stored.engagementId, h.engagement.id);

      // The detail page shows every value escaped and links to edit and parents.
      const detail = await send(server.origin, { path: redirectTarget(created) });
      assert.equal(detail.status, 200);
      assert.ok(containsEscaped(detail.body, "Plan <review>"));
      assert.ok(detail.body.includes("Notes &amp; &lt;agenda&gt;"));
      assert.ok(!detail.body.includes("Notes & <agenda>"));
      assert.match(detail.body, new RegExp(`href="/meetings/${stored.id}/edit"`));
      assert.match(detail.body, new RegExp(`href="/engagements/${h.engagement.id}"`));
      assert.match(detail.body, new RegExp(`href="/projects/${h.project.id}"`));
    } finally {
      await server.close();
    }
  });

  it("creates an engagement-only meeting from a project-scoped form with a blank project", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      // The project-scoped form preselects the path's project.
      const formPage = await send(server.origin, { path: `/projects/${h.project.id}/meetings/new` });
      assert.equal(formPage.status, 200);
      const form = parseForm(formPage.body);
      assert.equal(form.action, `/engagements/${h.engagement.id}/meetings/new`);
      assert.equal(form.controls.get("projectId"), h.project.id);
      assert.equal(form.controls.get("engagementId"), h.engagement.id);

      // A blank project records an engagement-only meeting.
      const created = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/meetings/new`,
        form: { engagementId: h.engagement.id, title: "Only", date: "2026-01-01", notes: "", projectId: "" },
      });
      assert.match(redirectTarget(created), /^\/meetings\/meeting-\d+$/);
      const stored = server.store.snapshot().meetings[0];
      assert.equal(stored.projectId, undefined);
      assert.equal("projectId" in stored, false);
      assert.equal(stored.engagementId, h.engagement.id);
      assert.equal(stored.clientId, h.client.id);
    } finally {
      await server.close();
    }
  });

  it("requires a title and a real date and keeps every submitted value on error", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      for (const [title, date] of [
        ["", "2026-02-28"],
        ["   ", "2026-02-28"],
        ["Meeting", ""],
        ["Meeting", "2023-02-29"],
        ["Meeting", "2026-13-01"],
        ["Meeting", "not a date"],
      ] as const) {
        const reply = await send(server.origin, {
          method: "POST",
          path: `/engagements/${h.engagement.id}/meetings/new`,
          form: { engagementId: h.engagement.id, title, date, notes: "keep notes", projectId: h.project.id },
        });
        assert.equal(reply.status, 400, `${title} ${date}`);
        assert.match(String(reply.headers["content-type"]), /^text\/html/);
        assert.match(reply.body, /role="alert"/);
        const correction = parseForm(reply.body);
        assert.equal(correction.action, `/engagements/${h.engagement.id}/meetings/new`);
        assert.equal(correction.controls.get("engagementId"), h.engagement.id);
        assert.equal(correction.controls.get("title"), title);
        assert.equal(correction.controls.get("date"), date);
        assert.equal(correction.controls.get("notes"), "keep notes");
        assert.equal(correction.controls.get("projectId"), h.project.id);
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the values and resubmitting the rendered form redirects.
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { engagementId: h.engagement.id, title: "", date: "2026-02-30", notes: "<keep>", projectId: h.project.id },
      });
      const form = parseForm(invalid.body);
      assert.match(invalid.body, /<textarea[^>]*>.*&lt;keep&gt;.*<\/textarea>/);
      form.controls.set("title", "Fixed");
      form.controls.set("date", "2026-02-28");
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(corrected), /^\/meetings\/meeting-\d+$/);
      const stored = server.store.snapshot().meetings[0];
      assert.equal(stored.title, "Fixed");
      assert.equal(stored.date, "2026-02-28");
      assert.equal(stored.notes, "<keep>");
    } finally {
      await server.close();
    }
  });

  it("rejects a tampered cross-engagement project and a tampered parent without mutating", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      const tamperedCreate = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: {
          engagementId: h.engagement.id,
          title: "Tampered",
          date: "2026-05-05",
          notes: "keep me",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(tamperedCreate.status, 400);
      assert.match(tamperedCreate.body, /role="alert"/);
      assert.match(tamperedCreate.body, /does not belong to engagementId/);
      // Submitted values and the rejected project stay on the form.
      const corrected = parseForm(tamperedCreate.body);
      assert.equal(corrected.action, `/engagements/${h.engagement.id}/meetings/new`);
      assert.equal(corrected.controls.get("title"), "Tampered");
      assert.equal(corrected.controls.get("notes"), "keep me");
      assert.match(tamperedCreate.body, new RegExp(`<option value="${h.siblingProject.id}" selected>`));
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A nonexistent submitted project is a correctable error, not a 404.
      const unknownProject = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { title: "Unknown", date: "2026-05-05", notes: "", projectId: "project-99" },
      });
      assert.equal(unknownProject.status, 400);
      assert.doesNotMatch(unknownProject.body, /Not found/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A tampered parent id in the form is refused: the engagement and client
      // are derived from the URL parent, and a submission that names a
      // different engagement (or client) is rejected, not silently rewritten.
      const parentTamper = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: {
          engagementId: h.sibling.id,
          title: "Parent tamper",
          date: "2026-05-05",
          notes: "",
          projectId: "",
        },
      });
      assert.equal(parentTamper.status, 400);
      assert.match(String(parentTamper.headers["content-type"]), /^text\/html/);
      assert.match(parentTamper.body, /role="alert"/);
      assert.match(parentTamper.body, /not the parent engagement of this form/);
      // The submitted values are kept on the correction form, which still posts
      // to the URL parent's endpoint with the URL parent in its hidden control.
      const parentCorrection = parseForm(parentTamper.body);
      assert.equal(parentCorrection.action, `/engagements/${h.engagement.id}/meetings/new`);
      assert.equal(parentCorrection.controls.get("engagementId"), h.engagement.id);
      assert.equal(parentCorrection.controls.get("title"), "Parent tamper");
      assert.equal(parentCorrection.controls.get("date"), "2026-05-05");
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A tampered client id is refused the same way.
      const clientTamper = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: {
          engagementId: h.engagement.id,
          clientId: h.otherClient.id,
          title: "Client tamper",
          date: "2026-05-05",
          notes: "",
        },
      });
      assert.equal(clientTamper.status, 400);
      assert.match(clientTamper.body, /not the client of this engagement/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A tampered parent through a project-scoped path is refused too.
      const projectParentTamper = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/meetings/new`,
        form: {
          engagementId: h.sibling.id,
          title: "Project parent tamper",
          date: "2026-05-05",
          notes: "",
          projectId: h.project.id,
        },
      });
      assert.equal(projectParentTamper.status, 400);
      assert.match(projectParentTamper.body, /not the parent engagement of this form/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // The stored parent ids are still derived from the URL, never the form.
      const created = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { title: "Legit", date: "2026-05-05", notes: "" },
      });
      const createdId = idOf(created);
      const createdStored = server.store.snapshot().meetings.find((candidate) => candidate.id === createdId);
      assert.ok(createdStored !== undefined);
      assert.equal(createdStored.engagementId, h.engagement.id);
      assert.equal(createdStored.clientId, h.client.id);
    } finally {
      await server.close();
    }
  });

  it("reports a missing parent engagement or project as not found", async () => {
    const server = await running();
    try {
      const before = JSON.stringify(server.store.snapshot());
      for (const path of ["/engagements/engagement-99/meetings/new", "/projects/project-99/meetings/new"]) {
        const get = await send(server.origin, { path });
        assert.equal(get.status, 404, path);
        const post = await send(server.origin, {
          method: "POST",
          path,
          form: { title: "x", date: "2026-01-01", notes: "" },
        });
        assert.equal(post.status, 404, path);
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });
});

describe("meeting pages: editing", () => {
  it("edits every field, reassigns and clears the project, and keeps omitted fields", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const meeting = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Original",
        date: "2026-01-01",
        notes: "old notes",
      });

      const editPage = await send(server.origin, { path: `/meetings/${meeting.id}/edit` });
      assert.equal(editPage.status, 200);
      const form = parseForm(editPage.body);
      assert.equal(form.action, `/meetings/${meeting.id}/edit`);
      assert.equal(form.controls.get("id"), meeting.id);
      assert.equal(form.controls.get("title"), "Original");
      assert.equal(form.controls.get("date"), "2026-01-01");
      assert.equal(form.controls.get("notes"), "old notes");
      assert.equal(form.controls.get("projectId"), h.project.id);
      // Only this engagement's projects are offered.
      assert.ok(!editPage.body.includes(`<option value="${h.siblingProject.id}">`));

      form.controls.set("title", "Edited <one>");
      form.controls.set("date", "2026-06-30");
      form.controls.set("notes", "new & notes");
      form.controls.set("projectId", h.secondProject.id);
      const saved = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.equal(redirectTarget(saved), `/meetings/${meeting.id}`);
      let stored = server.store.snapshot().meetings[0];
      assert.equal(stored.title, "Edited <one>");
      assert.equal(stored.date, "2026-06-30");
      assert.equal(stored.notes, "new & notes");
      assert.equal(stored.projectId, h.secondProject.id);

      // A blank project select clears the link; the other fields are kept.
      const cleared = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { title: "Edited <one>", date: "2026-06-30", notes: "new & notes", projectId: "" },
      });
      assert.equal(redirectTarget(cleared), `/meetings/${meeting.id}`);
      stored = server.store.snapshot().meetings[0];
      assert.equal(stored.projectId, undefined);
      assert.equal("projectId" in stored, false);
      assert.equal(stored.notes, "new & notes");

      // A title-only edit changes only the title and keeps everything else.
      const titled = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { title: "Renamed only" },
      });
      assert.equal(redirectTarget(titled), `/meetings/${meeting.id}`);
      stored = server.store.snapshot().meetings[0];
      assert.equal(stored.title, "Renamed only");
      assert.equal(stored.date, "2026-06-30");
      assert.equal(stored.notes, "new & notes");
    } finally {
      await server.close();
    }
  });

  it("keeps submitted values on an invalid edit and rejects a tampered project", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const meeting = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Original",
        date: "2026-01-01",
        notes: "old notes",
      });
      const before = JSON.stringify(server.store.snapshot());

      // An invalid date and a blank title keep every submitted value.
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: meeting.id, title: "", date: "2026-02-30", notes: "keep <me>", projectId: h.project.id },
      });
      assert.equal(invalid.status, 400);
      assert.match(invalid.body, /role="alert"/);
      const correction = parseForm(invalid.body);
      assert.equal(correction.action, `/meetings/${meeting.id}/edit`);
      assert.equal(correction.controls.get("id"), meeting.id);
      assert.equal(correction.controls.get("title"), "");
      assert.equal(correction.controls.get("date"), "2026-02-30");
      assert.equal(correction.controls.get("notes"), "keep <me>");
      assert.match(invalid.body, /<textarea[^>]*>keep &lt;me&gt;<\/textarea>/);

      // Correcting and resubmitting redirects to the record.
      correction.controls.set("title", "Fixed");
      correction.controls.set("date", "2026-02-28");
      const corrected = await send(server.origin, {
        method: "POST",
        path: correction.action,
        form: Object.fromEntries(correction.controls),
      });
      assert.equal(redirectTarget(corrected), `/meetings/${meeting.id}`);
      assert.equal(server.store.snapshot().meetings[0].title, "Fixed");

      // A meeting cannot be moved to a sibling engagement's project.
      const beforeEdit = JSON.stringify(server.store.snapshot());
      const tampered = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: meeting.id, title: "Hijacked", date: "2026-03-03", notes: "", projectId: h.siblingProject.id },
      });
      assert.equal(tampered.status, 400);
      assert.match(tampered.body, /role="alert"/);
      const editCorrection = parseForm(tampered.body);
      assert.equal(editCorrection.action, `/meetings/${meeting.id}/edit`);
      assert.equal(editCorrection.controls.get("title"), "Hijacked");
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      // A conflicting submitted id is refused on a form for the URL record.
      const conflicting = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: "meeting-99", title: "x", date: "2026-03-03", notes: "" },
      });
      assert.equal(conflicting.status, 400);
      assert.match(conflicting.body, /does not match this URL/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);
      assert.notEqual(before, beforeEdit);
    } finally {
      await server.close();
    }
  });

  it("shows a missing-record error for an unknown meeting id", async () => {
    const server = await running();
    try {
      for (const path of ["/meetings/meeting-99", "/meetings/meeting-99/edit"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
    } finally {
      await server.close();
    }
  });
});

describe("meeting pages: histories", () => {
  it("lists engagement and project histories, each with date, title and links, newest first", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const only = await server.store.createMeeting({ ...base, title: "Engagement only", date: "2026-01-10" });
      const inP = await server.store.createMeeting({ ...base, projectId: h.project.id, title: "In P", date: "2026-03-01" });
      const inP2 = await server.store.createMeeting({ ...base, projectId: h.secondProject.id, title: "In P2", date: "2026-05-01" });
      // The same date twice: the tie order is stable (by id descending).
      const tieOld = await server.store.createMeeting({ ...base, title: "Tie older", date: "2026-02-01" });
      const tieNew = await server.store.createMeeting({ ...base, title: "Tie newer", date: "2026-02-01" });
      // A sibling engagement's meeting must not appear in this engagement.
      const siblingMeeting = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        projectId: h.siblingProject.id,
        title: "Sibling meeting",
        date: "2026-04-01",
      });
      // Another client's meeting must never appear in anything here.
      const otherMeeting = await server.store.createMeeting({
        clientId: h.otherClient.id,
        engagementId: h.otherEngagement.id,
        title: "Other client meeting",
        date: "2026-06-01",
      });

      const engagementPage = await send(server.origin, { path: `/engagements/${h.engagement.id}` });
      assert.equal(engagementPage.status, 200);
      // The engagement history has every meeting of the engagement once,
      // including both projects' meetings.
      for (const meeting of [only, inP, inP2, tieOld, tieNew]) {
        assert.match(engagementPage.body, new RegExp(`href="/meetings/${meeting.id}"`), meeting.title);
        assert.match(engagementPage.body, new RegExp(`href="/meetings/${meeting.id}/edit"`), meeting.title);
      }
      assert.ok(containsEscaped(engagementPage.body, "2026-03-01 — In P"));
      assert.ok(containsEscaped(engagementPage.body, "2026-01-10 — Engagement only"));
      // Each meeting appears exactly once in the engagement history.
      for (const meeting of [only, inP, inP2, tieOld, tieNew]) {
        const occurrences = engagementPage.body.split(`href="/meetings/${meeting.id}"`).length - 1;
        assert.equal(occurrences, 1, `${meeting.title} appears once`);
      }
      assert.ok(!engagementPage.body.includes("Sibling meeting"));
      assert.ok(!engagementPage.body.includes("Other client meeting"));
      // Dates are ordered descending with a stable tie order (by id descending)
      // within the rendered history list.
      const historyStart = engagementPage.body.indexOf("Meeting history");
      const historyEnd = engagementPage.body.indexOf("</section>", historyStart);
      const history = engagementPage.body.slice(historyStart, historyEnd);
      const allOrder = [inP2, inP, tieNew, tieOld, only].map((meeting) => history.indexOf(`href="/meetings/${meeting.id}"`));
      for (let i = 1; i < allOrder.length; i += 1) assert.ok(allOrder[i - 1] < allOrder[i], "newest first");

      // The project history has only the project's own meetings.
      const projectPage = await send(server.origin, { path: `/projects/${h.project.id}` });
      assert.equal(projectPage.status, 200);
      assert.match(projectPage.body, new RegExp(`href="/meetings/${inP.id}"`));
      assert.match(projectPage.body, new RegExp(`href="/meetings/${inP.id}/edit"`));
      for (const meeting of [only, inP2, tieOld, tieNew, siblingMeeting, otherMeeting]) {
        assert.ok(!projectPage.body.includes(`href="/meetings/${meeting.id}"`), meeting.title);
      }
      assert.match(projectPage.body, new RegExp(`href="/projects/${h.project.id}/meetings/new"`));

      // The helper selectors agree with the rendered pages.
      assert.deepEqual(engagementMeetings(server.store, h.client.id, h.engagement.id).map((m) => m.id), [
        inP2.id,
        inP.id,
        tieNew.id,
        tieOld.id,
        only.id,
      ]);
      assert.deepEqual(projectMeetings(server.store, h.client.id, h.engagement.id, h.project.id).map((m) => m.id), [inP.id]);
      assert.deepEqual(clientMeetings(server.store, h.client.id).map((m) => m.id), [
        inP2.id,
        siblingMeeting.id,
        inP.id,
        tieNew.id,
        tieOld.id,
        only.id,
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps meeting histories reachable after their date and shows an empty state", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      // An engagement with no meetings shows a meaningful empty state.
      const empty = await send(server.origin, { path: `/engagements/${h.sibling.id}` });
      assert.equal(empty.status, 200);
      assert.match(empty.body, /No meetings recorded yet\./);

      // Past meetings stay listed and linked.
      const past = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Past kickoff",
        date: "2020-01-15",
      });
      const page = await send(server.origin, { path: `/engagements/${h.engagement.id}` });
      assert.match(page.body, new RegExp(`href="/meetings/${past.id}"`));
      assert.match(page.body, new RegExp(`href="/meetings/${past.id}/edit"`));
    } finally {
      await server.close();
    }
  });
});

describe("meeting pages: guards", () => {
  it("refuses unregistered paths, wrong methods and a cross-origin POST", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());
      for (const path of ["/meetings", "/meetings/", "/meetings/new", "/meetings/meeting-1/other"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
      for (const path of ["/meetings/meeting-1"]) {
        const reply = await send(server.origin, { method: "POST", path, form: { title: "x", date: "2026-01-01" } });
        assert.equal(reply.status, 405, path);
      }
      const foreign = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        origin: "http://evil.example",
        form: { title: "x", date: "2026-01-01", notes: "" },
      });
      assert.equal(foreign.status, 403);
      const getCreate = await send(server.origin, { path: `/engagements/${h.engagement.id}/meetings/new` });
      assert.equal(getCreate.status, 200);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("matches the fixed meeting paths and registers every route through the table", async () => {
    assert.deepEqual(matchMeetingPath("/meetings/meeting-1"), { pattern: "/meetings/:id", id: "meeting-1" });
    assert.deepEqual(matchMeetingPath("/meetings/meeting-1/edit"), { pattern: "/meetings/:id/edit", id: "meeting-1" });
    assert.deepEqual(matchMeetingPath("/engagements/engagement-1/meetings/new"), {
      pattern: "/engagements/:id/meetings/new",
      id: "engagement-1",
    });
    assert.deepEqual(matchMeetingPath("/projects/project-1/meetings/new"), {
      pattern: "/projects/:id/meetings/new",
      id: "project-1",
    });
    for (const path of ["/", "/meetings", "/meetings/", "/meetings/new", "/tasks/task-1", "/engagements/engagement-1/tasks/new"]) {
      assert.equal(matchMeetingPath(path), null, path);
    }

    const store = await openStore(tempDir());
    try {
      const routes = meetingRoutes(store);
      const patterns = [
        ["/meetings/:id", "GET"],
        ["/meetings/:id/edit", "GET"],
        ["/meetings/:id/edit", "POST"],
        ["/engagements/:id/meetings/new", "GET"],
        ["/engagements/:id/meetings/new", "POST"],
        ["/projects/:id/meetings/new", "GET"],
      ] as const;
      for (const [pattern, method] of patterns) {
        const route = routeForMeetingPattern(routes, pattern, method);
        assert.ok(route !== undefined, `${pattern} ${method}`);
        assert.equal(route.method, method);
      }
      // The detail page does not accept POST.
      assert.equal(routeForMeetingPattern(routes, "/meetings/:id", "POST"), undefined);
    } finally {
      await store.close();
    }
  });
});

describe("meeting pages: client overview", () => {
  it("groups open next steps by kind, lists decisions including closed ones and shows empty states", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const followUp = await server.store.createItem({ ...base, kind: "follow_up", title: "Follow", state: "open" });
      const commitment = await server.store.createItem({ ...base, kind: "commitment", title: "Commit", state: "open" });
      const waiting = await server.store.createItem({ ...base, kind: "waiting", title: "Wait", state: "open" });
      const closedWaiting = await server.store.createItem({ ...base, kind: "waiting", title: "Old wait", state: "closed" });
      const openDecision = await server.store.createItem({ ...base, kind: "decision", title: "Decide", state: "open" });
      // A sibling client's items and meetings never appear in this overview.
      const other = await server.store.createItem({
        clientId: h.otherClient.id,
        engagementId: h.otherEngagement.id,
        kind: "follow_up",
        title: "Other follow",
        state: "open",
      });

      const page = await send(server.origin, { path: `/clients/${h.client.id}` });
      assert.equal(page.status, 200);
      const nextStepsAt = page.body.indexOf("Next steps");
      assert.ok(nextStepsAt >= 0);
      const nextSteps = page.body.slice(nextStepsAt, page.body.indexOf("</section>", nextStepsAt));
      // Each kind is its own labelled group, with only that kind inside it.
      const group = (start: string, end: string): string => {
        const from = nextSteps.indexOf(start);
        assert.ok(from >= 0, start);
        const to = end === "" ? nextSteps.length : nextSteps.indexOf(end, from + start.length);
        return nextSteps.slice(from, to < 0 ? undefined : to);
      };
      const followUps = group("Open follow-ups", "Open commitments");
      const commitments = group("Open commitments", "Open waiting items");
      const waitings = group("Open waiting items", "");
      assert.match(followUps, new RegExp(`href="/items/${followUp.id}"`));
      assert.ok(!followUps.includes(`href="/items/${commitment.id}"`));
      assert.ok(!followUps.includes(`href="/items/${waiting.id}"`));
      assert.match(commitments, new RegExp(`href="/items/${commitment.id}"`));
      assert.ok(!commitments.includes(`href="/items/${followUp.id}"`));
      assert.match(waitings, new RegExp(`href="/items/${waiting.id}"`));
      assert.ok(!waitings.includes(`href="/items/${followUp.id}"`));
      // The closed waiting item is not in the open groups.
      assert.ok(!nextSteps.includes(`href="/items/${closedWaiting.id}"`));
      // The other client's follow-up is not in this overview.
      assert.ok(!page.body.includes("Other follow"));
      assert.ok(!page.body.includes(`href="/items/${other.id}"`));
      // Decisions include the open decision.
      const decisionsAt = page.body.indexOf("Decisions");
      const decisions = page.body.slice(decisionsAt, page.body.indexOf("</section>", decisionsAt));
      assert.match(decisions, new RegExp(`href="/items/${openDecision.id}"`));

      // The overview offers no client-level creation shortcut: no guessed
      // parent links, so creation stays scoped under a chosen engagement or
      // project.
      assert.ok(!page.body.includes("/engagements//"));
      assert.ok(!page.body.includes("New task"));
      assert.ok(!page.body.includes("New item"));

      // A client with no engagements: every section shows an empty state.
      const empty = await server.store.createClient({ name: "Empty" });
      const emptyPage = await send(server.origin, { path: `/clients/${empty.id}` });
      assert.equal(emptyPage.status, 200);
      assert.match(emptyPage.body, /No engagements yet\./);
      assert.match(emptyPage.body, /No current tasks\./);
      assert.match(emptyPage.body, /No open follow-ups\./);
      assert.match(emptyPage.body, /No open commitments\./);
      assert.match(emptyPage.body, /No open waiting items\./);
      assert.match(emptyPage.body, /No meetings recorded yet\./);
      assert.ok(!emptyPage.body.includes("/engagements//"));
    } finally {
      await server.close();
    }
  });
});

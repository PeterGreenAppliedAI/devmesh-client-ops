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
 * The visible controls a page associates with a field error: each control
 * carrying `aria-invalid="true"` with an `aria-describedby` naming a message
 * element of the same text as the control's own error paragraph.
 */
function invalidControls(
  document: string,
): readonly { readonly field: string; readonly describedBy: string }[] {
  const found: { field: string; describedBy: string }[] = [];
  for (const match of document.matchAll(
    /<(?:input|textarea|select)[^>]*\sid="field-(?<field>[^"]+)"[^>]*\saria-invalid="true"[^>]*\saria-describedby="(?<described>[^"]+)"/g,
  )) {
    if (match.groups === undefined) continue;
    const message = new RegExp(`<p id="${match.groups.described}">([^<]*)<\\/p>`).exec(document);
    assert.ok(message !== null, `${match.groups.field} has a message`);
    assert.ok(document.includes(`<li>${message[1]}</li>`), `${match.groups.field} stays in the summary`);
    found.push({ field: match.groups.field, describedBy: match.groups.described });
  }
  return found;
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
      // The submitted client parent matches the URL's client, so it is accepted
      // and the stored record keeps the parent the form named.

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

      const renderedCreate = parseForm(
        (await send(server.origin, { path: `/engagements/${h.engagement.id}/meetings/new` })).body,
      );
      for (const [title, date] of [
        ["", "2026-02-28"],
        ["   ", "2026-02-28"],
        ["Meeting", ""],
        ["Meeting", "2023-02-29"],
        ["Meeting", "2026-13-01"],
        ["Meeting", "not a date"],
      ] as const) {
        const controls = new Map(renderedCreate.controls);
        controls.set("title", title);
        controls.set("date", date);
        controls.set("notes", "keep notes");
        controls.set("projectId", h.project.id);
        const reply = await send(server.origin, {
          method: "POST",
          path: `/engagements/${h.engagement.id}/meetings/new`,
          form: Object.fromEntries(controls),
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
        // The failing visible field is marked invalid and describes itself with
        // a message of its own, which the summary also carries.
        const fields = title.trim() === "" ? ["title"] : ["date"];
        // Exactly the failing controls are invalid, whether or not they are
        // described: the independent count keeps an extra marked control from
        // slipping in unnoticed, alongside the association check below.
        assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, fields.length, `${title} ${date}`);
        assert.equal(invalidControls(reply.body).length, fields.length, `${title} ${date}`);
        for (const failing of fields) {
          const associated = invalidControls(reply.body).find((control) => control.field === failing);
          assert.ok(associated !== undefined, `${title} ${date} marks ${failing}`);
          const inline = new RegExp(`<p id="${associated.describedBy}">([^<]*)<\\/p>`).exec(reply.body);
          assert.ok(inline !== null, `${title} ${date}`);
          assert.ok(reply.body.includes(`<li>${inline[1]}</li>`), `${title} ${date} summary`);
        }
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the values and resubmitting the rendered form redirects.
      const invalidValues = new Map(renderedCreate.controls);
      invalidValues.set("title", "");
      invalidValues.set("date", "2026-02-30");
      invalidValues.set("notes", "<keep>");
      invalidValues.set("projectId", h.project.id);
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: Object.fromEntries(invalidValues),
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

  it("renders a rejected date as plain text that shows and resubmits the exact value", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      // A valid date (and an empty one) keeps the browser's date control.
      const createPage = await send(server.origin, {
        path: `/engagements/${h.engagement.id}/meetings/new`,
      });
      assert.match(createPage.body, /<input type="date" id="field-date" name="date" value=""/);
      assert.doesNotMatch(createPage.body, /<input type="date"[^>]*aria-invalid/);
      // An invalid date is rendered as a text control, because a browser
      // sanitises an invalid value on a date input to empty. The exact
      // submitted text stays visible and in the value a resubmission sends.
      for (const badDate of ["not a date", "2026-2-30", "05/05/2026", "20260230"]) {
        const reply = await send(server.origin, {
          method: "POST",
          path: `/engagements/${h.engagement.id}/meetings/new`,
          form: { engagementId: h.engagement.id, title: "Dated", date: badDate, notes: "keep", projectId: "" },
        });
        assert.equal(reply.status, 400, badDate);
        assert.match(
          reply.body,
          new RegExp(`<input type="text" id="field-date" name="date" value="${escapeHtml(badDate)}" required[^>]*aria-invalid="true"`),
          badDate,
        );
        // The exact text is the control's submitted value.
        assert.equal(parseForm(reply.body).controls.get("date"), badDate, badDate);
        // A valid stored date keeps the date control on an edit correction.
        assert.equal(JSON.stringify(server.store.snapshot()), before, badDate);
      }

      // A well formed but impossible date is rendered as a text control too: a
      // browser's date control sanitises a date outside the calendar (such as
      // the day after a month's end) to empty, so it would not keep the value.
      for (const impossibleDate of ["2026-02-30", "2026-13-01", "2023-02-29", "2026-04-31"]) {
        const impossible = await send(server.origin, {
          method: "POST",
          path: `/engagements/${h.engagement.id}/meetings/new`,
          form: { engagementId: h.engagement.id, title: "Dated", date: impossibleDate, notes: "", projectId: "" },
        });
        assert.equal(impossible.status, 400, impossibleDate);
        assert.match(
          impossible.body,
          new RegExp(`<input type="text" id="field-date" name="date" value="${escapeHtml(impossibleDate)}" required[^>]*aria-invalid="true"`),
          impossibleDate,
        );
        assert.equal(parseForm(impossible.body).controls.get("date"), impossibleDate, impossibleDate);
        assert.match(impossible.body, /must be a real calendar date/, impossibleDate);
        assert.equal(JSON.stringify(server.store.snapshot()), before, impossibleDate);
      }

      // A year-zero day the store refuses (`0000-02-30` is not a real day) is
      // still rendered as text: a browser's date control sanitises `0000-MM-DD`
      // to empty, so the value would not survive as text on a date control.
      for (const refusedZero of ["0000-02-30"]) {
        const zero = await send(server.origin, {
          method: "POST",
          path: `/engagements/${h.engagement.id}/meetings/new`,
          form: { engagementId: h.engagement.id, title: "Zero", date: refusedZero, notes: "keep", projectId: "" },
        });
        assert.equal(zero.status, 400, refusedZero);
        assert.match(
          zero.body,
          new RegExp(`<input type="text" id="field-date" name="date" value="${escapeHtml(refusedZero)}" required aria-invalid="true"`),
          refusedZero,
        );
        assert.equal(parseForm(zero.body).controls.get("date"), refusedZero, refusedZero);
        assert.match(zero.body, /must be a real calendar date/, refusedZero);
        assert.equal(parseForm(zero.body).controls.get("notes"), "keep", refusedZero);
        assert.equal(JSON.stringify(server.store.snapshot()), before, refusedZero);
      }

      // A leap day of a leap year is a real date and keeps the date control,
      // which shows it exactly as written.
      const leapDay = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { engagementId: h.engagement.id, title: "", date: "2024-02-29", notes: "", projectId: "" },
      });
      assert.equal(leapDay.status, 400);
      assert.match(leapDay.body, /<input type="date" id="field-date" name="date" value="2024-02-29" required>/);
      assert.equal(parseForm(leapDay.body).controls.get("date"), "2024-02-29");

      // A valid date is rendered as a date control again.
      const meeting = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Valid",
        date: "2026-01-02",
      });
      const validEdit = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: meeting.id, title: "", date: meeting.date },
      });
      assert.equal(validEdit.status, 400);
      assert.match(validEdit.body, /<input type="date" id="field-date" name="date" value="2026-01-02" required/);
    } finally {
      await server.close();
    }
  });

  it("associates only the visible field it names, never a quoted submitted value", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      // A blank title with notes submitted as a field-like word: the message
      // names the title, and the quoted value in no message marks notes.
      const reply = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { engagementId: h.engagement.id, title: "", date: "2026-01-01", notes: "notes", projectId: "" },
      });
      assert.equal(reply.status, 400);
      const marked = reply.body.match(/aria-invalid="true"/g) ?? [];
      assert.equal(marked.length, 1);
      assert.match(
        reply.body,
        /<input[^>]*\sid="field-title"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-title-error"/,
      );
      assert.doesNotMatch(reply.body, /id="field-notes"[^>]*aria-invalid/);
      assert.equal(parseForm(reply.body).controls.get("notes"), "notes");

      // A tampered parent quoting a visible field name (notes) names the
      // hidden client link, not the notes control: the message stays in the
      // summary, and the quoted word marks no control invalid.
      const parentTamper = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { clientId: "notes", title: "T", date: "2026-01-01", notes: "keep", projectId: "" },
      });
      assert.equal(parentTamper.status, 400);
      assert.match(parentTamper.body, /not the client of this engagement/);
      assert.equal(invalidControls(parentTamper.body).length, 0);
      assert.equal(parseForm(parentTamper.body).controls.get("notes"), "keep");

      // An engagement parent tampered to a bare visible field name (title) is a
      // problem with the hidden engagement link, so the summary carries it and
      // no visible control is marked invalid.
      const engagementTamper = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { engagementId: "title", title: "T", date: "2026-01-01", notes: "", projectId: "" },
      });
      assert.equal(engagementTamper.status, 400);
      assert.match(engagementTamper.body, /not the parent engagement of this form/);
      assert.equal(invalidControls(engagementTamper.body).length, 0);

      // A parent value quoting a visible field name together with other words
      // (`projectId` quoted inside the engagement value) is still a value: the
      // message names the hidden engagement link, and the quoted project does
      // not mark the project select invalid.
      const quotedProject = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { engagementId: "x projectId y", title: "T", date: "2026-01-01", notes: "", projectId: "" },
      });
      assert.equal(quotedProject.status, 400);
      assert.match(quotedProject.body, /not the parent engagement of this form/);
      assert.equal((quotedProject.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.doesNotMatch(quotedProject.body, /id="field-projectId"[^>]*aria-invalid/);
      assert.equal(parseForm(quotedProject.body).controls.get("projectId"), "");

      // A parent value carrying an escaped quote (`x\" notes`) is one complete
      // quoted value through to its closing quote, so the notes control after
      // it is never named.
      const escapedQuote = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: { clientId: "x\\\" notes", title: "T", date: "2026-01-01", notes: "keep", projectId: "" },
      });
      assert.equal(escapedQuote.status, 400);
      assert.match(escapedQuote.body, /not the client of this engagement/);
      assert.equal((escapedQuote.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.doesNotMatch(escapedQuote.body, /id="field-notes"[^>]*aria-invalid/);
      assert.equal(parseForm(escapedQuote.body).controls.get("notes"), "keep");
      assert.equal(JSON.stringify(server.store.snapshot()), before);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // An existing identity conflict takes precedence over a parent mismatch
      // and over any invalid visible field.
      const meeting = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Keep",
        date: "2026-01-02",
        notes: "old",
      });
      const editBefore = JSON.stringify(server.store.snapshot());
      const precedence = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: "meeting-99", title: "", date: "bad", engagementId: h.sibling.id, notes: "new" },
      });
      assert.equal(precedence.status, 400);
      assert.match(precedence.body, /does not match this URL/);
      assert.doesNotMatch(precedence.body, /not the parent engagement/);
      assert.doesNotMatch(precedence.body, /must be nonblank/);
      assert.equal((precedence.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.equal(JSON.stringify(server.store.snapshot()), editBefore);
    } finally {
      await server.close();
    }
  });

  it("keeps omitted fields on a corrected meeting edit", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const meeting = await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Omit",
        date: "2026-01-02",
        notes: "Keep notes",
        projectId: h.project.id,
      });
      const before = JSON.stringify(server.store.snapshot());

      // A blank title with every other field omitted shows the submitted blank
      // title and the stored values of the omitted controls.
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: meeting.id, title: "" },
      });
      assert.equal(invalid.status, 400);
      const form = parseForm(invalid.body);
      assert.equal(form.action, `/meetings/${meeting.id}/edit`);
      assert.equal(form.controls.get("title"), "");
      assert.equal(form.controls.get("date"), "2026-01-02");
      assert.equal(form.controls.get("notes"), "Keep notes");
      assert.equal(form.controls.get("projectId"), h.project.id);
      assert.equal((invalid.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the title on the rendered form and resubmitting the whole
      // correction form saves it and keeps every value it carries, including
      // the stored values the original submission omitted.
      form.controls.set("title", "Corrected");
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(corrected), /^\/meetings\/meeting-\d+$/);
      const stored = server.store.snapshot().meetings.find((candidate) => candidate.id === meeting.id);
      assert.ok(stored !== undefined);
      assert.equal(stored.title, "Corrected");
      assert.equal(stored.date, "2026-01-02");
      assert.equal(stored.notes, "Keep notes");
      assert.equal(stored.projectId, h.project.id);
    } finally {
      await server.close();
    }
  });

  it("rejects tampered parents from the path parent and leaves the data unchanged", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      const renderedForm = parseForm(
        (await send(server.origin, { path: `/engagements/${h.engagement.id}/meetings/new` })).body,
      );
      const tamperedControls = new Map(renderedForm.controls);
      tamperedControls.set("title", "Tampered");
      tamperedControls.set("date", "2026-05-05");
      tamperedControls.set("notes", "keep me");
      tamperedControls.set("projectId", h.siblingProject.id);
      const tamperedCreate = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/meetings/new`,
        form: Object.fromEntries(tamperedControls),
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
      // The rejected project is the form's own visible choice: its select is
      // marked invalid and points at the message the summary also carries.
      assert.equal((unknownProject.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.equal(invalidControls(unknownProject.body).length, 1);
      assert.equal(invalidControls(unknownProject.body)[0].field, "projectId");
      assert.match(
        unknownProject.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      assert.match(
        unknownProject.body,
        /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/,
      );
      const unknownCorrection = parseForm(unknownProject.body);
      assert.equal(unknownCorrection.controls.get("title"), "Unknown");
      assert.equal(unknownCorrection.controls.get("date"), "2026-05-05");
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
      // Resubmitting the corrected form creates the meeting under the parent
      // derived from the path, never under the tampered engagement.
      const parentFixed = await send(server.origin, {
        method: "POST",
        path: parentCorrection.action,
        form: Object.fromEntries(parentCorrection.controls),
      });
      assert.match(redirectTarget(parentFixed), /^\/meetings\/meeting-\d+$/);
      const parentFixedStored = server.store.snapshot().meetings[0];
      assert.equal(parentFixedStored.title, "Parent tamper");
      assert.equal(parentFixedStored.engagementId, h.engagement.id);
      assert.equal(parentFixedStored.clientId, h.client.id);
      assert.equal(server.store.snapshot().meetings.length, 1);
      const afterParentFix = JSON.stringify(server.store.snapshot());

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
      const clientCorrection = parseForm(clientTamper.body);
      assert.equal(clientCorrection.action, `/engagements/${h.engagement.id}/meetings/new`);
      assert.equal(clientCorrection.controls.get("engagementId"), h.engagement.id);
      assert.equal(clientCorrection.controls.get("title"), "Client tamper");
      assert.equal(clientCorrection.controls.get("date"), "2026-05-05");
      assert.equal(JSON.stringify(server.store.snapshot()), afterParentFix);

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
      // The project-scoped correction form keeps the engagement of the URL
      // project as its authoritative parent and the submitted values.
      const projectCorrection = parseForm(projectParentTamper.body);
      assert.equal(projectCorrection.action, `/engagements/${h.engagement.id}/meetings/new`);
      assert.equal(projectCorrection.controls.get("engagementId"), h.engagement.id);
      assert.equal(projectCorrection.controls.get("projectId"), h.project.id);
      assert.equal(projectCorrection.controls.get("title"), "Project parent tamper");
      assert.equal(JSON.stringify(server.store.snapshot()), afterParentFix);
      // A submitted project id is never consulted when the parent is tampered:
      // even a project outside the engagement leaves the refusal in place.
      const projectAndParentTamper = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/meetings/new`,
        form: {
          engagementId: h.sibling.id,
          title: "Both tampered",
          date: "2026-05-05",
          notes: "",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(projectAndParentTamper.status, 400);
      assert.match(projectAndParentTamper.body, /not the parent engagement of this form/);
      assert.doesNotMatch(projectAndParentTamper.body, /does not belong to engagementId/);
      assert.equal(JSON.stringify(server.store.snapshot()), afterParentFix);

      // The stored parent ids are still derived from the URL, never the form,
      // including when the hidden parent controls are omitted entirely.
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
      assert.equal(server.store.snapshot().meetings.length, 2);
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
      // The rejected date keeps its exact submitted text in a text control, so
      // a browser does not sanitise it to empty on redisplay.
      assert.equal(correction.controls.get("date"), "2026-02-30");
      assert.match(invalid.body, /<input type="text" id="field-date" name="date" value="2026-02-30" required/);
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

      // An unknown submitted project on an edit is a correctable 400, not a
      // 404: the submitter can pick a real project and resubmit. The edit save
      // goes through the store with the supplied project rather than the create
      // path's project lookup. The refusal names the submitted project itself,
      // so the presentation boundary associates it with the project select:
      // the control is marked invalid, its own message carries the text and the
      // summary carries the same text. The rejected project stays selected.
      const unknownEdit = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: {
          id: meeting.id,
          title: "Unknown project",
          date: "2026-03-03",
          notes: "keep",
          projectId: "project-99",
        },
      });
      assert.equal(unknownEdit.status, 400);
      assert.doesNotMatch(unknownEdit.body, /Not found/);
      assert.match(String(unknownEdit.headers["content-type"]), /^text\/html/);
      assert.match(unknownEdit.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((unknownEdit.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const editMarked = invalidControls(unknownEdit.body);
      assert.equal(editMarked.length, 1);
      assert.equal(editMarked[0].field, "projectId");
      assert.match(
        unknownEdit.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      const editInline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(unknownEdit.body);
      assert.ok(editInline !== null);
      assert.equal(editInline[1], "No project with id &quot;project-99&quot;");
      assert.ok(unknownEdit.body.includes(`<li>${editInline[1]}</li>`));
      assert.match(unknownEdit.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      const unknownEditForm = parseForm(unknownEdit.body);
      assert.equal(unknownEditForm.controls.get("title"), "Unknown project");
      assert.equal(unknownEditForm.controls.get("date"), "2026-03-03");
      assert.equal(unknownEditForm.controls.get("notes"), "keep");
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);
      // Correcting the project on the rendered form and resubmitting saves the
      // change while the record's other fields are kept.
      unknownEditForm.controls.set("projectId", h.secondProject.id);
      const unknownFixed = await send(server.origin, {
        method: "POST",
        path: unknownEditForm.action,
        form: Object.fromEntries(unknownEditForm.controls),
      });
      assert.equal(redirectTarget(unknownFixed), `/meetings/${meeting.id}`);
      const unknownStored = server.store.snapshot().meetings.find(
        (candidate) => candidate.id === meeting.id,
      );
      assert.ok(unknownStored !== undefined);
      assert.equal(unknownStored.title, "Unknown project");
      assert.equal(unknownStored.projectId, h.secondProject.id);
      assert.equal(unknownStored.date, "2026-03-03");
      const afterUnknownFix = JSON.stringify(server.store.snapshot());
      assert.notEqual(afterUnknownFix, beforeEdit);

      // The project error is associated with the project control itself, even
      // when another visible value holds the same text: the title is sent as
      // the rejected project, appears before the select, and stays unmarked.
      const collisionEdit = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: meeting.id, title: "project-99", projectId: "project-99" },
      });
      assert.equal(collisionEdit.status, 400);
      assert.match(collisionEdit.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((collisionEdit.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const collisionMarked = invalidControls(collisionEdit.body);
      assert.equal(collisionMarked.length, 1);
      assert.equal(collisionMarked[0].field, "projectId");
      assert.doesNotMatch(collisionEdit.body, /id="field-title"[^>]*aria-invalid/);
      const collisionForm = parseForm(collisionEdit.body);
      assert.equal(collisionForm.controls.get("title"), "project-99");
      assert.equal(collisionForm.controls.get("projectId"), "project-99");

      // An invalid project holding characters the message has to escape (a
      // quote, a backslash, a newline, a tab) still matches its own
      // JSON-encoded refusal and points at the select, kept for correction.
      for (const value of ['meet-"99', "back\\slash", "line\nbreak", "tab\tvalue"]) {
        const escaped = await send(server.origin, {
          method: "POST",
          path: `/meetings/${meeting.id}/edit`,
          form: { id: meeting.id, title: "Escaped meeting", projectId: value },
        });
        assert.equal(escaped.status, 400, JSON.stringify(value));
        assert.doesNotMatch(escaped.body, /Not found/);
        assert.equal((escaped.body.match(/aria-invalid="true"/g) ?? []).length, 1, JSON.stringify(value));
        const escapedMarked = invalidControls(escaped.body);
        assert.equal(escapedMarked.length, 1, JSON.stringify(value));
        assert.equal(escapedMarked[0].field, "projectId", JSON.stringify(value));
        assert.match(
          escaped.body,
          /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
          JSON.stringify(value),
        );
        const escapedInline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(escaped.body);
        assert.ok(escapedInline !== null, JSON.stringify(value));
        assert.ok(escaped.body.includes(`<li>${escapedInline[1]}</li>`), JSON.stringify(value));
        const escapedForm = parseForm(escaped.body);
        assert.equal(escapedForm.controls.get("projectId"), value, JSON.stringify(value));
        assert.equal(escapedForm.controls.get("title"), "Escaped meeting", JSON.stringify(value));
      }

      // A project of another engagement on an edit reaches the store's own
      // refusal. It is a correctable 400 that keeps the submitted values, and
      // the parent-chain message is about the hidden engagement and client
      // links, not the project select, so it stays in the summary and marks no
      // control invalid. Nothing is written.
      const unassignableEdit = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: {
          id: meeting.id,
          title: "Unassignable",
          date: "2026-03-03",
          notes: "keep",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(unassignableEdit.status, 400);
      assert.match(unassignableEdit.body, /does not belong to engagementId/);
      assert.equal((unassignableEdit.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.doesNotMatch(unassignableEdit.body, /id="field-projectId"[^>]*aria-invalid/);
      assert.match(
        unassignableEdit.body,
        new RegExp(`<option value="${h.siblingProject.id}" selected>`),
      );
      assert.equal(parseForm(unassignableEdit.body).controls.get("title"), "Unassignable");
      assert.equal(JSON.stringify(server.store.snapshot()), afterUnknownFix);

      // A conflicting submitted id is refused on a form for the URL record.
      const conflicting = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: { id: "meeting-99", title: "x", date: "2026-03-03", notes: "" },
      });
      assert.equal(conflicting.status, 400);
      assert.match(conflicting.body, /does not match this URL/);
      assert.equal(JSON.stringify(server.store.snapshot()), afterUnknownFix);

      // A tampered engagement on an edit is refused even though the other
      // fields are valid and changed: the record does not move and the rest of
      // the submission is not saved.
      const editEngagementTamper = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: {
          id: meeting.id,
          engagementId: h.sibling.id,
          title: "Moved engagement",
          date: "2026-04-04",
          notes: "should not save",
          projectId: h.project.id,
        },
      });
      assert.equal(editEngagementTamper.status, 400);
      assert.match(editEngagementTamper.body, /role="alert"/);
      assert.match(editEngagementTamper.body, /not the parent engagement of this form/);
      assert.equal(JSON.stringify(server.store.snapshot()), afterUnknownFix);

      // A tampered client on an edit is refused the same way.
      const editClientTamper = await send(server.origin, {
        method: "POST",
        path: `/meetings/${meeting.id}/edit`,
        form: {
          id: meeting.id,
          clientId: h.otherClient.id,
          title: "Moved client",
          date: "2026-04-04",
          notes: "should not save",
        },
      });
      assert.equal(editClientTamper.status, 400);
      assert.match(editClientTamper.body, /not the client of this engagement/);
      // The message names the hidden client link, not a visible control.
      assert.equal((editClientTamper.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.equal(invalidControls(editClientTamper.body).length, 0);
      assert.equal(JSON.stringify(server.store.snapshot()), afterUnknownFix);

      // The stored parents still come from the record, never the form, and the
      // rejected submissions did not change anything.
      const storedAfterTamper = server.store.snapshot().meetings[0];
      assert.equal(storedAfterTamper.clientId, h.client.id);
      assert.equal(storedAfterTamper.engagementId, h.engagement.id);
      assert.equal(storedAfterTamper.title, "Unknown project");
      assert.equal(storedAfterTamper.date, "2026-03-03");
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
      assert.match(emptyPage.body, /No decisions recorded yet\./);
      // A client with no engagement is told to choose or create one before it
      // can add work, and the engagement's own page is the only next step.
      assert.match(emptyPage.body, /choose an engagement/i);
      assert.ok(!emptyPage.body.includes("/engagements//"));
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

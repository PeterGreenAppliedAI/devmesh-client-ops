import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { registerRoutes } from "../src/index.ts";
import { startServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";
import {
  badge,
  clientGuidance,
  displayList,
  displayValues,
  emptyState,
  engagementOnlyWork,
  groupedSections,
  matchWorkPath,
  openItemCount,
  primaryAction,
  projectWork,
  routeForWorkPattern,
  taskStatusCounts,
  workRoutes,
} from "../src/work-pages.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "work-pages-"));
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
async function running(): Promise<Running> {
  const store = await openStore(tempDir());
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
  // The canonical Host authority is set explicitly from the URL, so the same
  // request is sent on every platform; Node's own default Host header differs
  // between platforms and would otherwise fail the server's Host check.
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

/** The id at the end of a detail path redirect, such as `/tasks/task-1`. */
function idOf(reply: Reply): string {
  return redirectTarget(reply).split("/").pop() as string;
}

function containsEscaped(body: string, text: string): boolean {
  return body.includes(escapeHtml(text));
}

/** A rendered form as a browser would submit it. */
interface ParsedForm {
  readonly action: string;
  readonly controls: Map<string, string>;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
    assert.ok(document.includes(`id="${match.groups.described}"`), `${match.groups.field} describes a message`);
    found.push({ field: match.groups.field, describedBy: match.groups.described });
  }
  return found;
}

/** A client with an engagement, a sibling engagement and one project each. */
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

describe("work pages: tasks", () => {
  it("creates a task with every field through the rendered form and redirects", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // The create form is linked from the engagement and posts to its endpoint.
      const engagementPage = await send(server.origin, { path: `/engagements/${h.engagement.id}` });
      assert.equal(engagementPage.status, 200);
      assert.match(engagementPage.body, new RegExp(`href="/engagements/${h.engagement.id}/tasks/new"`));

      const formPage = await send(server.origin, { path: `/engagements/${h.engagement.id}/tasks/new` });
      assert.equal(formPage.status, 200);
      assert.match(formPage.body, /<form method="post"/);
      const form = parseForm(formPage.body);
      assert.equal(form.action, `/engagements/${h.engagement.id}/tasks/new`);
      // The parent engagement travels as a hidden field.
      assert.equal(form.controls.get("engagementId"), h.engagement.id);
      // The project choices are only the projects of this engagement.
      assert.match(formPage.body, new RegExp(`<option value="${h.project.id}">P</option>`));
      assert.match(formPage.body, new RegExp(`<option value="${h.secondProject.id}">P2</option>`));
      assert.ok(!formPage.body.includes(`<option value="${h.siblingProject.id}">`));
      // The form offers the no-project choice, and it is preselected.
      assert.equal(form.controls.get("projectId"), "");

      // Submit the rendered form with a value for every field.
      form.controls.set("title", "Ship <v1>");
      form.controls.set("status", "in_progress");
      form.controls.set("priority", "high");
      form.controls.set("owner", "Dana");
      form.controls.set("dueDate", "2027-02-28");
      form.controls.set("context", "Awaiting <approval>");
      form.controls.set("projectId", h.project.id);
      const created = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(created), /^\/tasks\/task-\d+$/);

      const stored = server.store.snapshot().tasks[0];
      assert.equal(stored.title, "Ship <v1>");
      assert.equal(stored.status, "in_progress");
      assert.equal(stored.priority, "high");
      assert.equal(stored.owner, "Dana");
      assert.equal(stored.dueDate, "2027-02-28");
      assert.equal(stored.context, "Awaiting <approval>");
      assert.equal(stored.projectId, h.project.id);
      // The client and engagement were derived from the parent, not the form.
      assert.equal(stored.clientId, h.client.id);
      assert.equal(stored.engagementId, h.engagement.id);

      // The detail page shows every field, escaped.
      const detail = await send(server.origin, { path: redirectTarget(created) });
      assert.equal(detail.status, 200);
      assert.ok(containsEscaped(detail.body, "Ship <v1>"));
      assert.ok(detail.body.includes("Awaiting &lt;approval&gt;"));
      // The detail page links to its edit workflow and to its parents.
      assert.match(detail.body, new RegExp(`href="/tasks/${stored.id}/edit"`));
      assert.match(detail.body, new RegExp(`href="/engagements/${h.engagement.id}"`));
      assert.match(detail.body, new RegExp(`href="/projects/${h.project.id}"`));
    } finally {
      await server.close();
    }
  });

  it("creates a task without a due date", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const created = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "No deadline",
          status: "open",
          priority: "normal",
          owner: "",
          dueDate: "",
          context: "",
          projectId: "",
        },
      });
      assert.match(redirectTarget(created), /^\/tasks\/task-\d+$/);
      const stored = server.store.snapshot().tasks[0];
      assert.equal(stored.dueDate, undefined);
      assert.equal("dueDate" in stored, false);
      assert.equal(stored.projectId, undefined);
      assert.equal("projectId" in stored, false);

      // A blank due date is offered as an empty control when editing.
      const edit = await send(server.origin, { path: `/tasks/${stored.id}/edit` });
      assert.equal(edit.status, 200);
      const form = parseForm(edit.body);
      assert.equal(form.action, `/tasks/${stored.id}/edit`);
      assert.equal(form.controls.get("dueDate"), "");
    } finally {
      await server.close();
    }
  });

  it("edits every field, reassigns and clears the project, and keeps omitted fields", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Original",
        status: "open",
        priority: "low",
        owner: "Old owner",
        dueDate: "2026-01-01",
        context: "old context",
      });

      const editPage = await send(server.origin, { path: `/tasks/${task.id}/edit` });
      assert.equal(editPage.status, 200);
      const form = parseForm(editPage.body);
      assert.equal(form.action, `/tasks/${task.id}/edit`);
      assert.equal(form.controls.get("id"), task.id);
      // The record id and immutable parents travel as hidden controls, so the
      // edit names the same record and the same parent engagement and client.
      assert.equal(form.controls.get("engagementId"), h.engagement.id);
      assert.equal(form.controls.get("clientId"), h.client.id);
      // The form starts from the stored record, including its project.
      assert.equal(form.controls.get("title"), "Original");
      assert.equal(form.controls.get("status"), "open");
      assert.equal(form.controls.get("priority"), "low");
      assert.equal(form.controls.get("owner"), "Old owner");
      assert.equal(form.controls.get("dueDate"), "2026-01-01");
      assert.equal(form.controls.get("context"), "old context");
      assert.equal(form.controls.get("projectId"), h.project.id);
      // Only this engagement's projects are offered.
      assert.ok(!editPage.body.includes(`<option value="${h.siblingProject.id}">`));

      // Reassign to another project of the same engagement.
      form.controls.set("title", "Edited");
      form.controls.set("status", "done");
      form.controls.set("priority", "high");
      form.controls.set("owner", "New owner");
      form.controls.set("dueDate", "2027-12-31");
      form.controls.set("context", "new context");
      form.controls.set("projectId", h.secondProject.id);
      const saved = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.equal(redirectTarget(saved), `/tasks/${task.id}`);
      let stored = server.store.snapshot().tasks[0];
      assert.equal(stored.title, "Edited");
      assert.equal(stored.status, "done");
      assert.equal(stored.priority, "high");
      assert.equal(stored.owner, "New owner");
      assert.equal(stored.dueDate, "2027-12-31");
      assert.equal(stored.context, "new context");
      assert.equal(stored.projectId, h.secondProject.id);

      // A blank project select clears the link.
      const cleared = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { title: "Edited", status: "done", priority: "high", owner: "New owner", dueDate: "2027-12-31", context: "new context", projectId: "" },
      });
      assert.equal(redirectTarget(cleared), `/tasks/${task.id}`);
      stored = server.store.snapshot().tasks[0];
      assert.equal(stored.projectId, undefined);
      assert.equal("projectId" in stored, false);
      // Everything else was kept.
      assert.equal(stored.title, "Edited");
      assert.equal(stored.context, "new context");

      // A title-only edit changes only the title and clears nothing.
      const assignAgain = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { title: "Edited", status: "done", priority: "high", owner: "New owner", dueDate: "2027-12-31", context: "new context", projectId: h.project.id },
      });
      assert.equal(redirectTarget(assignAgain), `/tasks/${task.id}`);
      const nameOnly = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { title: "Renamed only" },
      });
      assert.equal(redirectTarget(nameOnly), `/tasks/${task.id}`);
      stored = server.store.snapshot().tasks[0];
      assert.equal(stored.title, "Renamed only");
      assert.equal(stored.status, "done");
      assert.equal(stored.priority, "high");
      assert.equal(stored.owner, "New owner");
      assert.equal(stored.dueDate, "2027-12-31");
      assert.equal(stored.context, "new context");
      assert.equal(stored.projectId, h.project.id);
    } finally {
      await server.close();
    }
  });

  it("rejects tampered cross-engagement project ids on create and edit without mutating", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      // A create with a project of a sibling engagement is refused.
      const tamperedCreate = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "Tampered",
          status: "open",
          priority: "normal",
          owner: "keep me",
          dueDate: "",
          context: "",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(tamperedCreate.status, 400);
      assert.match(String(tamperedCreate.headers["content-type"]), /^text\/html/);
      assert.match(tamperedCreate.body, /role="alert"/);
      assert.match(tamperedCreate.body, /does not belong to engagementId/);
      // The submitted values and the rejected project stay on the form.
      const corrected = parseForm(tamperedCreate.body);
      assert.equal(corrected.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(corrected.controls.get("engagementId"), h.engagement.id);
      assert.equal(corrected.controls.get("title"), "Tampered");
      assert.equal(corrected.controls.get("owner"), "keep me");
      // The rejected project is shown as the selected option for correction.
      assert.match(tamperedCreate.body, new RegExp(`<option value="${h.siblingProject.id}" selected>`));
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A task in the engagement cannot be moved to a sibling's project.
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Stay",
        projectId: h.project.id,
      });
      const beforeEdit = JSON.stringify(server.store.snapshot());
      const tamperedEdit = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { id: task.id, title: "Hijacked", projectId: h.siblingProject.id },
      });
      assert.equal(tamperedEdit.status, 400);
      assert.match(tamperedEdit.body, /role="alert"/);
      const editCorrection = parseForm(tamperedEdit.body);
      assert.equal(editCorrection.action, `/tasks/${task.id}/edit`);
      assert.equal(editCorrection.controls.get("title"), "Hijacked");
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      // A supplied parent that differs from the URL parent is refused on a
      // create, and nothing is written.
      const parentTamper = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.sibling.id,
          clientId: h.otherClient.id,
          title: "Parent tamper",
          status: "open",
          priority: "normal",
          owner: "keep parent owner",
          dueDate: "",
          context: "",
          projectId: "",
        },
      });
      assert.equal(parentTamper.status, 400);
      assert.match(String(parentTamper.headers["content-type"]), /^text\/html/);
      assert.match(parentTamper.body, /not the parent engagement of this form/);
      // The submitted values are kept on the correction form, which still posts
      // to the URL parent's endpoint with the URL parent in its hidden control.
      const parentCorrection = parseForm(parentTamper.body);
      assert.equal(parentCorrection.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(parentCorrection.controls.get("engagementId"), h.engagement.id);
      assert.equal(parentCorrection.controls.get("title"), "Parent tamper");
      assert.equal(parentCorrection.controls.get("owner"), "keep parent owner");
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);
    } finally {
      await server.close();
    }
  });

  it("shows a correctable error with submitted values and redirects after correction", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "   ",
          status: "active",
          priority: "high",
          owner: "keep owner",
          dueDate: "2027-02-30",
          context: "keep context",
          projectId: h.project.id,
        },
      });
      assert.equal(invalid.status, 400);
      assert.match(String(invalid.headers["content-type"]), /^text\/html/);
      assert.match(invalid.body, /role="alert"/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
      const form = parseForm(invalid.body);
      // Every submitted value is kept, including the invalid status and date.
      assert.equal(form.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(form.controls.get("title"), "   ");
      assert.equal(form.controls.get("status"), "active");
      assert.equal(form.controls.get("priority"), "high");
      assert.equal(form.controls.get("owner"), "keep owner");
      assert.equal(form.controls.get("dueDate"), "2027-02-30");
      assert.equal(form.controls.get("context"), "keep context");
      assert.equal(form.controls.get("projectId"), h.project.id);
      assert.equal(form.controls.get("engagementId"), h.engagement.id);
      // The rejected status is shown as the selected, marked option.
      assert.match(invalid.body, /<option value="active" selected>active \(not a valid choice\)<\/option>/);
      // Fail-fast validation names the first problem, the blank title, and that
      // visible control is marked invalid with its own message.
      assert.match(invalid.body, /task\.title must be nonblank/);
      assert.match(
        invalid.body,
        /<input type="text" id="field-title" name="title" value="   " required aria-invalid="true" aria-describedby="field-title-error">/,
      );
      assert.match(invalid.body, /<p id="field-title-error">task\.title must be nonblank<\/p>/);

      // Correct the title and resubmit the rendered form; it redirects.
      form.controls.set("title", "Fixed");
      form.controls.set("status", "in_progress");
      form.controls.set("dueDate", "2027-02-28");
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(corrected), /^\/tasks\/task-\d+$/);
      const stored = server.store.snapshot().tasks[0];
      assert.equal(stored.title, "Fixed");
      assert.equal(stored.status, "in_progress");
      assert.equal(stored.owner, "keep owner");
      assert.equal(stored.dueDate, "2027-02-28");
    } finally {
      await server.close();
    }
  });

  it("associates enum and date errors with the visible control that caused them", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      for (const [path, form, field, id, message] of [
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { title: "T", status: "active", priority: "high", owner: "", dueDate: "", context: "", projectId: "" },
          "status",
          "select",
          /task\.status must be one of/,
        ],
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { title: "T", status: "open", priority: "high", owner: "", dueDate: "not-a-date", context: "", projectId: "" },
          "dueDate",
          "input",
          /task\.dueDate must be a YYYY-MM-DD date/,
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { kind: "question", title: "I", context: "", state: "closed-ish", projectId: "" },
          "state",
          "select",
          /item\.state must be one of/,
        ],
      ] as const) {
        const before = JSON.stringify(server.store.snapshot());
        const reply = await send(server.origin, {
          method: "POST",
          path,
          form: { engagementId: h.engagement.id, ...form },
        });
        assert.equal(reply.status, 400, `${path} ${field}`);
        // Only the failing field's control is marked invalid, and it points at
        // a message that carries the same text as the summary entry.
        const marked = reply.body.match(/aria-invalid="true"/g) ?? [];
        assert.equal(marked.length, 1, `${path} ${field} marks one control`);
        assert.match(
          reply.body,
          new RegExp(
            `<${id}[^>]*\\sid="field-${field}"[^>]*\\saria-invalid="true"[^>]*\\saria-describedby="field-${field}-error"`,
          ),
        );
        assert.match(reply.body, message, `${path} ${field} summary text`);
        assert.equal(JSON.stringify(server.store.snapshot()), before, `${path} ${field}`);
      }
    } finally {
      await server.close();
    }
  });

  it("refuses create/edit parent mismatches, accepting blank, matching and omitted parents", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // Create: an omitted, blank or matching parent is valid; a differing
      // parent is a correctable 400 that writes nothing.
      const createUrl = `/engagements/${h.engagement.id}/tasks/new`;
      const base = { title: "Parent check", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: "" };
      const omitted = await send(server.origin, { method: "POST", path: createUrl, form: base });
      assert.match(redirectTarget(omitted), /^\/tasks\/task-\d+$/);
      const matching = await send(server.origin, {
        method: "POST",
        path: createUrl,
        form: { engagementId: h.engagement.id, ...base },
      });
      assert.match(redirectTarget(matching), /^\/tasks\/task-\d+$/);

      const beforeBlank = JSON.stringify(server.store.snapshot());
      const blank = await send(server.origin, {
        method: "POST",
        path: createUrl,
        form: { engagementId: "", ...base },
      });
      assert.equal(blank.status, 400);
      assert.match(blank.body, /not the parent engagement of this form/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeBlank);
      // A hidden identity error has no control of its own.
      assert.equal((blank.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      // The correction keeps the URL parent in its hidden control.
      assert.equal(parseForm(blank.body).controls.get("engagementId"), h.engagement.id);

      const beforeOther = JSON.stringify(server.store.snapshot());
      const other = await send(server.origin, {
        method: "POST",
        path: createUrl,
        form: { engagementId: h.sibling.id, ...base },
      });
      assert.equal(other.status, 400);
      assert.match(other.body, /not the parent engagement of this form/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeOther);

      // Edit: omitted or matching parents are valid; a differing client,
      // engagement or blank parent is refused before the store saves anything.
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Edit parent",
        owner: "keep",
      });
      const editUrl = `/tasks/${task.id}/edit`;
      const beforeEdit = JSON.stringify(server.store.snapshot());
      const editMismatch = await send(server.origin, {
        method: "POST",
        path: editUrl,
        form: { id: task.id, title: "Renamed", engagementId: h.sibling.id },
      });
      assert.equal(editMismatch.status, 400);
      assert.match(editMismatch.body, /not the parent engagement of this form/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      const editClientMismatch = await send(server.origin, {
        method: "POST",
        path: editUrl,
        form: { id: task.id, title: "Renamed", clientId: h.otherClient.id },
      });
      assert.equal(editClientMismatch.status, 400);
      assert.match(editClientMismatch.body, /not the client of this engagement/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      // A present blank parent on an edit is a mismatch too: a blank parent
      // differs from the stored one, so it is refused and writes nothing.
      for (const form of [
        { id: task.id, title: "Renamed", engagementId: "" },
        { id: task.id, title: "Renamed", clientId: "" },
        { id: task.id, title: "Renamed", engagementId: h.engagement.id, clientId: "" },
        { id: task.id, title: "Renamed", engagementId: "", clientId: h.client.id },
      ] as readonly Record<string, string>[]) {
        const blankEdit = await send(server.origin, { method: "POST", path: editUrl, form });
        assert.equal(blankEdit.status, 400, JSON.stringify(form));
        assert.match(
          blankEdit.body,
          /not the (parent engagement|client) of this/,
          JSON.stringify(form),
        );
        assert.equal((blankEdit.body.match(/aria-invalid="true"/g) ?? []).length, 0);
        assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit, JSON.stringify(form));
      }

      // An existing identity conflict takes precedence over a parent mismatch.
      const precedence = await send(server.origin, {
        method: "POST",
        path: editUrl,
        form: { id: "task-99", title: "Renamed", engagementId: h.sibling.id },
      });
      assert.equal(precedence.status, 400);
      assert.match(precedence.body, /does not match this URL/);
      assert.doesNotMatch(precedence.body, /not the parent engagement/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      // A matching-parent edit with omitted values keeps the stored fields.
      const ok = await send(server.origin, {
        method: "POST",
        path: editUrl,
        form: { id: task.id, title: "Renamed", engagementId: h.engagement.id, clientId: h.client.id },
      });
      assert.match(redirectTarget(ok), /^\/tasks\/task-\d+$/);
      const stored = server.store.snapshot().tasks.find((candidate) => candidate.id === task.id);
      assert.ok(stored !== undefined);
      assert.equal(stored.title, "Renamed");
      assert.equal(stored.owner, "keep");
      assert.equal(stored.engagementId, h.engagement.id);
      assert.equal(stored.clientId, h.client.id);

      // The same rules hold for work items.
      const itemCreateUrl = `/engagements/${h.engagement.id}/items/new`;
      const itemBase = { kind: "question", title: "Item parent", context: "", state: "open", projectId: "" };
      const itemOmitted = await send(server.origin, { method: "POST", path: itemCreateUrl, form: itemBase });
      assert.match(redirectTarget(itemOmitted), /^\/items\/item-\d+$/);
      const itemMatching = await send(server.origin, {
        method: "POST",
        path: itemCreateUrl,
        form: { engagementId: h.engagement.id, ...itemBase },
      });
      assert.match(redirectTarget(itemMatching), /^\/items\/item-\d+$/);
      for (const parent of ["", h.sibling.id]) {
        const beforeItem = JSON.stringify(server.store.snapshot());
        const itemConflict = await send(server.origin, {
          method: "POST",
          path: itemCreateUrl,
          form: { engagementId: parent, ...itemBase },
        });
        assert.equal(itemConflict.status, 400, JSON.stringify(parent));
        assert.match(itemConflict.body, /not the parent engagement of this form/);
        assert.equal(JSON.stringify(server.store.snapshot()), beforeItem);
      }

      const item = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "question",
        title: "Item edit parent",
        context: "keep item",
      });
      const itemEditUrl = `/items/${item.id}/edit`;
      const beforeItemEdit = JSON.stringify(server.store.snapshot());
      const itemEditMismatch = await send(server.origin, {
        method: "POST",
        path: itemEditUrl,
        form: { id: item.id, title: "Renamed item", engagementId: h.sibling.id },
      });
      assert.equal(itemEditMismatch.status, 400);
      assert.match(itemEditMismatch.body, /not the parent engagement of this form/);
      const itemEditClientMismatch = await send(server.origin, {
        method: "POST",
        path: itemEditUrl,
        form: { id: item.id, title: "Renamed item", clientId: h.otherClient.id },
      });
      assert.equal(itemEditClientMismatch.status, 400);
      assert.match(itemEditClientMismatch.body, /not the client of this engagement/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeItemEdit);

      // A present blank or differing parent on an item edit is refused and
      // writes nothing.
      for (const form of [
        { id: item.id, title: "Renamed item", engagementId: "" },
        { id: item.id, title: "Renamed item", clientId: "" },
        { id: item.id, title: "Renamed item", engagementId: h.engagement.id, clientId: "" },
      ] as readonly Record<string, string>[]) {
        const blankEdit = await send(server.origin, { method: "POST", path: itemEditUrl, form });
        assert.equal(blankEdit.status, 400, JSON.stringify(form));
        assert.match(
          blankEdit.body,
          /not the (parent engagement|client) of this/,
          JSON.stringify(form),
        );
        assert.equal((blankEdit.body.match(/aria-invalid="true"/g) ?? []).length, 0);
        assert.equal(JSON.stringify(server.store.snapshot()), beforeItemEdit, JSON.stringify(form));
      }

      const itemPrecedence = await send(server.origin, {
        method: "POST",
        path: itemEditUrl,
        form: { id: "item-99", title: "Renamed item", clientId: h.otherClient.id },
      });
      assert.equal(itemPrecedence.status, 400);
      assert.match(itemPrecedence.body, /does not match this URL/);
      assert.doesNotMatch(itemPrecedence.body, /not the client of this engagement/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeItemEdit);
      const itemOk = await send(server.origin, {
        method: "POST",
        path: itemEditUrl,
        form: { id: item.id, title: "Renamed item", engagementId: h.engagement.id, clientId: h.client.id },
      });
      assert.match(redirectTarget(itemOk), /^\/items\/item-\d+$/);
      const storedItem = server.store.snapshot().items.find((candidate) => candidate.id === item.id);
      assert.ok(storedItem !== undefined);
      assert.equal(storedItem.title, "Renamed item");
      assert.equal(storedItem.context, "keep item");
      assert.equal(storedItem.engagementId, h.engagement.id);
      assert.equal(storedItem.clientId, h.client.id);
    } finally {
      await server.close();
    }
  });

  it("refuses isolated client, engagement and project parent mismatches on create", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const taskBase = { title: "T", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: "" };
      const itemBase = { kind: "question", title: "I", context: "", state: "open", projectId: "" };

      // A create that names a different engagement without a conflicting
      // record id, for both tasks and items, writes nothing.
      for (const [path, form, url] of [
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { ...taskBase, engagementId: h.sibling.id },
          /not the parent engagement of this form/,
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { ...itemBase, engagementId: h.sibling.id },
          /not the parent engagement of this form/,
        ],
        // A client id that names a different client is refused on its own.
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { ...taskBase, clientId: h.otherClient.id },
          /not the client of this engagement/,
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { ...itemBase, clientId: h.otherClient.id },
          /not the client of this engagement/,
        ],
        // A present blank client id is refused too.
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { ...taskBase, engagementId: h.engagement.id, clientId: "" },
          /not the client of this engagement/,
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { ...itemBase, engagementId: h.engagement.id, clientId: "" },
          /not the client of this engagement/,
        ],
      ] as const) {
        const before = JSON.stringify(server.store.snapshot());
        const reply = await send(server.origin, { method: "POST", path, form });
        assert.equal(reply.status, 400, `${path} ${JSON.stringify(form)}`);
        assert.match(reply.body, url, path);
        // The conflict is on a hidden parent link, so no visible control is
        // marked invalid and the correction still posts the URL parent.
        assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, 0, path);
        assert.equal(parseForm(reply.body).controls.get("engagementId"), h.engagement.id, path);
        assert.equal(JSON.stringify(server.store.snapshot()), before, path);
      }
    } finally {
      await server.close();
    }
  });

  it("keeps parent and identity refusals in the summary even when they quote a field name", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const taskBase = { title: "Quoted", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: "" };
      const itemBase = { kind: "question", title: "Quoted", context: "", state: "open", projectId: "" };

      // A tampered parent whose value is a visible field name is still about
      // the hidden parent link: the summary carries it, the named control is
      // not marked invalid, and nothing is written.
      for (const [path, form] of [
        [`/engagements/${h.engagement.id}/tasks/new`, { ...taskBase, engagementId: "title" }],
        [`/engagements/${h.engagement.id}/tasks/new`, { ...taskBase, clientId: "notes" }],
        [`/engagements/${h.engagement.id}/items/new`, { ...itemBase, engagementId: "kind" }],
        [`/engagements/${h.engagement.id}/items/new`, { ...itemBase, clientId: "context" }],
        // A parent value quoting a visible field name together with other words
        // is still one value: it names the hidden parent link, not the control.
        [`/engagements/${h.engagement.id}/tasks/new`, { ...taskBase, engagementId: "x projectId y" }],
        [`/engagements/${h.engagement.id}/tasks/new`, { ...taskBase, clientId: "owner title" }],
        // A parent value carrying an escaped quote (`x\" title`) stays quoted
        // through its closing quote, so the visible word after it is not named.
        [`/engagements/${h.engagement.id}/items/new`, { ...itemBase, engagementId: "x\\\" title" }],
        [`/engagements/${h.engagement.id}/items/new`, { ...itemBase, clientId: "x\\\" context" }],
      ] as const) {
        const before = JSON.stringify(server.store.snapshot());
        const reply = await send(server.origin, { method: "POST", path, form });
        assert.equal(reply.status, 400, `${path} ${JSON.stringify(form)}`);
        assert.match(reply.body, /not the (parent engagement|client) of this/, path);
        assert.match(reply.body, /role="alert"/, path);
        assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, 0, path);
        assert.equal(invalidControls(reply.body).length, 0, path);
        assert.equal(JSON.stringify(server.store.snapshot()), before, path);
      }

      // The same holds on an edit: the hidden parent link refuses the write
      // while the quoted field-name value marks no control invalid.
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Keep task",
        owner: "keep",
      });
      const item = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "blocker",
        title: "Keep item",
        context: "keep context",
      });
      const beforeEdit = JSON.stringify(server.store.snapshot());
      for (const [path, form] of [
        [`/tasks/${task.id}/edit`, { id: task.id, title: "Renamed", engagementId: "title" }],
        [`/tasks/${task.id}/edit`, { id: task.id, title: "Renamed", clientId: "owner" }],
        [`/items/${item.id}/edit`, { id: item.id, title: "Renamed item", engagementId: "kind" }],
        [`/items/${item.id}/edit`, { id: item.id, title: "Renamed item", clientId: "context" }],
      ] as const) {
        const reply = await send(server.origin, { method: "POST", path, form });
        assert.equal(reply.status, 400, `${path} ${JSON.stringify(form)}`);
        assert.match(reply.body, /not the (parent engagement|client) of this/, path);
        assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, 0, path);
        assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit, path);
      }
    } finally {
      await server.close();
    }
  });

  it("refuses project-scoped creation parent mismatches for tasks and items", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const taskBase = { title: "Project scoped", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: h.project.id };
      const itemBase = { kind: "question", title: "Item project scoped", context: "", state: "open", projectId: h.project.id };

      // The URL project's engagement is the parent of the form. Matching and
      // omitted parents create under it; another engagement or a blank one is a
      // correctable 400 that writes nothing.
      const matchingTask = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/tasks/new`,
        form: { engagementId: h.engagement.id, ...taskBase },
      });
      assert.match(redirectTarget(matchingTask), /^\/tasks\/task-\d+$/);
      const omittedItem = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/items/new`,
        form: itemBase,
      });
      assert.match(redirectTarget(omittedItem), /^\/items\/item-\d+$/);

      for (const [path, form] of [
        [`/projects/${h.project.id}/tasks/new`, { ...taskBase, engagementId: h.sibling.id }],
        [`/projects/${h.project.id}/tasks/new`, { ...taskBase, engagementId: "" }],
        [`/projects/${h.project.id}/items/new`, { ...itemBase, engagementId: h.sibling.id }],
        [`/projects/${h.project.id}/items/new`, { ...itemBase, engagementId: "" }],
      ] as const) {
        const before = JSON.stringify(server.store.snapshot());
        const reply = await send(server.origin, { method: "POST", path, form });
        assert.equal(reply.status, 400, `${path} ${JSON.stringify(form)}`);
        assert.match(reply.body, /not the parent engagement of this form/, path);
        // The correction keeps the URL engagement in its hidden control.
        assert.equal(parseForm(reply.body).controls.get("engagementId"), h.engagement.id, path);
        assert.equal(JSON.stringify(server.store.snapshot()), before, path);
      }
    } finally {
      await server.close();
    }
  });

  it("settles a parent mismatch before any invalid submitted project or invalid field", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      // A parent mismatch wins over an unknown submitted project: the message
      // is about the parent and the submission is refused before the project
      // is resolved. It also wins over an invalid visible field.
      for (const [path, form] of [
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { title: "T", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: "project-99", engagementId: h.sibling.id },
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { kind: "question", title: "I", context: "", state: "open", projectId: "project-99", engagementId: h.sibling.id },
        ],
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { title: "", status: "not-a-status", priority: "normal", owner: "", dueDate: "not-a-date", context: "", projectId: "", engagementId: h.sibling.id },
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { kind: "question", title: "", context: "", state: "not-a-state", projectId: "", engagementId: h.sibling.id },
        ],
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { title: "T", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: "project-99", clientId: h.otherClient.id },
        ],
      ] as const) {
        const reply = await send(server.origin, { method: "POST", path, form });
        assert.equal(reply.status, 400, path);
        assert.match(reply.body, /not the (parent engagement|client) of this/, path);
        assert.doesNotMatch(reply.body, /is not a project of this engagement/, path);
        assert.doesNotMatch(reply.body, /must be one of/, path);
        assert.doesNotMatch(reply.body, /must be a YYYY-MM-DD date/, path);
        // A quoted submitted value that reads like a field never marks it.
        assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, 0, path);
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Conflict precedence on edit: a differing submitted id wins over both a
      // parent mismatch and an invalid visible field.
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Precedence",
      });
      const editBefore = JSON.stringify(server.store.snapshot());
      const precedence = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { id: "task-99", title: "", engagementId: h.sibling.id, clientId: h.otherClient.id },
      });
      assert.equal(precedence.status, 400);
      assert.match(precedence.body, /does not match this URL/);
      assert.doesNotMatch(precedence.body, /not the parent engagement/);
      assert.doesNotMatch(precedence.body, /not the client of this engagement/);
      assert.doesNotMatch(precedence.body, /must be nonblank/);
      assert.equal(JSON.stringify(server.store.snapshot()), editBefore);
    } finally {
      await server.close();
    }
  });

  it("keeps omitted fields on a corrected edit for tasks and items", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Omit task",
        status: "in_progress",
        priority: "high",
        owner: "Owner",
        dueDate: "2026-01-02",
        context: "Keep context",
      });
      const item = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "blocker",
        title: "Omit item",
        context: "Keep item context",
        state: "open",
      });
      const before = JSON.stringify(server.store.snapshot());

      // A blank title with every other field omitted: the correction shows the
      // submitted blank title and the stored values of the omitted controls.
      const invalidTask = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { id: task.id, title: "" },
      });
      assert.equal(invalidTask.status, 400);
      assert.equal((invalidTask.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const taskForm = parseForm(invalidTask.body);
      assert.equal(taskForm.controls.get("title"), "");
      assert.equal(taskForm.controls.get("status"), "in_progress");
      assert.equal(taskForm.controls.get("priority"), "high");
      assert.equal(taskForm.controls.get("owner"), "Owner");
      assert.equal(taskForm.controls.get("dueDate"), "2026-01-02");
      assert.equal(taskForm.controls.get("context"), "Keep context");

      const invalidItem = await send(server.origin, {
        method: "POST",
        path: `/items/${item.id}/edit`,
        form: { id: item.id, title: "" },
      });
      assert.equal(invalidItem.status, 400);
      assert.equal((invalidItem.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const itemForm = parseForm(invalidItem.body);
      assert.equal(itemForm.controls.get("title"), "");
      assert.equal(itemForm.controls.get("kind"), "blocker");
      assert.equal(itemForm.controls.get("state"), "open");
      assert.equal(itemForm.controls.get("context"), "Keep item context");

      // The refused submissions saved nothing.
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the title on the rendered form and resubmitting the whole
      // correction form saves it and keeps every value it carries, including
      // the stored values the original submission omitted.
      taskForm.controls.set("title", "Corrected task");
      const corrected = await send(server.origin, {
        method: "POST",
        path: taskForm.action,
        form: Object.fromEntries(taskForm.controls),
      });
      assert.match(redirectTarget(corrected), /^\/tasks\/task-\d+$/);
      const storedTask = server.store.snapshot().tasks.find((candidate) => candidate.id === task.id);
      assert.ok(storedTask !== undefined);
      assert.equal(storedTask.title, "Corrected task");
      assert.equal(storedTask.status, "in_progress");
      assert.equal(storedTask.priority, "high");
      assert.equal(storedTask.owner, "Owner");
      assert.equal(storedTask.dueDate, "2026-01-02");
      assert.equal(storedTask.context, "Keep context");

      itemForm.controls.set("title", "Corrected item");
      const correctedItem = await send(server.origin, {
        method: "POST",
        path: itemForm.action,
        form: Object.fromEntries(itemForm.controls),
      });
      assert.match(redirectTarget(correctedItem), /^\/items\/item-\d+$/);
      const storedItem = server.store.snapshot().items.find((candidate) => candidate.id === item.id);
      assert.ok(storedItem !== undefined);
      assert.equal(storedItem.title, "Corrected item");
      assert.equal(storedItem.kind, "blocker");
      assert.equal(storedItem.state, "open");
      assert.equal(storedItem.context, "Keep item context");
    } finally {
      await server.close();
    }
  });

  it("associates a project error but keeps an unassignable project in the summary", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // A select project that does not exist is the form's own visible choice,
      // so its control is marked invalid with its own message.
      for (const [path, form, base] of [
        [
          `/engagements/${h.engagement.id}/tasks/new`,
          { title: "T", status: "open", priority: "normal", owner: "", dueDate: "", context: "", projectId: "project-99" },
          /tasks\/task-/,
        ],
        [
          `/engagements/${h.engagement.id}/items/new`,
          { kind: "question", title: "I", context: "", state: "open", projectId: "project-99" },
          /items\/item-/,
        ],
      ] as const) {
        const reply = await send(server.origin, {
          method: "POST",
          path,
          form: { engagementId: h.engagement.id, ...form },
        });
        assert.equal(reply.status, 400, path);
        const marked = reply.body.match(/aria-invalid="true"/g) ?? [];
        assert.equal(marked.length, 1, path);
        assert.match(
          reply.body,
          /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
          path,
        );
        // The rejected value stays selected and escaped.
        assert.match(reply.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/, path);
        // The summary carries the same message as the associated control.
        const inline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(reply.body);
        assert.ok(inline !== null, path);
        assert.ok(reply.body.includes(`<li>${inline[1]}</li>`), path);
      }

      // A project of another engagement reaches the store's own refusal. It is
      // a correctable error with the submitted project kept and selected, and
      // the parent-chain message is about the hidden engagement and client
      // links, not the project select: it stays in the summary and marks no
      // control invalid. Nothing is written.
      const before = JSON.stringify(server.store.snapshot());
      const unassignable = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "Unassignable",
          status: "open",
          priority: "low",
          owner: "",
          dueDate: "",
          context: "",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(unassignable.status, 400);
      assert.match(unassignable.body, /does not belong to engagementId/);
      assert.equal((unassignable.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.doesNotMatch(unassignable.body, /id="field-projectId"[^>]*aria-invalid/);
      assert.doesNotMatch(unassignable.body, /<p id=|<ul><li>[^<]*<\/li><\/ul>/);
      assert.match(unassignable.body, new RegExp(`<option value="${h.siblingProject.id}" selected>`));
      assert.equal(parseForm(unassignable.body).controls.get("title"), "Unassignable");
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("refuses a nonexistent submitted project as a correctable error, not a 404", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      // A create naming a project that does not exist keeps every submitted
      // value so the user can pick a real project and resubmit.
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "Unknown project",
          status: "open",
          priority: "high",
          owner: "keep owner",
          dueDate: "",
          context: "keep context",
          projectId: "project-99",
        },
      });
      assert.equal(invalid.status, 400);
      assert.match(String(invalid.headers["content-type"]), /^text\/html/);
      assert.match(invalid.body, /role="alert"/);
      assert.doesNotMatch(invalid.body, /Not found/);
      const form = parseForm(invalid.body);
      assert.equal(form.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(form.controls.get("title"), "Unknown project");
      assert.equal(form.controls.get("owner"), "keep owner");
      assert.equal(form.controls.get("context"), "keep context");
      // The rejected project is shown selected for correction.
      assert.match(invalid.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the project and resubmitting the rendered form saves it.
      form.controls.set("projectId", h.secondProject.id);
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(corrected), /^\/tasks\/task-\d+$/);
      const stored = server.store.snapshot().tasks[0];
      assert.equal(stored.title, "Unknown project");
      assert.equal(stored.projectId, h.secondProject.id);

      // An edit naming a nonexistent project keeps the submitted values and
      // the record's untouched fields, and the record is unchanged.
      const beforeEdit = JSON.stringify(server.store.snapshot());
      const invalidEdit = await send(server.origin, {
        method: "POST",
        path: `/tasks/${stored.id}/edit`,
        form: { id: stored.id, title: "Edited unknown", projectId: "project-99" },
      });
      assert.equal(invalidEdit.status, 400);
      assert.doesNotMatch(invalidEdit.body, /Not found/);
      // The edit save goes through the store with the supplied project rather
      // than the create path's project lookup. The refusal names the submitted
      // project itself, so the presentation boundary associates it with the
      // project select: the control is marked invalid, its own message carries
      // the text and the summary carries the same text. The rejected project
      // stays selected for correction.
      assert.match(invalidEdit.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((invalidEdit.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const editInvalid = invalidControls(invalidEdit.body);
      assert.equal(editInvalid.length, 1);
      assert.equal(editInvalid[0].field, "projectId");
      assert.match(
        invalidEdit.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      const editInline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(invalidEdit.body);
      assert.ok(editInline !== null);
      assert.equal(editInline[1], "No project with id &quot;project-99&quot;");
      assert.ok(invalidEdit.body.includes(`<li>${editInline[1]}</li>`));
      assert.match(invalidEdit.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      const editForm = parseForm(invalidEdit.body);
      assert.equal(editForm.action, `/tasks/${stored.id}/edit`);
      assert.equal(editForm.controls.get("title"), "Edited unknown");
      assert.equal(editForm.controls.get("owner"), "keep owner");
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      // The same holds for work items.
      const invalidItem = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/items/new`,
        form: {
          engagementId: h.engagement.id,
          kind: "question",
          title: "Item unknown project",
          context: "keep",
          state: "open",
          projectId: "project-99",
        },
      });
      assert.equal(invalidItem.status, 400);
      // A select project that does not exist is the item form's own visible
      // choice, so its control and message are associated.
      assert.equal((invalidItem.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.equal(invalidControls(invalidItem.body).length, 1);
      assert.equal(invalidControls(invalidItem.body)[0].field, "projectId");
      assert.match(
        invalidItem.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      assert.match(invalidItem.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      const itemInline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(invalidItem.body);
      assert.ok(itemInline !== null);
      assert.ok(invalidItem.body.includes(`<li>${itemInline[1]}</li>`));
      const itemForm = parseForm(invalidItem.body);
      assert.equal(itemForm.controls.get("title"), "Item unknown project");
      assert.equal(itemForm.controls.get("context"), "keep");
      assert.equal(JSON.stringify(server.store.snapshot()), beforeEdit);

      // A work item edit is associated the same way: the store's missing-record
      // refusal for a nonexistent supplied project points at the item select.
      const storedItem = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "question",
        title: "Edit item",
        context: "context",
        state: "open",
        projectId: h.project.id,
      });
      const itemEditBefore = JSON.stringify(server.store.snapshot());
      const invalidItemEdit = await send(server.origin, {
        method: "POST",
        path: `/items/${storedItem.id}/edit`,
        form: { id: storedItem.id, projectId: "project-99" },
      });
      assert.equal(invalidItemEdit.status, 400);
      assert.match(invalidItemEdit.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((invalidItemEdit.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.equal(invalidControls(invalidItemEdit.body).length, 1);
      assert.equal(invalidControls(invalidItemEdit.body)[0].field, "projectId");
      const itemEditInline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(invalidItemEdit.body);
      assert.ok(itemEditInline !== null);
      assert.ok(invalidItemEdit.body.includes(`<li>${itemEditInline[1]}</li>`));
      assert.equal(JSON.stringify(server.store.snapshot()), itemEditBefore);
    } finally {
      await server.close();
    }
  });

  it("treats an unknown or cross-engagement project on project-scoped creation as correctable", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // An unknown project submitted to an existing URL project's create form
      // is a correctable field problem, not a 404, and nothing is written.
      const before = JSON.stringify(server.store.snapshot());
      const unknownTask = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "Unknown under project URL",
          status: "open",
          priority: "high",
          owner: "keep owner",
          dueDate: "2027-01-02",
          context: "keep context",
          projectId: "project-99",
        },
      });
      assert.equal(unknownTask.status, 400);
      assert.match(String(unknownTask.headers["content-type"]), /^text\/html/);
      assert.match(unknownTask.body, /role="alert"/);
      assert.doesNotMatch(unknownTask.body, /Not found/);
      const taskForm = parseForm(unknownTask.body);
      assert.equal(taskForm.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(taskForm.controls.get("title"), "Unknown under project URL");
      assert.equal(taskForm.controls.get("owner"), "keep owner");
      assert.equal(taskForm.controls.get("context"), "keep context");
      assert.equal(taskForm.controls.get("dueDate"), "2027-01-02");
      assert.match(unknownTask.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // The same holds for an item on a project-scoped create URL.
      const unknownItem = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/items/new`,
        form: {
          engagementId: h.engagement.id,
          kind: "question",
          title: "Unknown item under project URL",
          context: "keep item context",
          state: "open",
          projectId: "project-99",
        },
      });
      assert.equal(unknownItem.status, 400);
      assert.doesNotMatch(unknownItem.body, /Not found/);
      // The item's unknown project is its own visible choice, so the select is
      // associated with its message and the summary carries the same text.
      assert.equal((unknownItem.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.equal(invalidControls(unknownItem.body).length, 1);
      assert.equal(invalidControls(unknownItem.body)[0].field, "projectId");
      assert.match(
        unknownItem.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      const unknownItemInline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(unknownItem.body);
      assert.ok(unknownItemInline !== null);
      assert.ok(unknownItem.body.includes(`<li>${unknownItemInline[1]}</li>`));
      assert.match(unknownItem.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      const itemForm = parseForm(unknownItem.body);
      assert.equal(itemForm.controls.get("title"), "Unknown item under project URL");
      assert.equal(itemForm.controls.get("context"), "keep item context");
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting either rendered form and resubmitting saves it.
      taskForm.controls.set("projectId", h.secondProject.id);
      const corrected = await send(server.origin, {
        method: "POST",
        path: taskForm.action,
        form: Object.fromEntries(taskForm.controls),
      });
      assert.match(redirectTarget(corrected), /^\/tasks\/task-\d+$/);
      const stored = server.store.snapshot().tasks[0];
      assert.equal(stored.title, "Unknown under project URL");
      assert.equal(stored.projectId, h.secondProject.id);
    } finally {
      await server.close();
    }
  });

  it("creates engagement-only work from a project-scoped form with a blank project", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // A project-scoped create URL derives the parent engagement, but a blank
      // submitted project means no project link: the URL project is not applied.
      // Post directly to the project-scoped endpoint, not to the engagement
      // action the rendered form uses.
      const taskFormPage = await send(server.origin, { path: `/projects/${h.project.id}/tasks/new` });
      const taskForm = parseForm(taskFormPage.body);
      taskForm.controls.set("title", "No project task");
      taskForm.controls.set("projectId", "");
      const created = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/tasks/new`,
        form: Object.fromEntries(taskForm.controls),
      });
      assert.match(redirectTarget(created), /^\/tasks\/task-\d+$/);
      const task = server.store.snapshot().tasks[0];
      assert.equal(task.title, "No project task");
      assert.equal(task.engagementId, h.engagement.id);
      assert.equal(task.projectId, undefined);
      assert.equal("projectId" in task, false);

      // The same direct HTTP submission for an item on a project-scoped URL.
      const itemFormPage = await send(server.origin, { path: `/projects/${h.project.id}/items/new` });
      const itemForm = parseForm(itemFormPage.body);
      itemForm.controls.set("title", "No project item");
      itemForm.controls.set("projectId", "");
      const createdItem = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/items/new`,
        form: Object.fromEntries(itemForm.controls),
      });
      assert.match(redirectTarget(createdItem), /^\/items\/item-\d+$/);
      const item = server.store.snapshot().items[0];
      assert.equal(item.title, "No project item");
      assert.equal(item.engagementId, h.engagement.id);
      assert.equal(item.projectId, undefined);
      assert.equal("projectId" in item, false);

      // A selected project on the same URL is still honoured when posted
      // directly to the project-scoped endpoint.
      const inProject = parseForm((await send(server.origin, { path: `/projects/${h.secondProject.id}/tasks/new` })).body);
      inProject.controls.set("title", "In second project");
      const placed = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.secondProject.id}/tasks/new`,
        form: Object.fromEntries(inProject.controls),
      });
      assert.match(redirectTarget(placed), /^\/tasks\/task-\d+$/);
      const placedTask = server.store.snapshot().tasks.find((candidate) => candidate.title === "In second project");
      assert.ok(placedTask !== undefined);
      assert.equal(placedTask.projectId, h.secondProject.id);
    } finally {
      await server.close();
    }
  });

  it("associates an unknown project with the select on a task edit", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Edit target",
        owner: "owner",
        context: "context",
        projectId: h.project.id,
      });
      const before = JSON.stringify(server.store.snapshot());

      // An edit naming a project that does not exist is a correctable 400. The
      // submitted project is the form's visible choice, so the select is marked
      // invalid and points at its own message, which the summary repeats.
      const invalid = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { id: task.id, title: "Edited", projectId: "project-99" },
      });
      assert.equal(invalid.status, 400);
      assert.doesNotMatch(invalid.body, /Not found/);
      assert.match(invalid.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((invalid.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const marked = invalidControls(invalid.body);
      assert.equal(marked.length, 1);
      assert.equal(marked[0].field, "projectId");
      assert.match(
        invalid.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      const inline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(invalid.body);
      assert.ok(inline !== null);
      assert.equal(inline[1], "No project with id &quot;project-99&quot;");
      assert.ok(invalid.body.includes(`<li>${inline[1]}</li>`));
      assert.match(invalid.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      // The submitted values and the omitted stored values are kept for
      // correction, and nothing is written.
      const form = parseForm(invalid.body);
      assert.equal(form.action, `/tasks/${task.id}/edit`);
      assert.equal(form.controls.get("title"), "Edited");
      assert.equal(form.controls.get("owner"), "owner");
      assert.equal(form.controls.get("context"), "context");
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the project and resubmitting the whole rendered form saves
      // it, changing only the submitted fields.
      form.controls.set("projectId", h.secondProject.id);
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(corrected), /^\/tasks\/task-\d+$/);
      const stored = server.store.snapshot().tasks.find((candidate) => candidate.id === task.id);
      assert.ok(stored !== undefined);
      assert.equal(stored.title, "Edited");
      assert.equal(stored.owner, "owner");
      assert.equal(stored.projectId, h.secondProject.id);
    } finally {
      await server.close();
    }
  });

  it("associates an unknown project with the select on a work item edit", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const item = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "question",
        title: "Item edit target",
        context: "context",
        state: "open",
        projectId: h.project.id,
      });
      const before = JSON.stringify(server.store.snapshot());

      const invalid = await send(server.origin, {
        method: "POST",
        path: `/items/${item.id}/edit`,
        form: { id: item.id, title: "Edited item", projectId: "project-99" },
      });
      assert.equal(invalid.status, 400);
      assert.doesNotMatch(invalid.body, /Not found/);
      assert.match(invalid.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((invalid.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const marked = invalidControls(invalid.body);
      assert.equal(marked.length, 1);
      assert.equal(marked[0].field, "projectId");
      assert.match(
        invalid.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      const inline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(invalid.body);
      assert.ok(inline !== null);
      assert.equal(inline[1], "No project with id &quot;project-99&quot;");
      assert.ok(invalid.body.includes(`<li>${inline[1]}</li>`));
      assert.match(invalid.body, /<option value="project-99" selected>project-99 \(not a valid choice\)<\/option>/);
      const form = parseForm(invalid.body);
      assert.equal(form.action, `/items/${item.id}/edit`);
      assert.equal(form.controls.get("title"), "Edited item");
      assert.equal(form.controls.get("context"), "context");
      assert.equal(form.controls.get("state"), "open");
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      form.controls.set("projectId", h.secondProject.id);
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.match(redirectTarget(corrected), /^\/items\/item-\d+$/);
      const stored = server.store.snapshot().items.find((candidate) => candidate.id === item.id);
      assert.ok(stored !== undefined);
      assert.equal(stored.title, "Edited item");
      assert.equal(stored.context, "context");
      assert.equal(stored.projectId, h.secondProject.id);
    } finally {
      await server.close();
    }
  });

  it("associates the project error with the project control even when a visible value collides", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Collision target",
        owner: "owner",
        context: "context",
        projectId: h.project.id,
      });
      const item = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "question",
        title: "Item collision target",
        context: "context",
        state: "open",
        projectId: h.project.id,
      });
      const before = JSON.stringify(server.store.snapshot());

      // The title the submission sends is the same text as the rejected
      // project. The title appears before the project select, so a lookup by
      // equal submitted values would mark the title instead: the association
      // must name the project control itself.
      const collisionEdit = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/edit`,
        form: { id: task.id, title: "project-99", projectId: "project-99" },
      });
      assert.equal(collisionEdit.status, 400);
      assert.match(collisionEdit.body, /role="alert"><p>No project with id &quot;project-99&quot;<\/p>/);
      assert.equal((collisionEdit.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      const collisionMarked = invalidControls(collisionEdit.body);
      assert.equal(collisionMarked.length, 1);
      assert.equal(collisionMarked[0].field, "projectId");
      assert.doesNotMatch(collisionEdit.body, /id="field-title"[^>]*aria-invalid/);
      assert.match(
        collisionEdit.body,
        /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
      );
      assert.match(collisionEdit.body, /<input type="text" id="field-title" name="title" value="project-99" required>/);
      const collisionForm = parseForm(collisionEdit.body);
      assert.equal(collisionForm.controls.get("title"), "project-99");
      assert.equal(collisionForm.controls.get("projectId"), "project-99");
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // The same collision on a create, where the submitted title is kept and
      // the project control carries the association.
      const collisionCreate = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "project-99",
          status: "open",
          priority: "normal",
          owner: "",
          dueDate: "",
          context: "",
          projectId: "project-99",
        },
      });
      assert.equal(collisionCreate.status, 400);
      const createdMarked = invalidControls(collisionCreate.body);
      assert.equal(createdMarked.length, 1);
      assert.equal(createdMarked[0].field, "projectId");
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // An item edit collides with a retained stored title instead of a
      // submitted one: only the project control is associated.
      const retained = await server.store.updateItem(item.id, { title: "project-99" });
      const retainedBefore = JSON.stringify(server.store.snapshot());
      const retainedEdit = await send(server.origin, {
        method: "POST",
        path: `/items/${item.id}/edit`,
        form: { id: item.id, projectId: "project-99" },
      });
      assert.equal(retainedEdit.status, 400);
      const retainedMarked = invalidControls(retainedEdit.body);
      assert.equal(retainedMarked.length, 1);
      assert.equal(retainedMarked[0].field, "projectId");
      assert.equal((retainedEdit.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.doesNotMatch(retainedEdit.body, /id="field-title"[^>]*aria-invalid/);
      const retainedForm = parseForm(retainedEdit.body);
      assert.equal(retainedForm.controls.get("title"), "project-99");
      assert.equal(retainedForm.controls.get("projectId"), "project-99");
      assert.equal(JSON.stringify(server.store.snapshot()), retainedBefore);
      assert.equal(retained.id, item.id);
      assert.equal(retained.title, "project-99");
    } finally {
      await server.close();
    }
  });

  it("associates an escaped unknown project value with the project control", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Escaped target",
        owner: "",
        context: "",
        projectId: h.project.id,
      });
      const before = JSON.stringify(server.store.snapshot());

      // The store writes the missing project with JSON.stringify, so a value
      // holding a quote, a backslash, a newline or a tab appears escaped in the
      // message. Each still matches its own escaped message and is associated
      // with the select, kept selected and escaped in the correction form.
      for (const value of ['project-"99', 'back\\slash', "line\nbreak", "tab\tvalue"]) {
        const reply = await send(server.origin, {
          method: "POST",
          path: `/tasks/${task.id}/edit`,
          form: { id: task.id, projectId: value },
        });
        assert.equal(reply.status, 400, JSON.stringify(value));
        assert.doesNotMatch(reply.body, /Not found/);
        assert.match(reply.body, /role="alert"><p>No project with id /, JSON.stringify(value));
        assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, 1, JSON.stringify(value));
        const marked = invalidControls(reply.body);
        assert.equal(marked.length, 1, JSON.stringify(value));
        assert.equal(marked[0].field, "projectId", JSON.stringify(value));
        assert.match(
          reply.body,
          /<select[^>]*\sid="field-projectId"[^>]*\saria-invalid="true"[^>]*\saria-describedby="field-projectId-error"/,
          JSON.stringify(value),
        );
        const inline = /<p id="field-projectId-error">([^<]*)<\/p>/.exec(reply.body);
        assert.ok(inline !== null, JSON.stringify(value));
        assert.ok(reply.body.includes(`<li>${inline[1]}</li>`), JSON.stringify(value));
        // The rejected value is kept for correction and escaped.
        const form = parseForm(reply.body);
        assert.equal(form.controls.get("projectId"), value, JSON.stringify(value));
        assert.equal(form.controls.get("title"), "Escaped target", JSON.stringify(value));
        assert.equal(JSON.stringify(server.store.snapshot()), before, JSON.stringify(value));
      }
    } finally {
      await server.close();
    }
  });

  it("refuses a conflicting submitted task id on an edit URL", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const first = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "First",
      });
      const second = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Second",
      });
      const before = JSON.stringify(server.store.snapshot());
      const conflict = await send(server.origin, {
        method: "POST",
        path: `/tasks/${first.id}/edit`,
        form: { id: second.id, title: "Hijack" },
      });
      assert.equal(conflict.status, 400);
      assert.match(conflict.body, /does not match this URL/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
      const form = parseForm(conflict.body);
      assert.equal(form.action, `/tasks/${first.id}/edit`);
      assert.equal(form.controls.get("id"), first.id);
    } finally {
      await server.close();
    }
  });

  it("shows a missing-record error for an unknown task id", async () => {
    const server = await running();
    try {
      for (const path of ["/tasks/task-99", "/tasks/task-99/edit"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
    } finally {
      await server.close();
    }
  });
});

describe("work pages: work items", () => {
  it("creates and edits every kind and both states", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const kinds = ["decision", "question", "blocker", "commitment", "waiting", "follow_up"];
      const states = ["open", "closed"];

      const newPage = await send(server.origin, { path: `/engagements/${h.engagement.id}/items/new` });
      assert.equal(newPage.status, 200);
      const newForm = parseForm(newPage.body);
      assert.equal(newForm.action, `/engagements/${h.engagement.id}/items/new`);
      assert.equal(newForm.controls.get("engagementId"), h.engagement.id);
      // Every kind is offered.
      for (const kind of kinds) {
        assert.match(newPage.body, new RegExp(`<option value="${kind}"`));
      }

      for (const kind of kinds) {
        for (const state of states) {
          const created = await send(server.origin, {
            method: "POST",
            path: `/engagements/${h.engagement.id}/items/new`,
            form: {
              engagementId: h.engagement.id,
              kind,
              title: `${kind} ${state}`,
              context: "context",
              state,
              projectId: "",
            },
          });
          assert.match(redirectTarget(created), /^\/items\/item-\d+$/);
          const id = idOf(created);
          const stored = server.store.snapshot().items.find((item) => item.id === id);
          assert.ok(stored !== undefined);
          assert.equal(stored.kind, kind);
          assert.equal(stored.state, state);
          assert.equal(stored.title, `${kind} ${state}`);

          // Edit changes the state to the other one and keeps the kind.
          const otherState = state === "open" ? "closed" : "open";
          const editPage = await send(server.origin, { path: `/items/${id}/edit` });
          assert.equal(editPage.status, 200);
          const form = parseForm(editPage.body);
          assert.equal(form.action, `/items/${id}/edit`);
          assert.equal(form.controls.get("id"), id);
          assert.equal(form.controls.get("kind"), kind);
          assert.equal(form.controls.get("state"), state);
          form.controls.set("state", otherState);
          const saved = await send(server.origin, {
            method: "POST",
            path: form.action,
            form: Object.fromEntries(form.controls),
          });
          assert.equal(redirectTarget(saved), `/items/${id}`);
          const edited = server.store.snapshot().items.find((item) => item.id === id);
          assert.ok(edited !== undefined);
          assert.equal(edited.state, otherState);
          assert.equal(edited.kind, kind);
        }
      }
      assert.equal(server.store.snapshot().items.length, kinds.length * states.length);
    } finally {
      await server.close();
    }
  });

  it("rejects a tampered project and an invalid kind with a correctable error", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());

      const tampered = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/items/new`,
        form: {
          engagementId: h.engagement.id,
          kind: "decision",
          title: "Tampered",
          context: "keep",
          state: "open",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(tampered.status, 400);
      assert.match(tampered.body, /does not belong to engagementId/);
      const form = parseForm(tampered.body);
      assert.equal(form.controls.get("title"), "Tampered");
      assert.equal(form.controls.get("context"), "keep");
      assert.match(tampered.body, new RegExp(`<option value="${h.siblingProject.id}" selected>`));
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      const badKind = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/items/new`,
        form: {
          engagementId: h.engagement.id,
          kind: "note",
          title: "Bad kind",
          context: "keep",
          state: "open",
          projectId: "",
        },
      });
      assert.equal(badKind.status, 400);
      assert.match(badKind.body, /role="alert"/);
      const badForm = parseForm(badKind.body);
      assert.equal(badForm.controls.get("kind"), "note");
      assert.equal(badForm.controls.get("context"), "keep");
      assert.match(badKind.body, /<option value="note" selected>note \(not a valid choice\)<\/option>/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Correcting the rendered form writes successfully and redirects.
      badForm.controls.set("kind", "blocker");
      const corrected = await send(server.origin, {
        method: "POST",
        path: badForm.action,
        form: Object.fromEntries(badForm.controls),
      });
      assert.match(redirectTarget(corrected), /^\/items\/item-\d+$/);
      assert.equal(server.store.snapshot().items[0].kind, "blocker");
    } finally {
      await server.close();
    }
  });

  it("reassigns and clears an item's project within its engagement", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const item = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        kind: "decision",
        title: "In a project",
      });
      const assigned = await send(server.origin, {
        method: "POST",
        path: `/items/${item.id}/edit`,
        form: { id: item.id, projectId: h.secondProject.id },
      });
      assert.equal(redirectTarget(assigned), `/items/${item.id}`);
      assert.equal(server.store.snapshot().items[0].projectId, h.secondProject.id);
      assert.equal(server.store.snapshot().items[0].title, "In a project");

      // A cross-engagement project is refused and nothing changes.
      const before = JSON.stringify(server.store.snapshot());
      const cross = await send(server.origin, {
        method: "POST",
        path: `/items/${item.id}/edit`,
        form: { id: item.id, projectId: h.siblingProject.id },
      });
      assert.equal(cross.status, 400);
      assert.match(cross.body, /does not belong to engagementId/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      const cleared = await send(server.origin, {
        method: "POST",
        path: `/items/${item.id}/edit`,
        form: { id: item.id, projectId: "" },
      });
      assert.equal(redirectTarget(cleared), `/items/${item.id}`);
      assert.equal(server.store.snapshot().items[0].projectId, undefined);
      assert.equal(server.store.snapshot().items[0].title, "In a project");
    } finally {
      await server.close();
    }
  });
});

describe("work pages: project-scoped creation", () => {
  it("offers only the engagement's projects and preselects the path's project", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      const taskForm = await send(server.origin, { path: `/projects/${h.project.id}/tasks/new` });
      assert.equal(taskForm.status, 200);
      const taskParsed = parseForm(taskForm.body);
      // The form posts to the engagement's endpoint, with the engagement hidden.
      assert.equal(taskParsed.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(taskParsed.controls.get("engagementId"), h.engagement.id);
      // The path's project is preselected, siblings' projects are not offered.
      assert.equal(taskParsed.controls.get("projectId"), h.project.id);
      assert.ok(!taskForm.body.includes(`<option value="${h.siblingProject.id}">`));

      // Fill the title (the only required control without a usable default).
      taskParsed.controls.set("title", "Project task");
      const created = await send(server.origin, {
        method: "POST",
        path: taskParsed.action,
        form: Object.fromEntries(taskParsed.controls),
      });
      assert.match(redirectTarget(created), /^\/tasks\/task-\d+$/);
      const task = server.store.snapshot().tasks[0];
      assert.equal(task.projectId, h.project.id);
      assert.equal(task.engagementId, h.engagement.id);

      const itemForm = await send(server.origin, { path: `/projects/${h.project.id}/items/new` });
      assert.equal(itemForm.status, 200);
      const itemParsed = parseForm(itemForm.body);
      assert.equal(itemParsed.action, `/engagements/${h.engagement.id}/items/new`);
      assert.equal(itemParsed.controls.get("projectId"), h.project.id);
    } finally {
      await server.close();
    }
  });

  it("derives the engagement from the URL project and refuses cross-engagement tampering", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // A POST to project A's URL cannot create work under engagement B by
      // submitting B's ids: the URL project's engagement is the parent and B is
      // refused before any write.
      const beforeParent = JSON.stringify(server.store.snapshot());
      const crossParent = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/tasks/new`,
        form: {
          engagementId: h.sibling.id,
          title: "Wrong parent",
          status: "open",
          priority: "normal",
          owner: "",
          dueDate: "",
          context: "",
          projectId: h.project.id,
        },
      });
      assert.equal(crossParent.status, 400);
      assert.match(crossParent.body, /not the parent engagement of this form/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeParent);
      const crossParentCorrection = parseForm(crossParent.body);
      assert.equal(crossParentCorrection.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(crossParentCorrection.controls.get("engagementId"), h.engagement.id);
      assert.equal(crossParentCorrection.controls.get("title"), "Wrong parent");
      assert.equal(crossParentCorrection.controls.get("projectId"), h.project.id);
      // The corrected resubmission saves under the URL project's engagement.
      const created = idOf(await send(server.origin, {
        method: "POST",
        path: crossParentCorrection.action,
        form: Object.fromEntries(crossParentCorrection.controls),
      }));
      const createdTask = server.store.snapshot().tasks.find((task) => task.id === created);
      assert.ok(createdTask !== undefined);
      assert.equal(createdTask.engagementId, h.engagement.id);
      assert.equal(createdTask.clientId, h.client.id);
      assert.equal(createdTask.projectId, h.project.id);

      // A selected project from a different engagement is refused.
      const beforeCross = JSON.stringify(server.store.snapshot());
      const crossProject = await send(server.origin, {
        method: "POST",
        path: `/projects/${h.project.id}/tasks/new`,
        form: {
          engagementId: h.engagement.id,
          title: "Cross project",
          status: "open",
          priority: "normal",
          owner: "keep",
          dueDate: "",
          context: "",
          projectId: h.siblingProject.id,
        },
      });
      assert.equal(crossProject.status, 400);
      assert.match(crossProject.body, /does not belong to engagementId/);
      assert.equal(JSON.stringify(server.store.snapshot()), beforeCross);
      // The correction form posts to the URL project's engagement and keeps the
      // submitted values, showing the rejected project selected. The message
      // is about the hidden parent chain rather than the project select, so it
      // stays in the summary and no visible control is marked invalid.
      const correction = parseForm(crossProject.body);
      assert.equal(correction.action, `/engagements/${h.engagement.id}/tasks/new`);
      assert.equal(correction.controls.get("engagementId"), h.engagement.id);
      assert.equal(correction.controls.get("title"), "Cross project");
      assert.equal(correction.controls.get("owner"), "keep");
      assert.match(crossProject.body, new RegExp(`<option value="${h.siblingProject.id}" selected>`));
      assert.equal((crossProject.body.match(/aria-invalid="true"/g) ?? []).length, 0);
      assert.doesNotMatch(crossProject.body, /id="field-projectId"[^>]*aria-invalid/);
      assert.match(crossProject.body, /role="alert"><p>projectId [^<]*does not belong to engagementId[^<]*<\/p>/);

      // A nonexistent URL project is not found, and nothing is written.
      const beforeMissing = JSON.stringify(server.store.snapshot());
      for (const family of ["tasks", "items"]) {
        const missing = await send(server.origin, {
          method: "POST",
          path: `/projects/project-99/${family}/new`,
          form: {
            engagementId: h.engagement.id,
            title: "Ghost",
            projectId: h.project.id,
          },
        });
        assert.equal(missing.status, 404, family);
        assert.match(missing.body, /Not found/);
      }
      assert.equal(JSON.stringify(server.store.snapshot()), beforeMissing);
    } finally {
      await server.close();
    }
  });
});

describe("work pages: lists and rollups", () => {
  it("lists a project's tasks and items, including closed ones, with detail and edit links", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const openTask = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Open project task",
        status: "open",
      });
      const doneTask = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Done project task",
        status: "done",
      });
      const closedItem = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        kind: "decision",
        title: "Closed project item",
        state: "closed",
      });
      // Engagement-only and sibling work must not appear on this project.
      await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Engagement task",
      });
      await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        projectId: h.siblingProject.id,
        title: "Sibling task",
      });

      const page = await send(server.origin, { path: `/projects/${h.project.id}` });
      assert.equal(page.status, 200);
      // Every task links to its detail and edit workflow, closed/completed included.
      for (const task of [openTask, doneTask]) {
        assert.match(page.body, new RegExp(`href="/tasks/${task.id}"`));
        assert.match(page.body, new RegExp(`href="/tasks/${task.id}/edit"`));
      }
      assert.ok(containsEscaped(page.body, "Open project task"));
      assert.ok(containsEscaped(page.body, "Done project task"));
      // The closed item is listed too.
      assert.match(page.body, new RegExp(`href="/items/${closedItem.id}"`));
      assert.match(page.body, new RegExp(`href="/items/${closedItem.id}/edit"`));
      assert.ok(containsEscaped(page.body, "Closed project item"));
      // Work outside the project is not listed.
      assert.ok(!page.body.includes("Engagement task"));
      assert.ok(!page.body.includes("Sibling task"));
      // Counts: two tasks, one open and one done; no open items.
      assert.match(page.body, /<li>open: 1<\/li>/);
      assert.match(page.body, /<li>in_progress: 0<\/li>/);
      assert.match(page.body, /<li>done: 1<\/li>/);
      assert.match(page.body, /Open work items: 0/);
      // Creation links are offered.
      assert.match(page.body, new RegExp(`href="/projects/${h.project.id}/tasks/new"`));
      assert.match(page.body, new RegExp(`href="/projects/${h.project.id}/items/new"`));
    } finally {
      await server.close();
    }
  });

  it("separates engagement-only work from per-project work and counts accurately", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);

      // Engagement-only work, in the engagement's own scope.
      const onlyTask = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Engagement-only task",
        status: "in_progress",
      });
      const onlyItem = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "waiting",
        title: "Engagement-only item",
        state: "open",
      });
      // Work in the engagement's first project.
      const projectTaskOpen = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "First project open task",
        status: "open",
      });
      const projectItemClosed = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        kind: "question",
        title: "First project closed item",
        state: "closed",
      });
      const projectItemOpen = await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        kind: "decision",
        title: "First project open item",
        state: "open",
      });
      // A sibling engagement's work, for isolation.
      await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        projectId: h.siblingProject.id,
        title: "Sibling task",
        status: "done",
      });
      await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        projectId: h.siblingProject.id,
        kind: "blocker",
        title: "Sibling item",
        state: "open",
      });
      // Meetings are separate records and are never counted as work.
      await server.store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Kickoff",
        date: "2026-01-15",
      });

      const page = await send(server.origin, { path: `/engagements/${h.engagement.id}` });
      assert.equal(page.status, 200);

      // Engagement-only work section lists only the project-less records.
      assert.ok(containsEscaped(page.body, "Engagement-only task"));
      assert.match(page.body, new RegExp(`href="/tasks/${onlyTask.id}"`));
      assert.match(page.body, new RegExp(`href="/items/${onlyItem.id}"`));
      // It links to creation forms for the engagement scope.
      assert.match(page.body, new RegExp(`href="/engagements/${h.engagement.id}/tasks/new"`));
      assert.match(page.body, new RegExp(`href="/engagements/${h.engagement.id}/items/new"`));

      // Per-project work section lists the project's records with links.
      assert.ok(containsEscaped(page.body, "First project open task"));
      assert.ok(containsEscaped(page.body, "First project closed item"));
      assert.match(page.body, new RegExp(`href="/tasks/${projectTaskOpen.id}/edit"`));
      assert.match(page.body, new RegExp(`href="/items/${projectItemClosed.id}"`));
      assert.match(page.body, new RegExp(`href="/items/${projectItemOpen.id}/edit"`));

      // The counts for the first project's explicit scope: one open task, no
      // in-progress or done task, and one open item (the closed one is listed
      // but is not counted as open). The second project's counts are zero.
      assert.match(page.body, /<li>open: 1<\/li>/);
      assert.match(page.body, /<li>in_progress: 0<\/li>/);
      assert.match(page.body, /<li>done: 0<\/li>/);
      assert.match(page.body, /Open work items: 1/);

      // The sibling's work never appears on this engagement's page.
      assert.ok(!page.body.includes("Sibling task"));
      assert.ok(!page.body.includes("Sibling item"));
      // The meeting is listed in the separate meeting history, never as a
      // task or an item.
      assert.match(page.body, new RegExp(`href="/meetings/meeting-\\d+"`));
      assert.ok(!page.body.includes(`href="/tasks/meeting`));
      assert.ok(!page.body.includes(`href="/items/meeting`));

      // An engagement rollup counts engagement-only work exactly once, and the
      // page renders the engagement-wide counts using the explicit engagement
      // scope: two tasks (one engagement-only in progress, one project open) and
      // two open items (engagement-only open plus project open).
      const only = server.store.listTasks({ clientId: h.client.id, engagementId: h.engagement.id });
      assert.equal(only.length, 2);
      // Each task belongs to exactly one scope: the engagement-only group or a
      // project. The two groups add up to the engagement's task count.
      const projectTasks = server.store.listTasks({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
      });
      assert.equal(projectTasks.length, 1);
      assert.equal(only.filter((task) => task.projectId === undefined).length + projectTasks.length, only.length);

      // The engagement page's own counts include both engagement-only work and
      // project work, each counted once. The first "open: 1" etc. above belongs
      // to the first project; the engagement section carries the totals.
      const engagementRows = taskStatusCounts(server.store, h.client.id, { engagementId: h.engagement.id });
      assert.deepEqual(engagementRows, [
        { label: "open", count: 1 },
        { label: "in_progress", count: 1 },
        { label: "done", count: 0 },
      ]);
      assert.equal(openItemCount(server.store, h.client.id, { engagementId: h.engagement.id }), 2);
      // The rendered engagement-wide tally is visible before the project sections.
      assert.match(page.body, /<h3>Counts<\/h3><ul><li>open: 1<\/li><li>in_progress: 1<\/li><li>done: 0<\/li><\/ul>/);
      assert.match(page.body, /Open work items: 2/);
    } finally {
      await server.close();
    }
  });

  it("keeps sibling engagements isolated for both lists and counts", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Eng A task",
        status: "done",
      });
      await server.store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "commitment",
        title: "Eng A item",
        state: "open",
      });
      // An engagement with no projects of its own, holding only project-less work.
      const bare = await server.store.createEngagement({ clientId: h.client.id, name: "Bare" });
      await server.store.createTask({
        clientId: h.client.id,
        engagementId: bare.id,
        title: "Bare task",
        status: "in_progress",
      });
      await server.store.createItem({
        clientId: h.client.id,
        engagementId: bare.id,
        kind: "question",
        title: "Bare item",
        state: "open",
      });

      const siblingPage = await send(server.origin, { path: `/engagements/${h.sibling.id}` });
      assert.equal(siblingPage.status, 200);
      // The sibling's own scope is empty: none of the other engagement's work
      // is folded into it, and its counts are all zero, including the
      // engagement-wide tally before its (absent) project sections.
      assert.ok(!siblingPage.body.includes("Eng A task"));
      assert.ok(!siblingPage.body.includes("Eng A item"));
      assert.match(siblingPage.body, /<li>open: 0<\/li>/);
      assert.match(siblingPage.body, /<li>done: 0<\/li>/);
      assert.match(siblingPage.body, /<h3>Counts<\/h3><ul><li>open: 0<\/li><li>in_progress: 0<\/li><li>done: 0<\/li><\/ul>/);
      assert.match(siblingPage.body, /Open work items: 0/);

      // An engagement without projects shows its engagement-only rollup: the
      // project-less task and open item count once, in the engagement scope.
      const barePage = await send(server.origin, { path: `/engagements/${bare.id}` });
      assert.equal(barePage.status, 200);
      assert.ok(containsEscaped(barePage.body, "Bare task"));
      assert.ok(containsEscaped(barePage.body, "Bare item"));
      assert.match(barePage.body, /<h3>Counts<\/h3><ul><li>open: 0<\/li><li>in_progress: 1<\/li><li>done: 0<\/li><\/ul>/);
      assert.match(barePage.body, /Open work items: 1/);
      // The sibling's work stays off the bare engagement's page too.
      assert.ok(!barePage.body.includes("Eng A task"));
      assert.ok(!barePage.body.includes("Eng A item"));

      // The sibling project page is empty too.
      const siblingProjectPage = await send(server.origin, { path: `/projects/${h.siblingProject.id}` });
      assert.equal(siblingProjectPage.status, 200);
      assert.equal(siblingProjectPage.body.includes("Eng A task"), false);
      assert.match(siblingProjectPage.body, /<li>open: 0<\/li>/);
    } finally {
      await server.close();
    }
  });
});

describe("work pages: guards", () => {
  it("refuses unregistered paths, wrong methods and GET mutation", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());
      for (const path of ["/tasks/new", "/tasks/", "/tasks/task-1/other", "/items/new", "/tasks"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
      // The detail pages are GET-only.
      for (const path of ["/tasks/task-1", "/items/item-1"]) {
        const reply = await send(server.origin, { method: "POST", path, form: { title: "x" } });
        assert.equal(reply.status, 405, path);
      }
      // A cross-origin POST is refused before any handler runs.
      const foreign = await send(server.origin, {
        method: "POST",
        path: `/engagements/${h.engagement.id}/tasks/new`,
        origin: "http://evil.example",
        form: { title: "x" },
      });
      assert.equal(foreign.status, 403);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A GET to a creation page never mutates.
      const formPage = await send(server.origin, { path: `/engagements/${h.engagement.id}/tasks/new` });
      assert.equal(formPage.status, 200);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("reports a missing parent engagement or project as not found", async () => {
    const server = await running();
    try {
      for (const path of [
        "/engagements/engagement-99/tasks/new",
        "/engagements/engagement-99/items/new",
        "/projects/project-99/tasks/new",
        "/projects/project-99/items/new",
      ]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
    } finally {
      await server.close();
    }
  });
});

describe("work pages: presentation helpers", () => {
  it("escapes badge text, groups sections and offers only a real empty-state step", () => {
    // A badge is escaped text, so a stored value can never bring markup in.
    assert.equal(badge("<b>x</b>"), '<span class="badge">&lt;b&gt;x&lt;/b&gt;</span>');

    // Groups become lower-level headings with their own bodies.
    assert.equal(
      groupedSections([
        { title: "Open <a>", body: "<p>one</p>" },
        { title: "Done", body: "<p>two</p>" },
      ]),
      "<h3>Open &lt;a&gt;</h3><p>one</p>\n<h3>Done</h3><p>two</p>",
    );

    // An empty state names the gap and, when the scope offers one, the next
    // step; without one it never guesses a destination.
    assert.equal(emptyState("Nothing <yet>.", { href: "/new?a=1&b=2", label: "Add" }), '<p>Nothing &lt;yet&gt;.</p>\n<p><a href="/new?a=1&amp;b=2">Add</a></p>');
    assert.equal(emptyState("Nothing <yet>."), "<p>Nothing &lt;yet&gt;.</p>");

    // A primary action is one escaped link in a labelled paragraph.
    assert.equal(
      primaryAction("/new", "New <x>"),
      '<p class="primary-action"><a href="/new">New &lt;x&gt;</a></p>',
    );

    // Client guidance always asks the user to choose an engagement, and links
    // only engagements it was given.
    assert.match(clientGuidance([]), /choose an engagement/i);
    assert.ok(!clientGuidance([]).includes("<a "));
    assert.match(clientGuidance([{ href: "/engagements/e1", label: "E1" }]), /<a href="\/engagements\/e1">E1<\/a>/);
  });

  it("shows badge-marked fields as escaped text badges and hides identity fields", () => {
    const fields = [
      { name: "title", label: "Title" },
      { name: "status", label: "Status", presentation: { badge: true } },
      { name: "clientId", label: "Client", presentation: { identity: true } },
    ] as const;
    assert.deepEqual(displayValues(fields, { title: "T", status: "<open>", clientId: "c1" }), [
      { label: "Title", value: "T", badge: false },
      { label: "Status", value: "<open>", badge: true },
    ]);
    assert.equal(
      displayList(displayValues(fields, { title: "T", status: "<open>" })),
      '<dl><dt>Title</dt><dd>T</dd><dt>Status</dt><dd><span class="badge">&lt;open&gt;</span></dd></dl>',
    );
  });
});

describe("work pages: route matching and rollup helpers", () => {
  it("matches the fixed work paths and refuses anything else", () => {
    assert.deepEqual(matchWorkPath("/tasks/task-1"), { pattern: "/tasks/:id", id: "task-1" });
    assert.deepEqual(matchWorkPath("/tasks/task-1/edit"), { pattern: "/tasks/:id/edit", id: "task-1" });
    assert.deepEqual(matchWorkPath("/items/item-1"), { pattern: "/items/:id", id: "item-1" });
    assert.deepEqual(matchWorkPath("/items/item-1/edit"), { pattern: "/items/:id/edit", id: "item-1" });
    assert.deepEqual(matchWorkPath("/engagements/engagement-1/tasks/new"), {
      pattern: "/engagements/:id/tasks/new",
      id: "engagement-1",
    });
    assert.deepEqual(matchWorkPath("/engagements/engagement-1/items/new"), {
      pattern: "/engagements/:id/items/new",
      id: "engagement-1",
    });
    assert.deepEqual(matchWorkPath("/projects/project-1/tasks/new"), {
      pattern: "/projects/:id/tasks/new",
      id: "project-1",
    });
    assert.deepEqual(matchWorkPath("/projects/project-1/items/new"), {
      pattern: "/projects/:id/items/new",
      id: "project-1",
    });
    for (const path of ["/", "/tasks", "/tasks/", "/tasks/new", "/tasks/task-1/other", "/items/new", "/meetings/meeting-1"]) {
      assert.equal(matchWorkPath(path), null, path);
    }
  });

  it("rolls up status and open-item counts for explicit engagement and project scopes", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      await store.createTask({ ...base, title: "a", status: "open" });
      await store.createTask({ ...base, title: "b", status: "open", projectId: h.project.id });
      await store.createTask({ ...base, title: "c", status: "done", projectId: h.project.id });
      await store.createTask({ ...base, title: "d", status: "in_progress", projectId: h.secondProject.id });
      await store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        projectId: h.siblingProject.id,
        title: "sibling",
        status: "done",
      });
      await store.createItem({ ...base, kind: "decision", title: "i1", state: "open" });
      await store.createItem({ ...base, kind: "question", title: "i2", state: "closed", projectId: h.project.id });
      await store.createItem({ ...base, kind: "blocker", title: "i3", state: "open", projectId: h.project.id });

      // The engagement scope counts every task once, including project tasks.
      const engagement = taskStatusCounts(store, h.client.id, { engagementId: h.engagement.id });
      assert.deepEqual(engagement, [
        { label: "open", count: 2 },
        { label: "in_progress", count: 1 },
        { label: "done", count: 1 },
      ]);
      // Each project's tally is its own explicit selection, isolated from siblings.
      assert.deepEqual(taskStatusCounts(store, h.client.id, { engagementId: h.engagement.id, projectId: h.project.id }), [
        { label: "open", count: 1 },
        { label: "in_progress", count: 0 },
        { label: "done", count: 1 },
      ]);
      assert.deepEqual(taskStatusCounts(store, h.client.id, { engagementId: h.engagement.id, projectId: h.secondProject.id }), [
        { label: "open", count: 0 },
        { label: "in_progress", count: 1 },
        { label: "done", count: 0 },
      ]);
      // The sibling engagement's task never leaks into this engagement's tally.
      const sibling = taskStatusCounts(store, h.client.id, { engagementId: h.sibling.id });
      assert.deepEqual(sibling, [
        { label: "open", count: 0 },
        { label: "in_progress", count: 0 },
        { label: "done", count: 1 },
      ]);

      assert.equal(openItemCount(store, h.client.id, { engagementId: h.engagement.id }), 2);
      assert.equal(openItemCount(store, h.client.id, { engagementId: h.engagement.id, projectId: h.project.id }), 1);
      assert.equal(openItemCount(store, h.client.id, { engagementId: h.sibling.id }), 0);

      // Engagement-only work excludes project-linked records; project work
      // includes exactly the project's records.
      const only = engagementOnlyWork(store, h.client.id, h.engagement.id);
      assert.deepEqual(only.tasks.map((task) => task.title), ["a"]);
      assert.deepEqual(only.items.map((item) => item.title), ["i1"]);
      const project = projectWork(store, h.client.id, h.engagement.id, h.project.id);
      assert.deepEqual(project.tasks.map((task) => task.title).sort(), ["b", "c"]);
      assert.deepEqual(project.items.map((item) => item.title).sort(), ["i2", "i3"]);
    } finally {
      await store.close();
    }
  });

  it("registers every fixed work route through the shared table", async () => {
    const store = await openStore(tempDir());
    try {
      const routes = workRoutes(store);
      const patterns = [
        ["/tasks/:id", "GET"],
        ["/tasks/:id/edit", "GET"],
        ["/tasks/:id/edit", "POST"],
        ["/items/:id", "GET"],
        ["/items/:id/edit", "GET"],
        ["/items/:id/edit", "POST"],
        ["/engagements/:id/tasks/new", "GET"],
        ["/engagements/:id/tasks/new", "POST"],
        ["/engagements/:id/items/new", "GET"],
        ["/engagements/:id/items/new", "POST"],
        ["/projects/:id/tasks/new", "GET"],
        ["/projects/:id/items/new", "GET"],
      ] as const;
      for (const [pattern, method] of patterns) {
        const route = routeForWorkPattern(routes, pattern, method);
        assert.ok(route !== undefined, `${pattern} ${method}`);
        assert.equal(route.method, method);
      }
      // The detail pages do not accept POST.
      assert.equal(routeForWorkPattern(routes, "/tasks/:id", "POST"), undefined);
      assert.equal(routeForWorkPattern(routes, "/items/:id", "POST"), undefined);
      // The collection creation routes accept POST; the project-scoped paths
      // share the same creation slot (the app's forms post to the engagement).
    } finally {
      await store.close();
    }
  });
});

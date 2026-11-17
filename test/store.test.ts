import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { openStore, type Store } from "../src/store.ts";
import {
  BusyStoreError,
  MissingRecordError,
  PersistenceError,
  ValidationError,
  type Client,
} from "../src/model.ts";

let directories: string[] = [];
let stores: Store[] = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-"));
  directories.push(directory);
  return directory;
};

const open = async (directory: string): Promise<Store> => {
  const store = await openStore(directory);
  stores.push(store);
  return store;
};

beforeEach(() => {
  directories = [];
  stores = [];
});

afterEach(async () => {
  for (const store of stores) {
    try {
      await store.close();
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("client create and edit", () => {
  it("creates a client with stable id and all fields", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const client = await store.createClient({
      name: "Acme",
      background: "A background",
      contacts: [{ name: "Ada", role: "CTO", email: "ada@example.test", phone: "" }],
      stakeholders: [{ name: "Grace", role: "Sponsor", notes: "" }],
      requirements: ["Needs speed"],
      objectives: ["Ship Q1"],
    });
    assert.ok(client.id.length > 0);
    assert.equal(client.name, "Acme");
    assert.deepEqual(client.requirements, ["Needs speed"]);
    const snapshot = store.snapshot();
    assert.equal(snapshot.clients.length, 1);
    assert.equal(snapshot.clients[0]!.id, client.id);
  });

  it("edits a client without changing its id", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const client = await store.createClient({ name: "Acme" });
    const edited = await store.updateClient(client.id, { name: "Acme Prime", background: "New" });
    assert.equal(edited.id, client.id);
    assert.equal(edited.name, "Acme Prime");
    assert.equal(edited.background, "New");
  });

  it("rejects a blank client name", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    await assert.rejects(
      () => store.createClient({ name: "   " }),
      (error: unknown) => error instanceof ValidationError && error.kind === "validation",
    );
    await assert.rejects(
      () => store.createClient({ name: "Ok" }).then((c) => store.updateClient(c.id, { name: "" })),
      (error: unknown) => error instanceof ValidationError,
    );
  });

  it("returns detached snapshots", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    await store.createClient({ name: "Acme", requirements: ["One"] });
    const snapshot = store.snapshot();
    assert.throws(() => {
      (snapshot.clients[0] as { name: string }).name = "Mutated";
    });
    assert.equal(store.snapshot().clients[0]!.name, "Acme");
  });
});

describe("engagement and project hierarchy", () => {
  it("supports two engagements with separate projects", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const client = await store.createClient({ name: "Acme" });
    const first = await store.createEngagement({
      clientId: client.id,
      name: "Engagement A",
      status: "active",
    });
    const second = await store.createEngagement({ clientId: client.id, name: "Engagement B" });
    const projectA = await store.createProject({ engagementId: first.id, name: "Project A1" });
    const projectB = await store.createProject({ engagementId: second.id, name: "Project B1" });
    assert.notEqual(first.id, second.id);
    assert.notEqual(projectA.id, projectB.id);
    assert.equal(projectA.engagementId, first.id);
    assert.equal(projectB.engagementId, second.id);

    const snapshot = store.snapshot();
    assert.equal(snapshot.engagements.length, 2);
    assert.equal(snapshot.projects.length, 2);
  });

  it("accepts every status value and rejects unknown ones", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const client = await store.createClient({ name: "Acme" });
    for (const status of ["planned", "active", "on_hold", "completed"] as const) {
      const engagement = await store.createEngagement({ clientId: client.id, name: status, status });
      assert.equal(engagement.status, status);
      const project = await store.createProject({ engagementId: engagement.id, name: status, status });
      assert.equal(project.status, status);
    }
    await assert.rejects(
      () =>
        store.createEngagement({
          clientId: client.id,
          name: "Bad",
          status: "retired" as "active",
        }),
      (error: unknown) => error instanceof ValidationError,
    );
  });

  it("rejects missing and invalid parents without committing", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const client = await store.createClient({ name: "Acme" });
    await assert.rejects(
      () => store.createEngagement({ clientId: "missing", name: "X" }),
      (error: unknown) => error instanceof MissingRecordError && error.kind === "missing",
    );
    await assert.rejects(
      () => store.createEngagement({ clientId: "", name: "X" }),
      (error: unknown) => error instanceof ValidationError,
    );
    await assert.rejects(
      () => store.createProject({ engagementId: "missing", name: "X" }),
      (error: unknown) => error instanceof MissingRecordError,
    );
    assert.equal(store.snapshot().engagements.length, 0);
    assert.equal(store.snapshot().projects.length, 0);
    assert.ok(client.id);
  });

  it("keeps parent links immutable across edits", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const firstClient = await store.createClient({ name: "First" });
    const secondClient = await store.createClient({ name: "Second" });
    const engagement = await store.createEngagement({ clientId: firstClient.id, name: "Eng" });
    const project = await store.createProject({ engagementId: engagement.id, name: "Proj" });

    const editedEngagement = await store.updateEngagement(engagement.id, {
      name: "Eng Renamed",
      status: "completed",
    });
    assert.equal(editedEngagement.clientId, firstClient.id);
    assert.equal(editedEngagement.name, "Eng Renamed");
    assert.equal(editedEngagement.status, "completed");
    assert.notEqual(firstClient.id, secondClient.id);

    const editedProject = await store.updateProject(project.id, {
      name: "Proj Renamed",
      status: "on_hold",
    });
    assert.equal(editedProject.engagementId, engagement.id);
    assert.equal(editedProject.name, "Proj Renamed");
    assert.equal(editedProject.status, "on_hold");
  });

  it("reports missing records on update", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    await assert.rejects(
      () => store.updateClient("nope", { name: "X" }),
      (error: unknown) => error instanceof MissingRecordError,
    );
    await assert.rejects(
      () => store.updateEngagement("nope", { name: "X" }),
      (error: unknown) => error instanceof MissingRecordError,
    );
    await assert.rejects(
      () => store.updateProject("nope", { name: "X" }),
      (error: unknown) => error instanceof MissingRecordError,
    );
  });
});

describe("persistence and restart", () => {
  it("persists all fields across close and reopen", async () => {
    const directory = await makeDirectory();
    const store = await openStore(directory);
    const client = await store.createClient({
      name: "Acme",
      background: "Background text",
      contacts: [{ name: "Ada", role: "CTO", email: "ada@example.test", phone: "555" }],
      stakeholders: [{ name: "Grace", role: "Sponsor", notes: "note" }],
      requirements: ["Req one", "Req two"],
      objectives: ["Obj one"],
    });
    const engagement = await store.createEngagement({
      clientId: client.id,
      name: "Eng",
      objectives: ["Eng obj"],
      status: "active",
    });
    const project = await store.createProject({
      engagementId: engagement.id,
      name: "Proj",
      objectives: ["Proj obj"],
      status: "completed",
    });
    await store.close();

    const reopened = await openStore(directory);
    stores.push(reopened);
    const snapshot = reopened.snapshot();
    assert.deepEqual(
      snapshot.clients.find((c: Client) => c.id === client.id),
      {
        id: client.id,
        name: "Acme",
        background: "Background text",
        contacts: [{ name: "Ada", role: "CTO", email: "ada@example.test", phone: "555" }],
        stakeholders: [{ name: "Grace", role: "Sponsor", notes: "note" }],
        requirements: ["Req one", "Req two"],
        objectives: ["Obj one"],
      },
    );
    assert.deepEqual(
      snapshot.engagements.find((e) => e.id === engagement.id),
      { id: engagement.id, clientId: client.id, name: "Eng", objectives: ["Eng obj"], status: "active" },
    );
    assert.deepEqual(
      snapshot.projects.find((p) => p.id === project.id),
      {
        id: project.id,
        engagementId: engagement.id,
        name: "Proj",
        objectives: ["Proj obj"],
        status: "completed",
      },
    );
  });

  it("writes versioned JSON with a version field", async () => {
    const directory = await makeDirectory();
    const store = await openStore(directory);
    await store.createClient({ name: "Acme" });
    await store.close();
    const raw = await readFile(join(directory, "workspace.json"), "utf8");
    const parsed = JSON.parse(raw) as { version: number };
    assert.equal(parsed.version, 1);
  });

  it("close permits reopening", async () => {
    const directory = await makeDirectory();
    const store = await openStore(directory);
    await store.close();
    const reopened = await openStore(directory);
    stores.push(reopened);
    assert.equal(reopened.snapshot().clients.length, 0);
  });

  it("refuses corrupt snapshots without overwriting them", async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, "workspace.json"), "{ not json", "utf8");
    await assert.rejects(
      () => openStore(directory),
      (error: unknown) => error instanceof PersistenceError && error.kind === "persistence",
    );
    assert.equal(await readFile(join(directory, "workspace.json"), "utf8"), "{ not json");
    assert.deepEqual(await readdir(directory), ["workspace.json"]);
  });

  it("refuses unsupported versions without overwriting them", async () => {
    const directory = await makeDirectory();
    const contents = JSON.stringify({
      version: 99,
      clients: [],
      engagements: [],
      projects: [],
    });
    await writeFile(join(directory, "workspace.json"), contents, "utf8");
    await assert.rejects(
      () => openStore(directory),
      (error: unknown) => error instanceof PersistenceError,
    );
    assert.equal(await readFile(join(directory, "workspace.json"), "utf8"), contents);
  });

  it("refuses structurally invalid snapshots without overwriting them", async () => {
    const directory = await makeDirectory();
    const contents = JSON.stringify({
      version: 1,
      clients: [{ id: "c1", name: "", background: "", contacts: [], stakeholders: [], requirements: [], objectives: [] }],
      engagements: [],
      projects: [],
    });
    await writeFile(join(directory, "workspace.json"), contents, "utf8");
    await assert.rejects(
      () => openStore(directory),
      (error: unknown) => error instanceof PersistenceError,
    );
    assert.equal(await readFile(join(directory, "workspace.json"), "utf8"), contents);
  });
});

describe("concurrency and failure handling", () => {
  it("refuses a second writer to the same directory", async () => {
    const directory = await makeDirectory();
    const first = await openStore(directory);
    stores.push(first);
    await assert.rejects(
      () => openStore(directory),
      (error: unknown) => error instanceof BusyStoreError && error.kind === "busy",
    );
    await first.close();
    const third = await openStore(directory);
    stores.push(third);
  });

  it("releases ownership after failed initialization", async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, "workspace.json"), "corrupt", "utf8");
    await assert.rejects(() => openStore(directory));
    // A fresh directory with the same corruption must still report corruption,
    // not busy: ownership was released by the failed initialization.
    await assert.rejects(
      () => openStore(directory),
      (error: unknown) => error instanceof PersistenceError,
    );
  });

  it("serializes concurrent mutations", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.createClient({ name: `Client ${index}` })),
    );
    const ids = new Set(results.map((c) => c.id));
    assert.equal(ids.size, 20);
    assert.equal(store.snapshot().clients.length, 20);

    await store.close();
    const reopened = await openStore(directory);
    stores.push(reopened);
    assert.equal(reopened.snapshot().clients.length, 20);
  });

  it("retains the previous committed state when a save fails", async () => {
    const directory = await makeDirectory();
    const store = await open(directory);
    await store.createClient({ name: "Committed" });
    // Replace the state file with a directory so the atomic rename fails after
    // the temporary file was written.
    const statePath = join(directory, "workspace.json");
    const saved = await readFile(statePath, "utf8");
    await rm(statePath);
    await mkdir(statePath);
    try {
      await assert.rejects(
        () => store.createClient({ name: "Doomed" }),
        (error: unknown) => error instanceof PersistenceError,
      );
    } finally {
      await rm(statePath, { recursive: true, force: true });
      await writeFile(statePath, saved, "utf8");
    }
    assert.deepEqual(store.snapshot().clients.map((c) => c.name), ["Committed"]);

    await store.close();
    const reopened = await openStore(directory);
    stores.push(reopened);
    assert.deepEqual(reopened.snapshot().clients.map((c) => c.name), ["Committed"]);
  });
});

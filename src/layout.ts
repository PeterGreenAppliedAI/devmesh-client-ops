/**
 * The shared application shell: navigation, a skip link, a location header
 * and one main landmark around every application HTML page.
 *
 * The shell is built from explicit layout context, not from mutable global
 * state. The context is derived once per response from the accepted route
 * (its path) and the full authoritative snapshot the store returned for that
 * response, so it is a read-only view of records that already exist. A global
 * page carries no ancestry; a record page carries only the ancestry the
 * snapshot actually knows (client > engagement > project), never a guessed
 * parent.
 *
 * Navigation lists the active (not effectively archived) clients, marks the
 * client of the current page, and always offers Home, Clients and New client.
 * The laptop sidebar is persistent; the phone top menu is a native `details`
 * control, so it opens and closes from the keyboard with no script (the
 * document's content security policy forbids scripts).
 */
import { isEffectivelyArchived } from "./archive.ts";
import { escapeHtml } from "./html.ts";
import type { Snapshot } from "./store.ts";

/** One client in the navigation: its id and its escaped-by-render name. */
export interface LayoutClient {
  readonly id: string;
  readonly name: string;
}

/** One link of the ancestry chain: a stored record and its detail route. */
export interface LayoutAncestryLink {
  readonly id: string;
  readonly name: string;
  readonly href: string;
}

/**
 * The explicit layout context for one response: the active clients for
 * navigation, the client of the current page (if any) and the known ancestry
 * from the client down to the nearest stored record.
 */
export interface LayoutContext {
  readonly clients: readonly LayoutClient[];
  readonly activeClientId?: string;
  readonly ancestry: readonly LayoutAncestryLink[];
}

/** A record that can name an ancestor chain. */
interface LinkedRecord {
  readonly id: string;
  readonly clientId?: string;
  readonly engagementId?: string;
  readonly projectId?: string;
}

/** Decode a path id; a malformed escape names no record. */
function decodeId(rawId: string): string | null {
  try {
    return decodeURIComponent(rawId);
  } catch {
    return null;
  }
}

/** The active clients, in stored order, for the navigation. */
function navigationClients(snapshot: Snapshot): readonly LayoutClient[] {
  return snapshot.clients
    .filter((client) => !isEffectivelyArchived(snapshot, client))
    .map((client) => ({ id: client.id, name: client.name }));
}

function clientLink(snapshot: Snapshot, clientId: string): LayoutAncestryLink | null {
  const client = snapshot.clients.find((candidate) => candidate.id === clientId);
  return client === undefined
    ? null
    : { id: client.id, name: client.name, href: `/clients/${encodeURIComponent(client.id)}` };
}

function engagementLink(
  snapshot: Snapshot,
  engagementId: string,
): LayoutAncestryLink | null {
  const engagement = snapshot.engagements.find((candidate) => candidate.id === engagementId);
  return engagement === undefined
    ? null
    : {
        id: engagement.id,
        name: engagement.name,
        href: `/engagements/${encodeURIComponent(engagement.id)}`,
      };
}

function projectLink(snapshot: Snapshot, projectId: string): LayoutAncestryLink | null {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  return project === undefined
    ? null
    : { id: project.id, name: project.name, href: `/projects/${encodeURIComponent(project.id)}` };
}

/** The client, engagement and project a record names, in hierarchy order. */
function chainFor(snapshot: Snapshot, record: LinkedRecord): readonly LayoutAncestryLink[] {
  const links: LayoutAncestryLink[] = [];
  if (record.clientId !== undefined) {
    const client = clientLink(snapshot, record.clientId);
    if (client !== null) links.push(client);
  }
  if (record.engagementId !== undefined) {
    const engagement = engagementLink(snapshot, record.engagementId);
    if (engagement !== null) links.push(engagement);
  }
  if (record.projectId !== undefined) {
    const project = projectLink(snapshot, record.projectId);
    if (project !== null) links.push(project);
  }
  return links;
}

/** Find a hierarchy record by id for the ancestry of its own detail page. */
function hierarchyChain(
  snapshot: Snapshot,
  kind: "clients" | "engagements" | "projects",
  id: string,
): readonly LayoutAncestryLink[] {
  if (kind === "clients") {
    const link = clientLink(snapshot, id);
    return link === null ? [] : [link];
  }
  if (kind === "engagements") {
    const engagement = snapshot.engagements.find((candidate) => candidate.id === id);
    if (engagement === undefined) return [];
    const client = clientLink(snapshot, engagement.clientId);
    const self = engagementLink(snapshot, engagement.id);
    return [...(client === null ? [] : [client]), ...(self === null ? [] : [self])];
  }
  const project = snapshot.projects.find((candidate) => candidate.id === id);
  if (project === undefined) return [];
  const self = projectLink(snapshot, project.id);
  const engagement = snapshot.engagements.find(
    (candidate) => candidate.id === project.engagementId,
  );
  if (engagement === undefined) return self === null ? [] : [self];
  const client = clientLink(snapshot, engagement.clientId);
  const parentEngagement = engagementLink(snapshot, engagement.id);
  return [
    ...(client === null ? [] : [client]),
    ...(parentEngagement === null ? [] : [parentEngagement]),
    ...(self === null ? [] : [self]),
  ];
}

/** Find a work or meeting record by id and return its known ancestry. */
function recordChain(
  snapshot: Snapshot,
  kind: "tasks" | "items" | "meetings",
  id: string,
): readonly LayoutAncestryLink[] {
  const records: readonly LinkedRecord[] =
    kind === "tasks" ? snapshot.tasks : kind === "items" ? snapshot.items : snapshot.meetings;
  const record = records.find((candidate) => candidate.id === id);
  return record === undefined ? [] : chainFor(snapshot, record);
}

/**
 * The ancestry for a path: a global page (root, health, the collection lists
 * and the New forms) has none, a record page shows the chain the snapshot
 * knows, and a new-child form shows its parent chain from the path alone.
 */
function ancestryFor(
  segments: readonly string[],
  snapshot: Snapshot,
): readonly LayoutAncestryLink[] {
  const [family, rawId] = segments;
  if (family === undefined) return [];
  if (family === "health") return [];
  if (family === "clients") {
    if (rawId === undefined || rawId === "new") return [];
    const id = decodeId(rawId);
    return id === null ? [] : hierarchyChain(snapshot, "clients", id);
  }
  if (family === "engagements") {
    if (rawId === undefined || rawId === "new") return [];
    const id = decodeId(rawId);
    return id === null ? [] : hierarchyChain(snapshot, "engagements", id);
  }
  if (family === "projects") {
    if (rawId === undefined || rawId === "new") return [];
    const id = decodeId(rawId);
    return id === null ? [] : hierarchyChain(snapshot, "projects", id);
  }
  if (family === "tasks" || family === "items" || family === "meetings") {
    if (rawId === undefined) return [];
    const id = decodeId(rawId);
    return id === null ? [] : recordChain(snapshot, family, id);
  }
  return [];
}

/**
 * Build the layout context for an accepted route path from the full snapshot.
 * The navigation always lists exactly the active clients; a record page marks
 * its client as current. Nothing is invented: a path that names no stored
 * record contributes no ancestry.
 */
export function layoutContextFor(path: string, snapshot: Snapshot): LayoutContext {
  const pathname = path.split("?")[0];
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const ancestry = ancestryFor(segments, snapshot);
  const activeClientId = ancestry.length > 0 ? ancestry[0].id : undefined;
  return {
    clients: navigationClients(snapshot),
    ...(activeClientId === undefined ? {} : { activeClientId }),
    ancestry,
  };
}

/** A hidden control that carries a server-chosen parent id. */
interface HiddenParentField {
  readonly name: string;
  readonly hidden?: boolean;
  readonly value?: string;
}

/**
 * The layout context for a correctable form error. The URL path is used first,
 * so a refused edit keeps the authoritative context of its record. A
 * collection-create refusal posts to `/engagements/new` or `/projects/new`,
 * which name no parent in the path; its validated parent id travels as a
 * hidden control, so that validated field supplies the ancestry instead of a
 * guessed one.
 */
export function layoutContextForFormError(
  fields: readonly HiddenParentField[],
  path: string,
  snapshot: Snapshot,
): LayoutContext {
  const base = layoutContextFor(path, snapshot);
  if (base.ancestry.length > 0) return base;
  const hiddenValue = (name: string): string | undefined => {
    const field = fields.find((candidate) => candidate.hidden === true && candidate.name === name);
    return field?.value;
  };
  const clientId = hiddenValue("clientId");
  if (clientId !== undefined) {
    const client = clientLink(snapshot, clientId);
    if (client !== null) {
      return { clients: base.clients, activeClientId: client.id, ancestry: [client] };
    }
  }
  const engagementId = hiddenValue("engagementId");
  if (engagementId !== undefined) {
    const engagement = snapshot.engagements.find((candidate) => candidate.id === engagementId);
    if (engagement !== undefined) {
      const client = clientLink(snapshot, engagement.clientId);
      const self = engagementLink(snapshot, engagement.id);
      if (client !== null && self !== null) {
        return { clients: base.clients, activeClientId: client.id, ancestry: [client, self] };
      }
    }
  }
  return base;
}

/**
 * The document stylesheet. Hand-written, inline (the content security policy
 * allows inline styles but no external assets or scripts), with system fonts.
 * Colours are chosen for a contrast of at least 4.5:1 on their backgrounds and
 * every interactive control shows a visible focus outline. At 360px the page
 * is a single column with the phone menu and full-width controls; at 1280px
 * the persistent sidebar sits beside the content. Actions never sit under a
 * fixed overlay, so they stay visible and reachable at both widths.
 */
const LAYOUT_STYLE = [
  ":root{color-scheme:light}",
  "*{box-sizing:border-box}",
  "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;line-height:1.5;color:#1b1b1b;background:#ffffff}",
  "a{color:#0b4f9c}",
  "a:visited{color:#0b3a73}",
  "a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #0b4f9c;outline-offset:2px}",
  ".skip-link:link,.skip-link:visited{background:#0b4f9c;color:#ffffff}",
  ".skip-link{position:absolute;left:.5rem;top:-3.5rem;padding:.5rem 1rem;z-index:10;border-radius:4px}",
  ".skip-link:focus{top:.5rem}",
  ".layout{display:grid;grid-template-areas:'masthead' 'content';grid-template-columns:minmax(0,1fr);gap:1rem;padding:0 1rem 2rem}",
  ".masthead{grid-area:masthead}",
  ".sidebar{display:none}",
  ".content{grid-area:content;min-width:0}",
  ".phone-menu{margin:.75rem 0}",
  ".phone-menu>summary{font-weight:700;cursor:pointer;padding:.6rem .75rem;border:1px solid #0b4f9c;border-radius:4px;background:#e6eef8;color:#0b3a73;min-height:44px}",
  ".primary-nav ul{list-style:none;margin:.5rem 0 0;padding:0}",
  ".primary-nav li{margin:.2rem 0}",
  ".primary-nav a{display:block;padding:.4rem .5rem;border-radius:4px;min-height:44px}",
  ".primary-nav a[aria-current=page]{background:#e6eef8;font-weight:700;color:#0b3a73}",
  ".primary-nav a[aria-current=page]:link,.primary-nav a[aria-current=page]:visited{color:#0b3a73}",
  ".location{padding:.75rem 0;border-bottom:1px solid #b8b8b8}",
  ".breadcrumb ol{list-style:none;display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0}",
  ".breadcrumb li+li::before{content:'\\203A';margin-right:.5rem;color:#4a4a4a}",
  "main{padding:1rem 0;max-width:64rem}",
  "form{max-width:32rem;min-width:0}",
  "label{display:block;margin-top:.75rem;font-weight:600}",
  "input,textarea,select{width:100%;max-width:100%;padding:.45rem;font:inherit;border:1px solid #6b6b6b;border-radius:4px;background:#ffffff;color:#1b1b1b}",
  "textarea{min-height:5rem}",
  "button{margin-top:1rem;padding:.6rem 1rem;font:inherit;min-height:44px;cursor:pointer;border:1px solid #0b3a73;border-radius:4px;background:#0b4f9c;color:#ffffff}",
  "[role=alert]{color:#a40000;font-weight:600}",
  "@media (min-width:901px){.layout{grid-template-areas:'masthead masthead' 'sidebar content';grid-template-columns:16rem minmax(0,1fr);gap:0 2rem;padding:1rem 2rem}.masthead .phone-menu{display:none}.sidebar{display:block;grid-area:sidebar;padding-top:1rem}.sidebar .primary-nav ul{margin-top:0}}",
  "@media (max-width:400px){.layout{padding:0 .75rem 2rem}}",
].join("");

/** The navigation links: Home, Clients, New client and every active client. */
function navigationItems(context: LayoutContext): string {
  const fixed = [
    { id: "", name: "Home", href: "/" },
    { id: "", name: "Clients", href: "/clients" },
    { id: "", name: "New client", href: "/clients/new" },
  ];
  const clients = context.clients.map((client) => ({
    id: client.id,
    name: client.name,
    href: `/clients/${encodeURIComponent(client.id)}`,
  }));
  return [...fixed, ...clients]
    .map((item) => {
      const current =
        item.id !== "" && item.id === context.activeClientId ? ' aria-current="page"' : "";
      return `<li><a href="${escapeHtml(item.href)}"${current}>${escapeHtml(item.name)}</a></li>`;
    })
    .join("");
}

/** The primary navigation list, shared by the sidebar and the phone menu. */
function primaryNav(context: LayoutContext): string {
  return `<nav class="primary-nav" aria-label="Primary"><ul>${navigationItems(context)}</ul></nav>`;
}

/** The location header: the known ancestry chain, or nothing for a global page. */
function locationHeader(context: LayoutContext): string {
  if (context.ancestry.length === 0) return "";
  const items = context.ancestry
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.name)}</a></li>`,
    )
    .join("");
  return `<header class="location"><nav class="breadcrumb" aria-label="Location"><ol>${items}</ol></nav></header>`;
}

/**
 * Render one complete application document around its main content: the skip
 * link, the phone top menu, the persistent laptop sidebar, the location header
 * and one `<main id="main">` landmark holding the page title and body. Every
 * value is escaped; the body is already-escaped application markup.
 */
export function renderLayoutDocument(
  context: LayoutContext,
  title: string,
  body: string,
): string {
  const nav = primaryNav(context);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${LAYOUT_STYLE}</style>`,
    "</head>",
    "<body>",
    '<a class="skip-link" href="#main">Skip to main content</a>',
    '<div class="layout">',
    '<div class="masthead">',
    `<details class="phone-menu"><summary>Menu</summary>${nav}</details>`,
    "</div>",
    `<aside class="sidebar">${nav}</aside>`,
    '<div class="content">',
    locationHeader(context),
    `<main id="main"><h1>${escapeHtml(title)}</h1>`,
    body,
    "</main>",
    "</div>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

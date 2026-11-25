/**
 * The operator's transcript library, exercised over ordinary loopback HTTP.
 *
 * The test starts the real application (`startApplication`) on port 0 over a
 * temporary workspace and follows only the pages and links the application
 * renders: the import actions in the engagement, project and meeting histories,
 * the multipart forms they lead to, the successful 200 result page's meeting
 * link, the history entries selected by the date and title they show, each in
 * its rendered order and followed to the meeting whose own title and date the
 * card names, the meeting page's source rows and each source's three views
 * (original, extracted text, passages). It then saves the meeting and source
 * paths, the passage fragments and the text it saw, closes the application,
 * starts it again over the same directory on a new port, resolves the saved
 * paths against the new origin, rediscovers the same pages and compares the
 * original bytes, the full text, the quotes, the locations and the fragment
 * targets across the restart.
 *
 * Every fixture is synthetic: pasted text, UTF-8 text and Markdown bytes, a
 * multi-block DOCX and a text PDF with a blank page, all built in test source.
 * The installed parsers (mammoth and pdfjs-dist) run inside the application, so
 * an image-only PDF, an invalid UTF-8 file and a corrupt DOCX/PDF are refused
 * by the application's own adapters with 400 and recovery guidance.
 *
 * Only the temporary workspace receives data, and it is removed afterwards.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { startApplication, type Application } from "../src/index.ts";
import {
  get,
  meetingSourceRows,
  parseForm,
  renderedPassages,
  resolvePassageLink,
  sectionOf,
  sourceRows,
  splitLink,
  submit,
  unescapeHtml,
} from "./fixtures/transcript-http.ts";
import { docxBytes } from "./fixtures/transcript-docx.ts";
import { corruptBytes, pdfBytes } from "./fixtures/transcript-pdf.ts";

// ---------------------------------------------------------------------------
// The temporary workspace
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-library-"));
  roots.push(dir);
  return dir;
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Fixture text
// ---------------------------------------------------------------------------

/** The pasted original: two paragraphs, one quoted, with multibyte text. */
const PASTED = 'Alice: "The budget is fixed," she said.\n\nBob: We can work within it — café.';
/** A .txt original: the pasted words with different whitespace, its own file. */
const TEXT_FILE = ' Alice:  "The budget is fixed," she said.\r\n\r\nBob: We can work within it — café.\n';
/**
 * A .md original whose canonical text is exactly the pasted text except for its
 * case, so only the case differs and a case-insensitive match would wrongly
 * reuse the paste meeting.
 */
const MARKDOWN = 'Alice: "The budget is fixed," she said.\n\nbob: we can work within it — café.';
/** An original imported in a second engagement, with the same canonical text. */
const OTHER_ENGAGEMENT_TEXT = 'Alice: "The budget is fixed," she said.\n\nBob: We can work within it — café.';
/** The DOCX paragraphs: several blocks, one quoted. */
const DOCX_PARAGRAPHS = ['Alice: "The budget is fixed," she said.', "Bob: We can work within it.", "Carol: Agreed."];
/** The text PDF's pages: text on page one, a blank page, text on page three. */
const PDF_PAGES = [["Alice: The budget is fixed."], [], ["Bob: We can work within it."]] as const;
/** The notes a manual meeting is created with, which an attachment keeps. */
const MANUAL_NOTES = "Kept notes for the manual meeting.";
/** Invalid UTF-8 bytes: a stray continuation byte after a valid prefix. */
const INVALID_UTF8 = Uint8Array.from([0x41, 0x42, 0xc3, 0x28, 0x43]);

// ---------------------------------------------------------------------------
// Rendered form and history reading
// ---------------------------------------------------------------------------

/**
 * The `date — title` label a meeting page shows for itself: its rendered
 * heading (the stored title) and its Date profile value, joined as a history
 * card writes them. A destination page that serves another meeting's profile
 * fails this, both for its title and its date.
 */
function pageMeetingLabel(document: string): string {
  const heading = /<h1>([\s\S]*?)<\/h1>/.exec(document);
  assert.notEqual(heading, null, "a meeting page renders its heading");
  const title = unescapeHtml(heading![1]);
  const date = profileValue(document, "Date");
  assert.notEqual(date, null, "a meeting page shows its own date");
  assert.notEqual(date, "", "a meeting page shows a stored date");
  return `${date} — ${title}`;
}

/**
 * The project a meeting page shows in its `Identity and parents` section: the
 * link's href, or "" for the `(none)` placeholder. Read from the page itself.
 */
function profileProject(meetingPage: string): string {
  const section = sectionOf(meetingPage, "Identity and parents");
  assert.notEqual(section, "", "a meeting page renders its Identity and parents section");
  const match = /<p>Project: (.*?)<\/p>/.exec(section);
  assert.notEqual(match, null, "the Identity and parents section shows the Project field");
  const value = match![1];
  const link = /^<a href="([^"]+)">/.exec(value);
  if (link !== null) return unescapeHtml(link[1]);
  // The no-project value is the renderer's escaped `(none)` placeholder.
  assert.equal(value, "<em>(none)</em>", "the Project field shows a project link or the no-project placeholder");
  return "";
}

/**
 * Follow a meeting link and verify the destination page is that meeting's own:
 * it renders the `date — title` label the card or result names. Returns the body.
 */
async function followMeeting(base: string, href: string, label: string): Promise<string> {
  const page = await get(base, href);
  assert.equal(page.status, 200, `${href} is readable`);
  assert.equal(pageMeetingLabel(page.body), label, `the destination ${href} shows the meeting labelled ${label}`);
  return page.body;
}

/**
 * Follow one rendered form over HTTP and require a successful 200 HTML page,
 * the transient result page an import commits to. A refusal or an error page
 * is not a success and fails here.
 */
async function importThrough(
  base: string,
  pagePath: string,
  actionPath: string,
  values: Readonly<Record<string, string | { readonly filename: string; readonly body: string | Uint8Array }>>,
): Promise<string> {
  const page = await get(base, pagePath);
  assert.equal(page.status, 200, `${pagePath} is rendered`);
  const form = parseForm(page.body);
  assert.equal(form.action, actionPath, `the form at ${pagePath} posts to ${actionPath}`);
  assert.equal(form.method, "post", "the import form posts");
  assert.equal(form.enctype, "multipart/form-data", "the import form is a multipart form");
  const reply = await submit(base, pagePath, form, values);
  assert.equal(reply.status, 200, `the import submitted from ${pagePath} succeeds: ${reply.body.slice(0, 400)}`);
  assert.match(String(reply.headers["content-type"]), /^text\/html; charset=utf-8/, "a successful import answers HTML");
  return reply.body;
}

/** The meeting link a result page renders, followed to its path. */
function resultMeetingLink(resultPage: string): string {
  const section = sectionOf(resultPage, "Result");
  const link = /<p>Meeting: <a href="([^"]+)">/.exec(section);
  assert.ok(link !== null, "the result page links the meeting it committed to");
  const href = unescapeHtml(link![1]);
  assert.match(href, /^\/meetings\//, "the result page links a meeting path");
  return href;
}

/** One history card as rendered: the label a meeting shows and the link it carries. */
interface HistoryCard {
  /** The visible `date — title` label the renderer writes. */
  readonly label: string;
  /** The destination href of the card's own first link. */
  readonly href: string;
}

/**
 * The cards a history section renders, in rendered order. Each card is the
 * whole `<li class="card">`; its label and its own destination link are read
 * from the card itself, so a card that swapped its label or destination is
 * visible instead of being hidden behind the set of hrefs.
 */
function historyCards(historySection: string): HistoryCard[] {
  return [...historySection.matchAll(/<li class="card">([\s\S]*?)<\/li>/g)].map((match) => {
    const anchor = /<a href="([^"]+)">([^<]*)<\/a>/.exec(match[1]);
    assert.notEqual(anchor, null, "a history card links its meeting");
    return { label: unescapeHtml(anchor![2]), href: unescapeHtml(anchor![1]) };
  });
}

/**
 * The label a meeting's own history card shows: its stored date and title, as
 * the renderer writes them (`date — title`). The meeting path is asserted to be
 * a meeting path so the label is never built for another record.
 */
function labelOf(meetingPath: string, expectedLabel: string): string {
  assert.match(meetingPath, /^\/meetings\//, "a meeting path names a meeting");
  return expectedLabel;
}

/**
 * Find the one history card whose visible label is `label`, verify it is the
 * only card of that label, and verify its own link is `meetingPath`. A card
 * with the right href under another label, or a card whose label points
 * elsewhere, fails. Returns the card's own href, read from the card, not the
 * expected path, so the caller follows what the page rendered, and "" when
 * the history renders no card of that label (the caller asserts its absence).
 */
function historyCardFor(historySection: string, label: string, meetingPath: string): string {
  const cards = historyCards(historySection).filter((card) => card.label === label);
  assert.ok(cards.length <= 1, `the history renders at most one card labelled ${label}`);
  if (cards.length === 0) return "";
  assert.equal(cards[0].href, meetingPath, `the card labelled ${label} links ${meetingPath}`);
  return cards[0].href;
}

/**
 * The `label -> href` entries a history section renders, in rendered order,
 * each pair read from the same card. Comparing these pairs keeps a card's
 * visible label tied to the link it carries, so a swapped href fails.
 */
function historyEntries(historySection: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const card of historyCards(historySection)) {
    assert.ok(!entries.has(card.label), `the history renders ${card.label} once`);
    entries.set(card.label, card.href);
  }
  return entries;
}

/**
 * Require a history section to render exactly the expected label/href pairs,
 * in the expected rendered order: no extra card, no missing card, no reordered
 * cards and no card whose label points elsewhere. The history is ordered by
 * date, so this also keeps that order.
 */
function expectHistory(historySection: string, expected: readonly (readonly [string, string])[], why: string): void {
  const entries = historyEntries(historySection);
  assert.equal(entries.size, expected.length, `${why}: the history renders ${expected.length} cards`);
  for (const [label, href] of expected) {
    assert.equal(entries.get(label), href, `${why}: the card labelled ${label} links ${href}`);
  }
  assert.deepEqual(
    historyCards(historySection).map((card) => [card.label, card.href]),
    expected.map(([label, href]) => [label, href]),
    `${why}: the history renders its cards in their expected order`,
  );
}

/** The single import link a history section offers, or "" when it offers none. */
function historyImportLink(historySection: string): string {
  const links = [...historySection.matchAll(/<a href="([^"]+)">Import transcript<\/a>/g)].map((match) =>
    unescapeHtml(match[1]),
  );
  assert.ok(links.length <= 1, "a history offers at most one import action");
  return links[0] ?? "";
}

/**
 * The import action a page renders: the one link to a transcript import path.
 * A page with no such link is an error for the caller, so a missing action is
 * never papered over by a hand-built path.
 */
function importActionOf(page: string, pagePath: string): string {
  const links = new Set(
    [...page.matchAll(/<a href="([^"]+)">Import transcript<\/a>/g)].map((match) => unescapeHtml(match[1])),
  );
  assert.equal(links.size, 1, `${pagePath} offers exactly one transcript import action`);
  return [...links][0];
}

/**
 * The profile value a meeting page shows under one label (Title, Date, Notes).
 * The label is escaped exactly as the renderer writes it.
 */
function profileValue(meetingPage: string, label: string): string | null {
  const section = sectionOf(meetingPage, "Meeting");
  const match = new RegExp(`<dt>${escapeHtml(label)}</dt><dd>([\\s\\S]*?)</dd>`).exec(section);
  return match === null ? null : unescapeHtml(match[1]);
}

/** The explanation a result page shows, or null when it shows none. */
function resultExplanation(resultPage: string): string | null {
  const match = /<p role="status">([\s\S]*?)<\/p>/.exec(sectionOf(resultPage, "Result"));
  return match === null ? null : unescapeHtml(match[1]);
}

/** The preserved-metadata conflicts a result page reports, as `field: supplied -> preserved`. */
function resultConflicts(resultPage: string): string[] {
  const section = sectionOf(resultPage, "Result");
  return [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => unescapeHtml(match[1]));
}

/** The project a result page names, as a path, or "". */
function resultPageProject(resultPage: string): string {
  const match = /<p>Project: <a href="([^"]+)">/.exec(sectionOf(resultPage, "Result"));
  return match === null ? "" : unescapeHtml(match[1]);
}

/** One source's three views read over HTTP, plus what they show. */
interface SourceView {
  readonly originalBytes: Buffer;
  readonly text: string;
  readonly passages: ReturnType<typeof renderedPassages>;
  /** The resolved destinations (path and raw fragment) of each passage link. */
  readonly passageLinks: readonly { readonly path: string; readonly fragment: string }[];
  /** Each passage row's link, resolved on its own passages page: its raw
   * fragment, exactly as the href carried it. */
  readonly passageFragments: readonly string[];
}

/**
 * Read one source row's three views over HTTP and require each to be a 200.
 * `expectedPassages` is the number of passage rows the fixture must yield; a
 * readable page rendering no (or a different number of) passage rows fails,
 * so an empty baseline can never compare equal after a restart.
 */
async function readSource(
  base: string,
  meetingPath: string,
  row: { readonly filename: string; readonly original: string; readonly text: string; readonly passages: string },
  expectedPassages: number,
): Promise<SourceView> {
  // Each row is resolved from its meeting page, so its links name the
  // application's own origin as a browser would follow them; the rows passed
  // here are those resolved rows.
  assert.ok(row.passages.startsWith("/meetings/"), `${row.filename}'s passages link is a root-relative meeting path`);
  const original = await get(base, row.original);
  assert.equal(original.status, 200, `${row.filename} original is served`);
  const text = await get(base, row.text);
  assert.equal(text.status, 200, `${row.filename} text is served`);
  assert.match(String(text.headers["content-type"]), /^text\/plain/, "the extracted text is plain text");
  const passages = await get(base, row.passages);
  assert.equal(passages.status, 200, `${row.filename} passages are served`);
  assert.match(String(passages.headers["content-type"]), /^text\/html; charset=utf-8/, "the passages are a page");
  const rendered = renderedPassages(passages.body);
  assert.equal(rendered.length, expectedPassages, `${row.filename} renders its ${expectedPassages} passage rows`);
  // Every passage row's fragment link is resolved against its own passages
  // page (a same-page fragment included) and must reach a row with that anchor
  // and that quote, so a changed anchor or a misdirected fragment fails.
  const passageLinks: { readonly path: string; readonly fragment: string }[] = [];
  const passageFragments: string[] = [];
  for (const passage of rendered) {
    // The row's links are resolved on the passages page that rendered them,
    // and each resolved destination is saved as its root-relative path.
    const passagePage = splitLink(base, row.passages, passage.link);
    passageFragments.push(passagePage.fragment);
    const resolved = await resolvePassageLink(base, row.passages, passage, passage.text);
    assert.deepEqual(
      [resolved.path, resolved.fragment],
      [passagePage.path, passage.anchor],
      `${row.filename} passage link ${passage.link} names its own row on its passages page`,
    );
    passageLinks.push(resolved);
  }
  return { originalBytes: original.bytes, text: text.body, passages: rendered, passageLinks, passageFragments };
}

/**
 * The source rows a meeting page lists, read from its own markup with every
 * link resolved against the meeting page that rendered it, so a relative or
 * absolute source link is followed where the browser would follow it and a
 * link naming another origin is refused.
 */
async function meetingSources(base: string, meetingPath: string) {
  const page = await get(base, meetingPath);
  assert.equal(page.status, 200, `${meetingPath} is readable`);
  return meetingSourceRows(base, meetingPath, page.body);
}

/** A source row read back as a row argument (for re-reads of saved links). */
function savedRow(source: {
  readonly filename: string;
  readonly format: string;
  readonly original: string;
  readonly text: string;
  readonly passages: string;
}): ReturnType<typeof sourceRows>[number] {
  return {
    filename: source.filename,
    format: source.format,
    original: source.original,
    text: source.text,
    passages: source.passages,
  };
}

// ---------------------------------------------------------------------------
// The library walk
// ---------------------------------------------------------------------------

describe("transcript library over loopback HTTP", () => {
  it("imports through the histories, reads every source, archives a project and survives a restart", async () => {
    const dir = tempDir();
    let app: Application | undefined;
    try {
      app = await startApplication({ dataDirectory: dir, port: 0 });
      const base = app.url;

      // -- Clients, engagements and projects through their rendered forms. ---
      const newClient = await get(base, "/clients/new");
      assert.equal(newClient.status, 200);
      const clientId = await createRecord(base, "/clients/new", parseForm(newClient.body), {
        name: "Synthetic Client",
        background: "",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      });
      const anotherClientPage = await get(base, "/clients/new");
      assert.equal(anotherClientPage.status, 200);
      const anotherClientId = await createRecord(base, "/clients/new", parseForm(anotherClientPage.body), {
        name: "Other Client",
        background: "",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      });

      const alphaEngagementId = await createChild(
        base,
        `/clients/${encodeURIComponent(clientId)}/engagements/new`,
        { name: "Alpha engagement", objectives: "Test", status: "active" },
      );
      const betaEngagementId = await createChild(
        base,
        `/clients/${encodeURIComponent(clientId)}/engagements/new`,
        { name: "Beta engagement", objectives: "Test", status: "active" },
      );
      const foreignEngagementId = await createChild(
        base,
        `/clients/${encodeURIComponent(anotherClientId)}/engagements/new`,
        { name: "Foreign engagement", objectives: "Test", status: "active" },
      );
      // An archiveable project of the alpha engagement; the DOCX and PDF
      // imports create their meetings in it. A sibling project holds one more
      // meeting, so the project history's selection is observable.
      const projectId = await createChild(
        base,
        `/engagements/${encodeURIComponent(alphaEngagementId)}/projects/new`,
        { name: "Alpha project", objectives: "Imported meetings", status: "active" },
      );
      const projectHref = `/projects/${encodeURIComponent(projectId)}`;
      const siblingProjectId = await createChild(
        base,
        `/engagements/${encodeURIComponent(alphaEngagementId)}/projects/new`,
        { name: "Sibling project", objectives: "Another project", status: "active" },
      );

      // Meetings created through the engagement meeting forms: a manual
      // meeting whose notes an attachment keeps, and a project-assigned
      // sibling meeting that only the sibling project may list.
      const manualMeetingId = await createChild(
        base,
        `/engagements/${encodeURIComponent(alphaEngagementId)}/meetings/new`,
        { title: "Manual kickoff", date: "2026-01-05", notes: MANUAL_NOTES, projectId: "" },
      );
      const manualMeetingPath = `/meetings/${encodeURIComponent(manualMeetingId)}`;
      const siblingMeetingId = await createChild(
        base,
        `/engagements/${encodeURIComponent(alphaEngagementId)}/meetings/new`,
        { title: "Sibling meeting", date: "2026-01-06", notes: "", projectId: siblingProjectId },
      );
      const siblingMeetingPath = `/meetings/${encodeURIComponent(siblingMeetingId)}`;
      // A beta-engagement meeting, so the client history must select across
      // engagements by its own client and a client selector cannot merely
      // return the alpha engagement.
      const betaManualId = await createChild(
        base,
        `/engagements/${encodeURIComponent(betaEngagementId)}/meetings/new`,
        { title: "Beta manual", date: "2026-01-04", notes: "", projectId: "" },
      );
      const betaManualPath = `/meetings/${encodeURIComponent(betaManualId)}`;
      // The `date — title` label each meeting's history card shows, so a card
      // is selected by its visible text, not by its href.
      const manualLabel = labelOf(manualMeetingPath, "2026-01-05 — Manual kickoff");
      const siblingLabel = labelOf(siblingMeetingPath, "2026-01-06 — Sibling meeting");
      const betaManualLabel = labelOf(betaManualPath, "2026-01-04 — Beta manual");

      // -- Import 1: paste, through the alpha engagement's history action. ---
      const alphaHref = `/engagements/${encodeURIComponent(alphaEngagementId)}`;
      const alphaPage = await get(base, alphaHref);
      assert.equal(alphaPage.status, 200);
      const alphaHistory = sectionOf(alphaPage.body, "Meeting history");
      const pasteAction = historyImportLink(alphaHistory);
      assert.match(pasteAction, /^\/engagements\/[^/]+\/transcripts\/import$/, "the history links the engagement import");

      const pasteResult = await importThrough(base, pasteAction, pasteAction, {
        title: "Paste meeting",
        date: "2026-01-10",
        notes: "Imported notes",
        paste: PASTED,
        file: { filename: "", body: "" },
      });
      const pasteMeeting = resultMeetingLink(pasteResult);
      const pasteLabel = labelOf(pasteMeeting, "2026-01-10 — Paste meeting");

      // -- Import 2: a whitespace-equivalent distinct original to the same
      // meeting, with conflicting metadata the explanation must report. -----
      const distinctResult = await importThrough(base, pasteAction, pasteAction, {
        title: "A different title",
        date: "2026-02-02",
        notes: "A different note",
        projectId: siblingProjectId,
        paste: "",
        file: { filename: "notes.txt", body: encoder.encode(TEXT_FILE) },
      });
      assert.equal(resultMeetingLink(distinctResult), pasteMeeting, "a whitespace-equivalent original reuses the meeting");
      const explanation = resultExplanation(distinctResult) ?? "";
      assert.match(explanation, /distinct original was retained/i, "the result explains the distinct original");
      assert.match(explanation, /canonical meeting is reused/i);
      // Every conflicting value (title, date, notes and the different project
      // selection) is reported and never written; the meeting keeps the first
      // metadata the paste import gave it.
      assert.deepEqual(
        resultConflicts(distinctResult).sort(),
        [
          "date: submitted 2026-02-02, kept 2026-01-10",
          "notes: submitted A different note, kept Imported notes",
          `projectId: submitted ${siblingProjectId}, kept `,
          "title: submitted A different title, kept Paste meeting",
        ].sort(),
        "the distinct original's conflicting metadata is reported",
      );
      assert.equal(resultPageProject(distinctResult), "", "the result keeps no project, the preserved value");
      // The preserved metadata is read back on the stored meeting immediately,
      // so an overwrite specific to the distinct-original path is visible.
      const distinctMeetingPage = await get(base, pasteMeeting);
      assert.equal(distinctMeetingPage.status, 200, "the canonical meeting is readable");
      assert.equal(profileValue(distinctMeetingPage.body, "Title"), "Paste meeting", "the distinct original kept the title");
      assert.equal(profileValue(distinctMeetingPage.body, "Date"), "2026-01-10", "the distinct original kept the date");
      assert.equal(profileValue(distinctMeetingPage.body, "Notes"), "Imported notes", "the distinct original kept the notes");
      // The preserved project is read from the stored meeting's own `Identity
      // and parents` section, before any later repeat can change it.
      assert.equal(profileProject(distinctMeetingPage.body), "", "the distinct original kept the engagement-only project");

      const firstRows = await meetingSources(base, pasteMeeting);
      assert.deepEqual(firstRows.map((row) => row.filename), ["Pasted text", "notes.txt"], "the distinct original added a readable source");
      assert.deepEqual(firstRows.map((row) => row.format), ["paste", "txt"]);
      // The distinct original's readable source is the exact TXT bytes and
      // their text and passages, checked before it becomes a restart baseline.
      const txtRow = firstRows.find((row) => row.filename === "notes.txt");
      assert.ok(txtRow !== undefined, "the distinct original's TXT row is listed");
      const txtView = await readSource(base, pasteMeeting, txtRow!, 2);
      assert.deepEqual(txtView.originalBytes, Buffer.from(encoder.encode(TEXT_FILE)), "the distinct original's bytes are the TXT file's bytes");
      assert.equal(txtView.text, TEXT_FILE, "the distinct original's text is the TXT file's text");
      assert.equal(txtView.passages[0].text, 'Alice:  "The budget is fixed," she said.', "the distinct original's first quote is its own text");

      // -- Import 3: an exact repeat of one stored file under a new name. ----
      const repeatResult = await importThrough(base, pasteAction, pasteAction, {
        title: "Paste meeting",
        date: "2026-01-10",
        notes: "Imported notes",
        paste: "",
        file: { filename: "renamed.txt", body: encoder.encode(TEXT_FILE) },
      });
      assert.equal(resultMeetingLink(repeatResult), pasteMeeting, "an exact repeat names the canonical meeting");
      assert.match(resultExplanation(repeatResult) ?? "", /exact original is already stored and was reused/i);
      const repeatRows = await meetingSources(base, pasteMeeting);
      assert.deepEqual(
        repeatRows.map((row) => row.filename),
        ["Pasted text", "notes.txt"],
        "the exact repeat kept the first filename and added no source",
      );
      assert.equal(repeatRows.length, 2, "the exact repeat kept the source count");

      // -- Import 4: Markdown of a different case, a separate meeting. -------
      const markdownResult = await importThrough(base, pasteAction, pasteAction, {
        title: "Markdown meeting",
        date: "2026-01-11",
        notes: "",
        paste: "",
        file: { filename: "minutes.md", body: encoder.encode(MARKDOWN) },
      });
      const markdownMeeting = resultMeetingLink(markdownResult);
      const markdownLabel = labelOf(markdownMeeting, "2026-01-11 — Markdown meeting");
      assert.notEqual(markdownMeeting, pasteMeeting, "a case change creates a separate meeting");
      assert.equal(resultExplanation(markdownResult), null, "a first content creates a meeting without an explanation");

      // -- Import 5: the same text in the beta engagement, a separate meeting.
      const betaPage = await get(base, `/engagements/${encodeURIComponent(betaEngagementId)}`);
      const betaAction = importActionOf(betaPage.body, `/engagements/${encodeURIComponent(betaEngagementId)}`);
      const betaResult = await importThrough(base, betaAction, betaAction, {
        title: "Beta meeting",
        date: "2026-01-12",
        notes: "",
        paste: OTHER_ENGAGEMENT_TEXT,
        file: { filename: "", body: "" },
      });
      const betaMeeting = resultMeetingLink(betaResult);
      const betaLabel = labelOf(betaMeeting, "2026-01-12 — Beta meeting");
      assert.notEqual(betaMeeting, pasteMeeting, "the same text in another engagement is a separate meeting");

      // -- Import 6: attach once to the manual meeting; its notes are kept. --
      // The source's text is unique to this part of the library, so it is a
      // new content the engagement does not hold and the manual meeting
      // receives its first attachment.
      const ATTACHED = 'Dana: "The attachment is a new transcript," she said.\n\nEli: It keeps the notes.';
      const manualPage = await get(base, manualMeetingPath);
      const attachAction = importActionOf(manualPage.body, manualMeetingPath);
      assert.equal(attachAction, `${manualMeetingPath}/transcripts/import`, "the meeting page links its attach form");
      const attachForm = parseForm((await get(base, attachAction)).body);
      assert.deepEqual([...attachForm.controls.keys()].sort(), ["file", "paste"], "the attach form takes only the source");
      const attachResult = await importThrough(base, attachAction, attachAction, {
        paste: ATTACHED,
        file: { filename: "", body: "" },
      });
      assert.equal(resultMeetingLink(attachResult), manualMeetingPath, "the attachment is on the manual meeting");
      assert.match(resultExplanation(attachResult) ?? "", /attached once to the notes-only meeting/i);
      const manualAfterAttach = await get(base, manualMeetingPath);
      assert.equal(profileValue(manualAfterAttach.body, "Title"), "Manual kickoff", "the meeting title is kept");
      assert.equal(profileValue(manualAfterAttach.body, "Date"), "2026-01-05", "the meeting date is kept");
      assert.equal(profileValue(manualAfterAttach.body, "Notes"), MANUAL_NOTES, "the meeting notes are kept");
      // Exactly one source was attached, and its text reads back as ATTACHED.
      const manualRows = await meetingSources(base, manualMeetingPath);
      assert.equal(manualRows.length, 1, "the manual meeting holds exactly one attached source");
      assert.equal(manualRows[0].format, "paste");
      const manualView = await readSource(base, manualMeetingPath, manualRows[0], 2);
      assert.equal(manualView.text, ATTACHED, "the attached source's text is the attached transcript");

      // An attachment is never replaced: a different content aimed at it is
      // refused, and the refusal keeps the attach form's own guidance.
      const refusedAttach = await submit(base, attachAction, parseForm((await get(base, attachAction)).body), {
        paste: "Carol: A different transcript.",
        file: { filename: "", body: "" },
      });
      assert.equal(refusedAttach.status, 400, "a second, different attachment is refused");
      assert.match(refusedAttach.body, /already holds a transcript of different content/);
      assert.match(refusedAttach.body, /Supported formats:/, "the refused form still states the formats");
      // The refused replacement left the manual meeting's single source and
      // its notes untouched, and the saved source link still reads back.
      const manualAfterRefusal = await get(base, manualMeetingPath);
      assert.equal(profileValue(manualAfterRefusal.body, "Notes"), MANUAL_NOTES, "the refused replacement kept the notes");
      assert.deepEqual(sourceRows(manualAfterRefusal.body), manualRows, "the refused replacement added no source");
      assert.equal((await readSource(base, manualMeetingPath, manualRows[0], 2)).text, ATTACHED, "the saved source link still reads the attachment");

      // -- Import 7: the DOCX and 8: the PDF, through the project's action. --
      const projectPage = await get(base, projectHref);
      const projectHistory = sectionOf(projectPage.body, "Meeting history");
      const docxAction = historyImportLink(projectHistory);
      assert.match(docxAction, /^\/projects\/[^/]+\/transcripts\/import$/, "the project history links the project import");
      const docxForm = parseForm((await get(base, docxAction)).body);
      assert.equal(docxForm.controls.get("projectId")?.value, projectId, "the project import preselects the URL project");
      const docxResult = await importThrough(base, docxAction, docxAction, {
        title: "DOCX meeting",
        date: "2026-01-13",
        notes: "",
        paste: "",
        file: { filename: "blocks.docx", body: docxBytes(DOCX_PARAGRAPHS) },
      });
      const docxMeeting = resultMeetingLink(docxResult);
      const docxLabel = labelOf(docxMeeting, "2026-01-13 — DOCX meeting");
      assert.equal(resultPageProject(docxResult), projectHref, "the DOCX meeting keeps the preselected project");

      // The PDF with a blank page, submitted with the same preselected project.
      const pdfResult = await importThrough(base, docxAction, docxAction, {
        title: "PDF meeting",
        date: "2026-01-09",
        notes: "PDF notes",
        paste: "",
        file: { filename: "report.pdf", body: pdfBytes(PDF_PAGES) },
      });
      const pdfMeeting = resultMeetingLink(pdfResult);
      const pdfLabel = labelOf(pdfMeeting, "2026-01-09 — PDF meeting");
      assert.equal(resultPageProject(pdfResult), projectHref, "the PDF meeting is in the project");

      // -- Preserved metadata: a repeat with different metadata. -------------
      // The engagement holds the pasted canonical content; supplying a
      // different title, date and project is reported and never written.
      const conflictResult = await importThrough(base, pasteAction, pasteAction, {
        title: "A different title",
        date: "2026-02-01",
        notes: "A different note",
        projectId: projectId,
        paste: PASTED,
        file: { filename: "", body: "" },
      });
      assert.equal(resultMeetingLink(conflictResult), pasteMeeting, "the canonical meeting is reused");
      assert.match(resultExplanation(conflictResult) ?? "", /exact original is already stored/i);
      assert.deepEqual(
        resultConflicts(conflictResult).sort(),
        [
          "date: submitted 2026-02-01, kept 2026-01-10",
          `projectId: submitted ${projectId}, kept `,
          "notes: submitted A different note, kept Imported notes",
          "title: submitted A different title, kept Paste meeting",
        ].sort(),
        "every supplied metadata difference is reported",
      );
      // The preserved meeting still shows its own metadata.
      const preservedPage = await get(base, pasteMeeting);
      assert.equal(profileValue(preservedPage.body, "Title"), "Paste meeting");
      assert.equal(profileValue(preservedPage.body, "Date"), "2026-01-10");
      assert.equal(profileValue(preservedPage.body, "Notes"), "Imported notes");

      // -- Refusals: invalid UTF-8, corrupt DOCX/PDF and a scan. --------------
      // Each refusal names the format it could not read and the concrete
      // recovery action, and the scan case names selectable-text export.
      const refusals: readonly {
        readonly name: string;
        readonly filename: string;
        readonly body: Uint8Array;
        readonly diagnosis: RegExp;
        readonly recovery: RegExp;
      }[] = [
        {
          name: "invalid UTF-8",
          filename: "broken.txt",
          body: INVALID_UTF8,
          diagnosis: /is not valid UTF-8/,
          recovery: /import pasted text, or a UTF-8 \.txt or \.md file/,
        },
        {
          name: "corrupt DOCX",
          filename: "broken.docx",
          body: encoder.encode("This is not a DOCX archive."),
          diagnosis: /could not be read as a DOCX document/,
          recovery: /Re-export the document as DOCX \(Word, \.docx\) or as UTF-8 text \(\.txt\)/,
        },
        {
          name: "corrupt PDF",
          filename: "broken.pdf",
          body: corruptBytes(),
          diagnosis: /could not be read as a PDF document/,
          recovery: /Re-export the document as a text-based PDF with selectable text, or as UTF-8 text \(\.txt\)/,
        },
        {
          name: "image-only PDF",
          filename: "scan.pdf",
          body: pdfBytes(["image-only"]),
          diagnosis: /carries no extractable text/,
          recovery: /export a text-based copy of the document with selectable text/,
        },
      ];
      // The engagement's meetings before any refusal, captured from the page,
      // so a refusal that changed the list is visible; and the source rows of
      // every meeting in the engagement, so a refusal that appended a source to
      // any meeting (not only the one it was aimed past) is visible.
      const entriesBeforeRefusals = historyEntries(sectionOf((await get(base, alphaHref)).body, "Meeting history"));
      const meetingsBeforeRefusals = [...entriesBeforeRefusals.values()];
      const meetingRowsBefore = new Map<string, ReturnType<typeof sourceRows>>();
      for (const meeting of meetingsBeforeRefusals) {
        meetingRowsBefore.set(meeting, await meetingSources(base, meeting));
      }
      // Every source row of every engagement meeting is read once before the
      // refusals as a baseline keyed by its meeting and filename, so each
      // refusal can be compared against the same bytes, text and passages
      // through the same rendered links.
      const viewsBefore = new Map<string, { readonly row: ReturnType<typeof sourceRows>[number]; readonly view: SourceView }>();
      for (const [meeting, savedRows] of meetingRowsBefore) {
        for (const row of savedRows) {
          viewsBefore.set(`${meeting} ${row.filename}`, {
            row,
            view: await readSource(base, meeting, row, row.filename === "blocks.docx" ? 3 : 2),
          });
        }
      }
      // The four meetings holding sources (the manual, the Markdown, the DOCX
      // and the PDF meeting) all have a baseline, so each refusal is compared
      // against them; the source-free sibling meeting has none.
      assert.deepEqual(
        [...new Set([...viewsBefore.keys()].map((key) => key.split(" ")[0]))].sort(),
        [pasteMeeting, markdownMeeting, manualMeetingPath, docxMeeting, pdfMeeting].sort(),
        "the meetings holding sources are read before the refusals",
      );
      const compareView = (name: string, view: SourceView, before: SourceView): void => {
        assert.deepEqual(view.originalBytes, before.originalBytes, `${name} kept the prior original bytes`);
        assert.equal(view.text, before.text, `${name} kept the prior full text`);
        assert.deepEqual(view.passages, before.passages, `${name} kept the prior quotes and locations`);
        assert.deepEqual(view.passageLinks, before.passageLinks, `${name} kept the prior fragment targets`);
      };
      for (const refusal of refusals) {
        const form = parseForm((await get(base, pasteAction)).body);
        assert.equal(form.enctype, "multipart/form-data", "the corrected form stays a multipart form");
        const reply = await submit(base, pasteAction, form, {
          title: `Refused ${refusal.name}`,
          date: "2026-01-20",
          notes: "",
          paste: "",
          file: { filename: refusal.filename, body: refusal.body },
        });
        assert.equal(reply.status, 400, `${refusal.name} is refused with 400`);
        assert.match(String(reply.headers["content-type"]), /^text\/html; charset=utf-8/, `${refusal.name} answers HTML`);
        assert.match(reply.body, refusal.diagnosis, `${refusal.name} names the problem`);
        assert.match(reply.body, refusal.recovery, `${refusal.name} states the recovery action`);
        assert.match(reply.body, /Supported formats: pasted plain text; UTF-8 \.txt and \.md files; \.docx documents; text-based \.pdf files/);
        // A refusal adds no meeting to the engagement history (same labels and
        // same destinations), and adds no source to any of its meetings.
        expectHistory(
          sectionOf((await get(base, alphaHref)).body, "Meeting history"),
          [...entriesBeforeRefusals.entries()],
          `${refusal.name} left the engagement's meetings as they were`,
        );
        for (const [meeting, savedRows] of meetingRowsBefore) {
          assert.deepEqual(await meetingSources(base, meeting), savedRows, `${refusal.name} added no source to ${meeting}`);
        }
        // Every saved row, through its own saved links and on its own meeting
        // page, still reads back exactly as it did before the refusals:
        // original bytes, text, quotes, locations and fragment destinations.
        for (const [key, baseline] of viewsBefore) {
          const meeting = key.split(" ")[0];
          const row = baseline.row;
          const stillListed = (await meetingSources(base, meeting)).find((candidate) => candidate.filename === row.filename);
          assert.ok(stillListed !== undefined, `${refusal.name} kept ${row.filename} listed on ${meeting}`);
          assert.deepEqual(stillListed, row, `${refusal.name} kept ${row.filename}'s links on ${meeting}`);
          const saved = await readSource(base, meeting, row, baseline.view.passages.length);
          compareView(`${refusal.name} and ${row.filename}`, saved, baseline.view);
        }
      }
      // The prior sources and their rows are unchanged by the refusals, read
      // from the saved rows captured before them, on each meeting that holds
      // sources.
      for (const meeting of [pasteMeeting, markdownMeeting, manualMeetingPath, docxMeeting, pdfMeeting]) {
        assert.deepEqual(await meetingSources(base, meeting), meetingRowsBefore.get(meeting), `the earlier sources on ${meeting} are unchanged by refusals`);
      }

      // -- The client history across engagements. ----------------------------
      const clientPath = `/clients/${encodeURIComponent(clientId)}`;
      const clientPage = await get(base, clientPath);
      assert.equal(clientPage.status, 200, "the client page is rendered");
      const clientHistory = sectionOf(clientPage.body, "Meeting history");
      assert.notEqual(clientHistory, "", "the client page renders its meeting history section");
      assert.equal(historyImportLink(clientHistory), "", "the client history offers no single import action");
      // The histories render newest first, so the expected sequence is by date.
      expectHistory(
        clientHistory,
        [
          [docxLabel, docxMeeting],
          [betaLabel, betaMeeting],
          [markdownLabel, markdownMeeting],
          [pasteLabel, pasteMeeting],
          [pdfLabel, pdfMeeting],
          [siblingLabel, siblingMeetingPath],
          [manualLabel, manualMeetingPath],
          [betaManualLabel, betaManualPath],
        ],
        "the client history shows its client's every meeting across engagements, and no other client's",
      );
      // Each client-history card is selected by its visible label, its own link
      // is followed, and the destination meeting page and its sources read.
      for (const [label, meeting] of [
        [pasteLabel, pasteMeeting],
        [markdownLabel, markdownMeeting],
        [betaLabel, betaMeeting],
        [manualLabel, manualMeetingPath],
        [docxLabel, docxMeeting],
        [pdfLabel, pdfMeeting],
        [siblingLabel, siblingMeetingPath],
        [betaManualLabel, betaManualPath],
      ] as const) {
        const href = historyCardFor(clientHistory, label, meeting);
        const body = await followMeeting(base, href, label);
        assert.ok(body.includes("<main id=\"main\">"), `${label}'s client-history card destination is a page`);
        await meetingSources(base, href);
      }

      // The other client's engagement and client are readable pages with a
      // rendered history section that lists none of these meetings.
      const foreignPage = await get(base, `/engagements/${encodeURIComponent(foreignEngagementId)}`);
      assert.equal(foreignPage.status, 200, "the other client's engagement is readable");
      const foreignEngagementSection = sectionOf(foreignPage.body, "Meeting history");
      assert.notEqual(foreignEngagementSection, "", "the other client's engagement renders its history section");
      expectHistory(foreignEngagementSection, [], "the other client's engagement holds no meeting");
      const foreignClientPage = await get(base, `/clients/${encodeURIComponent(anotherClientId)}`);
      assert.equal(foreignClientPage.status, 200, "the other client's page is readable");
      const foreignClientSection = sectionOf(foreignClientPage.body, "Meeting history");
      assert.notEqual(foreignClientSection, "", "the other client's page renders its history section");
      expectHistory(foreignClientSection, [], "the other client's history is empty");

      // -- The engagement history, including project meetings once. ----------
      const alphaHistoryNow = sectionOf((await get(base, alphaHref)).body, "Meeting history");
      assert.notEqual(alphaHistoryNow, "", "the engagement page renders its history section");
      expectHistory(
        alphaHistoryNow,
        [
          [docxLabel, docxMeeting],
          [markdownLabel, markdownMeeting],
          [pasteLabel, pasteMeeting],
          [pdfLabel, pdfMeeting],
          [siblingLabel, siblingMeetingPath],
          [manualLabel, manualMeetingPath],
        ],
        "the engagement history holds its own meetings, project meetings included, once, newest first",
      );
      // Each expected meeting's card is selected by its visible label and its
      // own link is followed to the meeting it names, whose sources are read.
      for (const [label, meeting] of [
        [pasteLabel, pasteMeeting],
        [markdownLabel, markdownMeeting],
        [manualLabel, manualMeetingPath],
        [docxLabel, docxMeeting],
        [pdfLabel, pdfMeeting],
        [siblingLabel, siblingMeetingPath],
      ] as const) {
        const href = historyCardFor(alphaHistoryNow, label, meeting);
        const body = await followMeeting(base, href, label);
        assert.ok(body.includes("<main id=\"main\">"), `${label}'s card destination is a meeting page`);
        await meetingSources(base, href);
      }

      // -- The project history, only its assigned meetings. ------------------
      const projectHistoryPage = await get(base, projectHref);
      assert.equal(projectHistoryPage.status, 200, "the project page is readable");
      const projectHistorySection = sectionOf(projectHistoryPage.body, "Meeting history");
      assert.notEqual(projectHistorySection, "", "the project page renders its history section");
      expectHistory(
        projectHistorySection,
        [
          [docxLabel, docxMeeting],
          [pdfLabel, pdfMeeting],
        ],
        "the project history holds exactly its assigned meetings, by date",
      );
      assert.equal(historyCardFor(projectHistorySection, pasteLabel, pasteMeeting), "", "an engagement-only meeting's card is not in the project history");
      // Each project card's own link is followed to its assigned meeting, which
      // shows its own profile and names the project as its parent.
      for (const [label, meeting] of [
        [docxLabel, docxMeeting],
        [pdfLabel, pdfMeeting],
      ] as const) {
        const href = historyCardFor(projectHistorySection, label, meeting);
        const body = await followMeeting(base, href, label);
        assert.equal(profileProject(body), projectHref, `${label}'s meeting names the project as its parent`);
        await meetingSources(base, href);
      }
      const siblingHistorySection = sectionOf(
        (await get(base, `/projects/${encodeURIComponent(siblingProjectId)}`)).body,
        "Meeting history",
      );
      assert.notEqual(siblingHistorySection, "", "the sibling project renders its history section");
      expectHistory(siblingHistorySection, [[siblingLabel, siblingMeetingPath]], "the sibling project lists only its own meeting");
      assert.notEqual(historyCardFor(siblingHistorySection, siblingLabel, siblingMeetingPath), "");
      // The sibling meeting's card is followed to its own page, which shows its
      // own profile, and its (empty) sources are listed.
      const siblingCard = historyCardFor(siblingHistorySection, siblingLabel, siblingMeetingPath);
      const siblingBody = await followMeeting(base, siblingCard, siblingLabel);
      assert.equal(profileProject(siblingBody), `/projects/${encodeURIComponent(siblingProjectId)}`, "the sibling meeting names its project");
      await meetingSources(base, siblingCard);

      // -- The DOCX and PDF sources, read over HTTP. -------------------------
      const docxSources = await meetingSources(base, docxMeeting);
      assert.equal(docxSources.length, 1);
      assert.equal(docxSources[0].filename, "blocks.docx");
      const docxView = await readSource(base, docxMeeting, docxSources[0], 3);
      assert.deepEqual(new Uint8Array(docxView.originalBytes), docxBytes(DOCX_PARAGRAPHS), "the DOCX bytes are preserved exactly");
      assert.equal(docxView.text, DOCX_PARAGRAPHS.join("\n\n"), "the DOCX text is the extracted blocks");
      assert.deepEqual(docxView.passages.map((p) => p.text), DOCX_PARAGRAPHS.join("\n\n").split("\n\n"));
      assert.ok(docxView.passages.every((p) => p.location === "Extracted block"), "a DOCX passage names its block");

      const pdfSources = await meetingSources(base, pdfMeeting);
      assert.equal(pdfSources.length, 1);
      assert.equal(pdfSources[0].filename, "report.pdf");
      const pdfView = await readSource(base, pdfMeeting, pdfSources[0], 2);
      assert.deepEqual(new Uint8Array(pdfView.originalBytes), pdfBytes(PDF_PAGES), "the PDF bytes are preserved exactly");
      assert.equal(pdfView.text, "Alice: The budget is fixed.\n\nBob: We can work within it.", "the blank page contributes no text");
      assert.deepEqual(pdfView.passages.map((p) => p.location), ["PDF page 1", "PDF page 3"], "the blank page is skipped, not renumbered");

      // The pasted source keeps its exact text and quoted passage.
      const pasteRows = await meetingSources(base, pasteMeeting);
      const pastedView = await readSource(base, pasteMeeting, pasteRows[0], 2);
      assert.equal(pastedView.text, PASTED, "a pasted original's text is exact");
      assert.equal(pastedView.passages[0].text, 'Alice: "The budget is fixed," she said.', "the quoted passage is exact");
      // The Markdown source keeps its case in the text it serves.
      const markdownRows = await meetingSources(base, markdownMeeting);
      const markdownView = await readSource(base, markdownMeeting, markdownRows[0], 2);
      assert.equal(markdownView.text, MARKDOWN, "the Markdown text is exact");

      // The beta meeting's own source is read and kept as a baseline.
      const betaRows = await meetingSources(base, betaMeeting);
      assert.equal(betaRows.length, 1, "the beta meeting holds its own source");
      const betaView = await readSource(base, betaMeeting, betaRows[0], 2);
      assert.equal(betaView.text, OTHER_ENGAGEMENT_TEXT, "the beta meeting's source is the text imported there");

      // -- Save what a restart must reproduce. -------------------------------
      interface SavedSource {
        /** The `date — title` label of the meeting's history card. */
        readonly meetingLabel: string;
        readonly meeting: string;
        readonly filename: string;
        readonly format: string;
        readonly original: string;
        readonly text: string;
        readonly passages: string;
        readonly view: SourceView;
      }
      const saved = {
        projectHref,
        alphaHref,
        clientPath,
        sourcesAll: [] as SavedSource[],
      };
      // Every meeting with its sources, in one common walk. The project
      // meetings are saved too, so the archive step has a baseline and the
      // restart baseline holds every active meeting's sources.
      for (const [meetingLabel, meeting, rows, expectedPassages] of [
        [pasteLabel, pasteMeeting, pasteRows, 2],
        [manualLabel, manualMeetingPath, manualRows, 2],
        [markdownLabel, markdownMeeting, markdownRows, 2],
        [docxLabel, docxMeeting, docxSources, 3],
        [pdfLabel, pdfMeeting, pdfSources, 2],
        [betaLabel, betaMeeting, betaRows, 2],
      ] as const) {
        for (const row of rows) {
          const entry: SavedSource = {
            meetingLabel,
            meeting,
            filename: row.filename,
            format: row.format,
            original: row.original,
            text: row.text,
            passages: row.passages,
            view: await readSource(base, meeting, row, expectedPassages),
          };
          saved.sourcesAll.push(entry);
        }
      }
      // The saved baselines name every meeting's sources, the DOCX and PDF
      // meetings' (archived later, and read through their own paths), the beta
      // meeting's and the manual meeting's included.
      assert.deepEqual(
        saved.sourcesAll.map((source) => source.meetingLabel).sort(),
        [pasteLabel, pasteLabel, manualLabel, markdownLabel, docxLabel, pdfLabel, betaLabel].sort(),
        "the restart baselines cover every meeting with its sources",
      );

      // -- Archive the project: its meetings leave the active histories. -----
      // The project page's own archive form is followed as the browser would,
      // through the shared submission path (a POST to the rendered action).
      const projectArchivePage = await get(base, projectHref);
      assert.equal(projectArchivePage.status, 200, "the project page is readable");
      const archiveForm = parseForm(projectArchivePage.body);
      assert.equal(archiveForm.action, `${projectHref}/archive`, "the project page offers its archive action");
      assert.ok(
        archiveForm.enctype === null || archiveForm.enctype === "application/x-www-form-urlencoded",
        `the archive form is a url-encoded form, not ${archiveForm.enctype}`,
      );
      const archived = await submit(base, projectHref, archiveForm);
      assert.equal(archived.status, 303, "archiving redirects to the project");
      assert.equal(String(archived.headers.location), projectHref);

      // Neither project meeting is in the engagement or client histories, and
      // none of the project's sources were added or removed by archiving. The
      // histories are read as a 200 page carrying its rendered section.
      const archivedEngagementPage = await get(base, alphaHref);
      assert.equal(archivedEngagementPage.status, 200, "the engagement page is readable after archiving");
      const archivedEngagementSection = sectionOf(archivedEngagementPage.body, "Meeting history");
      assert.notEqual(archivedEngagementSection, "", "the engagement page renders its history section after archiving");
      expectHistory(
        archivedEngagementSection,
        [
          [markdownLabel, markdownMeeting],
          [pasteLabel, pasteMeeting],
          [siblingLabel, siblingMeetingPath],
          [manualLabel, manualMeetingPath],
        ],
        "the engagement history keeps only its active meetings after archiving, newest first",
      );
      assert.equal(historyCardFor(archivedEngagementSection, docxLabel, docxMeeting), "", "the archived project's DOCX meeting left the engagement history");
      assert.equal(historyCardFor(archivedEngagementSection, pdfLabel, pdfMeeting), "", "the archived project's PDF meeting left the engagement history");
      const archivedClientPage = await get(base, clientPath);
      assert.equal(archivedClientPage.status, 200, "the client page is readable after archiving");
      const archivedClientSection = sectionOf(archivedClientPage.body, "Meeting history");
      assert.notEqual(archivedClientSection, "", "the client page renders its history section after archiving");
      expectHistory(
        archivedClientSection,
        [
          [betaLabel, betaMeeting],
          [markdownLabel, markdownMeeting],
          [pasteLabel, pasteMeeting],
          [siblingLabel, siblingMeetingPath],
          [manualLabel, manualMeetingPath],
          [betaManualLabel, betaManualPath],
        ],
        "the client history keeps only its active meetings after archiving, newest first",
      );
      assert.equal(historyCardFor(archivedClientSection, docxLabel, docxMeeting), "", "the archived project's DOCX meeting left the client history");
      assert.equal(historyCardFor(archivedClientSection, pdfLabel, pdfMeeting), "", "the archived project's PDF meeting left the client history");
      // The project's own history is empty while it is archived, and the
      // project page stays readable with its archive notice and history.
      const archivedProjectPage = await get(base, projectHref);
      assert.equal(archivedProjectPage.status, 200, "the archived project page is readable");
      assert.match(archivedProjectPage.body, /This record is archived/);
      const archivedProjectSection = sectionOf(archivedProjectPage.body, "Meeting history");
      assert.notEqual(archivedProjectSection, "", "the archived project page renders its meeting history section");
      expectHistory(archivedProjectSection, [], "the archived project lists no active meeting");

      // Freshly fetched source rows for the project's meetings equal the rows
      // saved before archiving: archiving added or removed no source.
      for (const meeting of [docxMeeting, pdfMeeting]) {
        const savedRows = saved.sourcesAll
          .filter((candidate) => candidate.meeting === meeting)
          .map((candidate) => savedRow(candidate));
        assert.deepEqual(await meetingSources(base, meeting), savedRows, `${meeting} lists the same sources after archiving`);
      }

      // Direct meeting and source links still work for the archived meetings,
      // whose own pages keep their source rows with all three links, and whose
      // rows and bytes still match the saved baselines.
      for (const meeting of [docxMeeting, pdfMeeting]) {
        const page = await get(base, meeting);
        assert.equal(page.status, 200, `${meeting} stays directly readable`);
        assert.match(page.body, /archived/, "the archived meeting page says it is archived");
        const rows = sourceRows(page.body);
        assert.equal(rows.length, 1, `${meeting} still lists its source`);
        assert.equal(rows[0].filename, meeting === docxMeeting ? "blocks.docx" : "report.pdf");
      }
      for (const source of saved.sourcesAll.filter((candidate) => candidate.meeting === docxMeeting || candidate.meeting === pdfMeeting)) {
        const view = await readSource(base, source.meeting, savedRow(source), source.view.passages.length || 1);
        assert.deepEqual(view.originalBytes, source.view.originalBytes, `${source.filename} original bytes still match after archiving`);
        assert.equal(view.text, source.view.text, `${source.filename} text still matches after archiving`);
      }

      // -- Restart over the same directory, on a new origin. -----------------
      // The second instance's own URL is the origin for every restarted
      // request; no assumption is made about how the OS allocates ports.
      await app.close();
      app = await startApplication({ dataDirectory: dir, port: 0 });
      const restarted = app.url;

      // The saved paths are resolved against the new origin, and the same
      // pages are rediscovered from the histories, not from the saved paths.
      const restartedAlpha = await get(restarted, alphaHref);
      assert.equal(restartedAlpha.status, 200);
      const restartedAlphaHistorySection = sectionOf(restartedAlpha.body, "Meeting history");
      assert.notEqual(restartedAlphaHistorySection, "", "the restarted engagement page renders its history section");
      expectHistory(
        restartedAlphaHistorySection,
        [
          [markdownLabel, markdownMeeting],
          [pasteLabel, pasteMeeting],
          [siblingLabel, siblingMeetingPath],
          [manualLabel, manualMeetingPath],
        ],
        "the restarted engagement history is the same active history, newest first",
      );
      const restartedAlphaEntries = historyEntries(restartedAlphaHistorySection);
      const restartedClientPage = await get(restarted, clientPath);
      assert.equal(restartedClientPage.status, 200);
      const restartedClientHistorySection = sectionOf(restartedClientPage.body, "Meeting history");
      assert.notEqual(restartedClientHistorySection, "", "the restarted client page renders its history section");
      expectHistory(
        restartedClientHistorySection,
        [
          [betaLabel, betaMeeting],
          [markdownLabel, markdownMeeting],
          [pasteLabel, pasteMeeting],
          [siblingLabel, siblingMeetingPath],
          [manualLabel, manualMeetingPath],
          [betaManualLabel, betaManualPath],
        ],
        "the restarted client history is the same active history, newest first",
      );
      const restartedClientEntries = historyEntries(restartedClientHistorySection);
      // The archived project's history is empty after the restart, and the
      // project page is read as a successful 200 carrying its section.
      const restartedProjectPage = await get(restarted, projectHref);
      assert.equal(restartedProjectPage.status, 200, "the archived project page is readable after the restart");
      assert.match(restartedProjectPage.body, /This record is archived/);
      const restartedProjectSection = sectionOf(restartedProjectPage.body, "Meeting history");
      assert.notEqual(restartedProjectSection, "", "the archived project still renders its history section");
      expectHistory(restartedProjectSection, [], "the archived project still lists no active meeting after the restart");
      // The archived meetings are still directly readable after the restart.
      for (const meeting of [docxMeeting, pdfMeeting]) {
        const page = await get(restarted, meeting);
        assert.equal(page.status, 200, `${meeting} is readable after the restart`);
        const savedRows = saved.sourcesAll
          .filter((candidate) => candidate.meeting === meeting)
          .map((candidate) => savedRow(candidate));
        assert.deepEqual(sourceRows(page.body), savedRows, `${meeting} keeps its saved source rows after the restart`);
      }
      // Every active history entry is selected by its visible label, its own
      // href is followed, and the destination meeting page and its sources are
      // read, so each card still reaches its own meeting page.
      for (const [section, label, meeting] of [
        [restartedAlphaHistorySection, pasteLabel, pasteMeeting],
        [restartedAlphaHistorySection, markdownLabel, markdownMeeting],
        [restartedAlphaHistorySection, manualLabel, manualMeetingPath],
        [restartedAlphaHistorySection, siblingLabel, siblingMeetingPath],
        [restartedClientHistorySection, betaLabel, betaMeeting],
        [restartedClientHistorySection, betaManualLabel, betaManualPath],
      ] as const) {
        const href = historyCardFor(section, label, meeting);
        const body = await followMeeting(restarted, href, label);
        assert.ok(body.includes("<main id=\"main\">"), `${label}'s card destination is a page after the restart`);
        await meetingSources(restarted, href);
      }

      // Each saved source is rediscovered on its meeting page and read over the
      // new origin: original bytes, full text, quotes, locations and fragment
      // targets (each resolved at its own destination page). An active
      // meeting's page is found through the history card carrying its label;
      // an archived meeting is no longer in an active history, so its own
      // saved direct meeting path is resolved against the new origin.
      for (const source of saved.sourcesAll) {
        const active =
          restartedAlphaEntries.get(source.meetingLabel) ?? restartedClientEntries.get(source.meetingLabel) ?? "";
        const href = active === "" ? splitLink(restarted, "/", source.meeting).path : active;
        if (active !== "") {
          assert.equal(active, source.meeting, `${source.meetingLabel} is rediscovered in the history after the restart`);
        }
        const rows = await meetingSources(restarted, href);
        // The rediscovered rows are the saved rows exactly, in order: a source
        // added or removed across the restart fails here, not only a missing
        // filename among extra ones.
        assert.deepEqual(
          rows.map((candidate) => savedRow(candidate)),
          saved.sourcesAll.filter((candidate) => candidate.meeting === source.meeting).map((candidate) => savedRow(candidate)),
          `${source.meetingLabel}'s rediscovered rows are the saved rows`,
        );
        const row = rows.find((candidate) => candidate.filename === source.filename);
        assert.ok(row !== undefined, `${source.filename} is rediscovered on ${source.meeting}`);
        assert.equal(row!.original, source.original, "the rediscovered original path is unchanged");
        assert.equal(row!.text, source.text, "the rediscovered text path is unchanged");
        assert.equal(row!.passages, source.passages, "the rediscovered passages path is unchanged");
        const view = await readSource(restarted, href, row!, source.view.passages.length);
        assert.deepEqual(view.originalBytes, source.view.originalBytes, `${source.filename} original bytes match across the restart`);
        assert.equal(view.text, source.view.text, `${source.filename} full text matches across the restart`);
        assert.deepEqual(
          view.passages.map((passage, index) => ({
            anchor: passage.anchor,
            text: passage.text,
            offsets: passage.offsets,
            position: passage.position,
            location: passage.location,
            fragment: source.view.passageFragments[index],
          })),
          source.view.passages.map((passage, index) => ({
            anchor: passage.anchor,
            text: passage.text,
            offsets: passage.offsets,
            position: passage.position,
            location: passage.location,
            fragment: source.view.passageFragments[index],
          })),
          `${source.filename} passages, quotes, locations and fragment targets match across the restart`,
        );
        assert.deepEqual(
          view.passageLinks.map((link) => ({ path: link.path, fragment: link.fragment })),
          source.view.passageLinks.map((link) => ({ path: link.path, fragment: link.fragment })),
          `${source.filename} passage-link destinations match across the restart`,
        );
        // The saved paths, resolved against the new origin, still serve the
        // same bytes, text and fragment targets: the saved original and text
        // paths are fetched, and each saved passage link is resolved against
        // its rendering page and followed to its destination row.
        const savedOriginal = await get(restarted, source.original);
        assert.deepEqual(savedOriginal.bytes, source.view.originalBytes, `${source.filename} saved original path serves the same bytes`);
        const savedText = await get(restarted, source.text);
        assert.equal(savedText.body, source.view.text, `${source.filename} saved text path serves the same text`);
        const savedPassages = await get(restarted, source.passages);
        assert.equal(savedPassages.status, 200, `${source.filename} saved passages page is readable`);
        const savedRendered = renderedPassages(savedPassages.body);
        assert.equal(savedRendered.length, source.view.passages.length, `${source.filename} saved passages page renders the same rows`);
        for (const [index, savedPassage] of savedRendered.entries()) {
          const savedBaseline = source.view.passages[index];
          // The row the saved page renders now must show the pre-restart quote
          // and metadata, so a changed quote or location fails before the
          // destination is even followed.
          assert.deepEqual(
            {
              anchor: savedPassage.anchor,
              text: savedPassage.text,
              offsets: savedPassage.offsets,
              position: savedPassage.position,
              location: savedPassage.location,
              fragment: splitLink(restarted, source.passages, savedPassage.link).fragment,
            },
            {
              anchor: savedBaseline.anchor,
              text: savedBaseline.text,
              offsets: savedBaseline.offsets,
              position: savedBaseline.position,
              location: savedBaseline.location,
              fragment: source.view.passageFragments[index],
            },
            `${source.filename} saved passage row ${index} still shows the pre-restart quote and location`,
          );
          // The saved link is resolved against its rendering page and followed
          // to its own destination, which must be this application's and must
          // show the same pre-restart quote: the displayed row and its
          // destination both carry the saved quote, so a quote changed on
          // either side fails here.
          const followed = await resolvePassageLink(
            restarted,
            source.passages,
            savedPassage,
            savedBaseline.text,
          );
          assert.deepEqual(
            { path: followed.path, fragment: followed.fragment },
            {
              path: splitLink(restarted, source.passages, savedBaseline.link).path,
              fragment: source.view.passageLinks[index].fragment,
            },
            `${source.filename} saved passage link ${index} still reaches the same destination and fragment`,
          );
        }
      }
    } finally {
      await app?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Small helpers for the rendered forms
// ---------------------------------------------------------------------------

/**
 * Submit a rendered creation form and follow its 303 redirect, returning the
 * new record's id from the redirect target.
 */
async function createRecord(
  base: string,
  path: string,
  form: ReturnType<typeof parseForm>,
  values: Readonly<Record<string, string>>,
): Promise<string> {
  const reply = await submit(base, path, form, values);
  assert.equal(reply.status, 303, `${form.action} created the record: ${reply.body.slice(0, 200)}`);
  const location = String(reply.headers.location);
  return location.split("/").pop() as string;
}

/** Read a creation form at `path`, submit it and return the new record's id. */
async function createChild(
  base: string,
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<string> {
  const page = await get(base, path);
  assert.equal(page.status, 200, `${path} is rendered`);
  return createRecord(base, path, parseForm(page.body), values);
}

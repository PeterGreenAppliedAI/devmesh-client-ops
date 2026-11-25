/**
 * The operator's transcript library, exercised over ordinary loopback HTTP.
 *
 * The test starts the real application (`startApplication`) on port 0 over a
 * temporary workspace and follows only the pages and links the application
 * renders: the import actions in the engagement, project and meeting histories,
 * the multipart forms they lead to, the successful 200 result page's meeting
 * link, the history entries selected by the date and title they show, the
 * meeting page's source rows and each source's three views (original, extracted
 * text, passages). It then saves the meeting and source paths, the passage
 * fragments and the text it saw, closes the application,
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
  fragmentOf,
  get,
  parseForm,
  postBytes,
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
  const reply = await submit(base, form, values);
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
 * elsewhere, fails. Returns "" when the history renders no card of that label.
 */
function historyCardFor(historySection: string, label: string, meetingPath: string): string {
  const cards = historyCards(historySection).filter((card) => card.label === label);
  assert.ok(cards.length <= 1, `the history renders at most one card labelled ${label}`);
  if (cards.length === 0) return "";
  assert.equal(cards[0].href, meetingPath, `the card labelled ${label} links ${meetingPath}`);
  return `card:${label}`;
}

/** The meeting paths a history section lists, through each card's own link. */
function historyMeetingIds(historySection: string): string[] {
  return historyCards(historySection).map((card) => card.href);
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
}

/**
 * Read one source row's three views over HTTP and require each to be a 200.
 * `expectedPassages` is the number of passage rows the fixture must yield; a
 * readable page rendering no (or a different number of) passage rows fails,
 * so an empty baseline can never compare equal after a restart.
 */
async function readSource(
  base: string,
  row: ReturnType<typeof sourceRows>[number],
  expectedPassages: number,
): Promise<SourceView> {
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
  for (const passage of rendered) {
    const resolved = await resolvePassageLink(base, row.passages, passage);
    assert.equal(resolved.path, splitLink("", row.passages).path, `${row.filename} passage link stays on its passages page`);
    assert.equal(decodeURIComponent(resolved.fragment), passage.anchor, `${row.filename} passage fragment targets its own anchor`);
    passageLinks.push(resolved);
  }
  return { originalBytes: original.bytes, text: text.body, passages: rendered, passageLinks };
}

/** The source rows a meeting page lists, read from its own markup. */
async function meetingSources(base: string, meetingPath: string): Promise<ReturnType<typeof sourceRows>> {
  const page = await get(base, meetingPath);
  assert.equal(page.status, 200, `${meetingPath} is readable`);
  return sourceRows(page.body);
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
      const clientId = await createRecord(base, parseForm(newClient.body), {
        name: "Synthetic Client",
        background: "",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      });
      const anotherClientPage = await get(base, "/clients/new");
      assert.equal(anotherClientPage.status, 200);
      const anotherClientId = await createRecord(base, parseForm(anotherClientPage.body), {
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

      const firstRows = await meetingSources(base, pasteMeeting);
      assert.deepEqual(firstRows.map((row) => row.filename), ["Pasted text", "notes.txt"], "the distinct original added a readable source");
      assert.deepEqual(firstRows.map((row) => row.format), ["paste", "txt"]);
      // The distinct original's readable source is the exact TXT bytes and
      // their text and passages, checked before it becomes a restart baseline.
      const txtRow = firstRows.find((row) => row.filename === "notes.txt");
      assert.ok(txtRow !== undefined, "the distinct original's TXT row is listed");
      const txtView = await readSource(base, txtRow!, 2);
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
      const manualView = await readSource(base, manualRows[0], 2);
      assert.equal(manualView.text, ATTACHED, "the attached source's text is the attached transcript");

      // An attachment is never replaced: a different content aimed at it is
      // refused, and the refusal keeps the attach form's own guidance.
      const refusedAttach = await submit(base, parseForm((await get(base, attachAction)).body), {
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
      assert.equal((await readSource(base, manualRows[0], 2)).text, ATTACHED, "the saved source link still reads the attachment");

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
      const meetingsBeforeRefusals = historyMeetingIds(sectionOf((await get(base, alphaHref)).body, "Meeting history"));
      const meetingCountBefore = meetingsBeforeRefusals.length;
      const rowsBefore = await meetingSources(base, pasteMeeting);
      const meetingRowsBefore = new Map<string, ReturnType<typeof sourceRows>>();
      for (const meeting of meetingsBeforeRefusals) {
        meetingRowsBefore.set(meeting, await meetingSources(base, meeting));
      }
      const pastedViewBefore = await readSource(base, rowsBefore[0], 2);
      for (const refusal of refusals) {
        const form = parseForm((await get(base, pasteAction)).body);
        assert.equal(form.enctype, "multipart/form-data", "the corrected form stays a multipart form");
        const reply = await submit(base, form, {
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
        // A refusal adds no meeting to the engagement history, and adds no
        // source to the canonical meeting it was aimed past.
        const refusedHistory = historyMeetingIds(sectionOf((await get(base, alphaHref)).body, "Meeting history"));
        assert.equal(refusedHistory.length, meetingCountBefore, `${refusal.name} left the engagement's meetings as they were`);
        assert.deepEqual(
          [...refusedHistory].sort(),
          [...meetingsBeforeRefusals].sort(),
          `${refusal.name} kept the meetings the engagement already had`,
        );
        for (const [meeting, savedRows] of meetingRowsBefore) {
          assert.deepEqual(await meetingSources(base, meeting), savedRows, `${refusal.name} added no source to ${meeting}`);
        }
        assert.deepEqual((await readSource(base, rowsBefore[0], 2)).originalBytes, pastedViewBefore.originalBytes, `${refusal.name} kept the prior original bytes`);
        // The saved source links captured before the refusals still read back.
        const savedPaste = await get(base, rowsBefore[0].text);
        assert.equal(savedPaste.status, 200, `${refusal.name} kept the saved text link readable`);
        assert.equal(savedPaste.body, pastedViewBefore.text, `${refusal.name} kept the saved text link serving the same text`);
      }
      // The prior source links still work after the refusals, read from the
      // saved URLs captured before them.
      const afterRefusalsRows = await meetingSources(base, pasteMeeting);
      assert.deepEqual(afterRefusalsRows, rowsBefore, "the earlier sources are unchanged by refusals");
      const savedAfterRows = await readSource(base, rowsBefore[0], 2);
      const savedAfterTxt = await readSource(base, rowsBefore[1], 2);
      assert.equal((await get(base, rowsBefore[0].text)).body, savedAfterRows.text, "the pasted source's saved text link still serves its text");
      assert.equal((await get(base, rowsBefore[1].text)).body, savedAfterTxt.text, "the distinct original's saved text link still serves its text");
      for (const row of rowsBefore) {
        assert.equal((await get(base, row.original)).status, 200, "a saved original link still reads");
      }

      // -- The client history across engagements. ----------------------------
      const clientPath = `/clients/${encodeURIComponent(clientId)}`;
      const clientPage = await get(base, clientPath);
      assert.equal(clientPage.status, 200, "the client page is rendered");
      const clientHistory = sectionOf(clientPage.body, "Meeting history");
      assert.notEqual(clientHistory, "", "the client page renders its meeting history section");
      assert.equal(historyImportLink(clientHistory), "", "the client history offers no single import action");
      assert.deepEqual(
        historyCards(clientHistory).map((card) => card.label).sort(),
        [
          pasteLabel,
          markdownLabel,
          betaLabel,
          manualLabel,
          docxLabel,
          pdfLabel,
          siblingLabel,
          betaManualLabel,
        ].sort(),
        "the client history shows its client's every meeting across engagements, and no other client's",
      );

      // The other client's engagement and client are readable pages with a
      // rendered history section that lists none of these meetings.
      const foreignPage = await get(base, `/engagements/${encodeURIComponent(foreignEngagementId)}`);
      assert.equal(foreignPage.status, 200, "the other client's engagement is readable");
      const foreignEngagementSection = sectionOf(foreignPage.body, "Meeting history");
      assert.notEqual(foreignEngagementSection, "", "the other client's engagement renders its history section");
      assert.deepEqual(historyMeetingIds(foreignEngagementSection), [], "the other client's engagement holds no meeting");
      const foreignClientPage = await get(base, `/clients/${encodeURIComponent(anotherClientId)}`);
      assert.equal(foreignClientPage.status, 200, "the other client's page is readable");
      const foreignClientSection = sectionOf(foreignClientPage.body, "Meeting history");
      assert.notEqual(foreignClientSection, "", "the other client's page renders its history section");
      assert.deepEqual(historyMeetingIds(foreignClientSection), [], "the other client's history is empty");

      // -- The engagement history, including project meetings once. ----------
      const alphaHistoryNow = sectionOf((await get(base, alphaHref)).body, "Meeting history");
      assert.notEqual(alphaHistoryNow, "", "the engagement page renders its history section");
      const engagementHistory = historyMeetingIds(alphaHistoryNow);
      assert.equal(engagementHistory.length, new Set(engagementHistory).size, "a project meeting appears once");
      const engagementLabels = historyCards(alphaHistoryNow).map((card) => card.label);
      assert.deepEqual(
        [...engagementLabels].sort(),
        [pasteLabel, markdownLabel, manualLabel, docxLabel, pdfLabel, siblingLabel].sort(),
        "the engagement history holds its own meetings, project meetings included, once",
      );
      assert.ok(!engagementLabels.includes(betaLabel), "the alpha engagement does not list the beta meeting");
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
        assert.notEqual(historyCardFor(alphaHistoryNow, label, meeting), "", `the engagement history lists ${label}`);
        const page = await get(base, meeting);
        assert.equal(page.status, 200, `${label}'s card destination is readable`);
        assert.ok(page.body.includes('<main id="main">'), `${label}'s card destination is a meeting page`);
        await meetingSources(base, meeting);
      }

      // -- The project history, only its assigned meetings. ------------------
      const projectHistoryPage = await get(base, projectHref);
      assert.equal(projectHistoryPage.status, 200, "the project page is readable");
      const projectHistorySection = sectionOf(projectHistoryPage.body, "Meeting history");
      assert.notEqual(projectHistorySection, "", "the project page renders its history section");
      assert.deepEqual(
        historyCards(projectHistorySection).map((card) => card.label),
        [docxLabel, pdfLabel],
        "the project history holds its assigned meetings by date",
      );
      assert.equal(historyCardFor(projectHistorySection, pasteLabel, pasteMeeting), "", "an engagement-only meeting's card is not in the project history");
      const projectHistoryIds = historyMeetingIds(projectHistorySection);
      assert.ok(!projectHistoryIds.includes(pasteMeeting), "an engagement-only meeting is not in the project history");
      assert.ok(!projectHistoryIds.includes(siblingMeetingPath), "a sibling project's meeting is not in the project history");
      const siblingHistorySection = sectionOf(
        (await get(base, `/projects/${encodeURIComponent(siblingProjectId)}`)).body,
        "Meeting history",
      );
      assert.notEqual(siblingHistorySection, "", "the sibling project renders its history section");
      assert.deepEqual(
        historyCards(siblingHistorySection).map((card) => card.label),
        [siblingLabel],
        "the sibling project lists only its own meeting",
      );
      assert.equal(historyCardFor(siblingHistorySection, siblingLabel, siblingMeetingPath), "card:" + siblingLabel);

      // -- The DOCX and PDF sources, read over HTTP. -------------------------
      const docxSources = await meetingSources(base, docxMeeting);
      assert.equal(docxSources.length, 1);
      assert.equal(docxSources[0].filename, "blocks.docx");
      const docxView = await readSource(base, docxSources[0], 3);
      assert.deepEqual(new Uint8Array(docxView.originalBytes), docxBytes(DOCX_PARAGRAPHS), "the DOCX bytes are preserved exactly");
      assert.equal(docxView.text, DOCX_PARAGRAPHS.join("\n\n"), "the DOCX text is the extracted blocks");
      assert.deepEqual(docxView.passages.map((p) => p.text), DOCX_PARAGRAPHS.join("\n\n").split("\n\n"));
      assert.ok(docxView.passages.every((p) => p.location === "Extracted block"), "a DOCX passage names its block");

      const pdfSources = await meetingSources(base, pdfMeeting);
      assert.equal(pdfSources.length, 1);
      assert.equal(pdfSources[0].filename, "report.pdf");
      const pdfView = await readSource(base, pdfSources[0], 2);
      assert.deepEqual(new Uint8Array(pdfView.originalBytes), pdfBytes(PDF_PAGES), "the PDF bytes are preserved exactly");
      assert.equal(pdfView.text, "Alice: The budget is fixed.\n\nBob: We can work within it.", "the blank page contributes no text");
      assert.deepEqual(pdfView.passages.map((p) => p.location), ["PDF page 1", "PDF page 3"], "the blank page is skipped, not renumbered");

      // The pasted source keeps its exact text and quoted passage.
      const pasteRows = await meetingSources(base, pasteMeeting);
      const pastedView = await readSource(base, pasteRows[0], 2);
      assert.equal(pastedView.text, PASTED, "a pasted original's text is exact");
      assert.equal(pastedView.passages[0].text, 'Alice: "The budget is fixed," she said.', "the quoted passage is exact");
      // The Markdown source keeps its case in the text it serves.
      const markdownRows = await meetingSources(base, markdownMeeting);
      const markdownView = await readSource(base, markdownRows[0], 2);
      assert.equal(markdownView.text, MARKDOWN, "the Markdown text is exact");

      // The beta meeting's own source is read and kept as a baseline.
      const betaRows = await meetingSources(base, betaMeeting);
      assert.equal(betaRows.length, 1, "the beta meeting holds its own source");
      const betaView = await readSource(base, betaRows[0], 2);
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
        sources: [] as SavedSource[],
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
        const projectMeeting = meeting === docxMeeting || meeting === pdfMeeting;
        for (const row of rows) {
          const entry: SavedSource = {
            meetingLabel,
            meeting,
            filename: row.filename,
            format: row.format,
            original: row.original,
            text: row.text,
            passages: row.passages,
            view: await readSource(base, row, expectedPassages),
          };
          saved.sourcesAll.push(entry);
          if (!projectMeeting) saved.sources.push(entry);
        }
      }
      // The saved baselines name a row count and every meeting's sources, the
      // beta meeting's included.
      assert.deepEqual(
        saved.sources.map((source) => source.meetingLabel).sort(),
        [
          pasteLabel,
          pasteLabel,
          manualLabel,
          markdownLabel,
          betaLabel,
        ].sort(),
        "the restart baselines cover each active meeting with its sources",
      );
      // Each saved label is the label of a card rendered for that meeting.

      // -- Archive the project: its meetings leave the active histories. -----
      // The project page's own archive form is followed as the browser would,
      // through the shared submission path (a POST to the rendered action).
      const projectArchivePage = await get(base, projectHref);
      assert.equal(projectArchivePage.status, 200, "the project page is readable");
      const archiveForm = parseForm(projectArchivePage.body);
      assert.equal(archiveForm.action, `${projectHref}/archive`, "the project page offers its archive action");
      assert.equal(archiveForm.enctype, null, "the archive form is a url-encoded form");
      const archived = await submit(base, archiveForm);
      assert.equal(archived.status, 303, "archiving redirects to the project");
      assert.equal(String(archived.headers.location), projectHref);

      // Neither project meeting is in the engagement or client histories, and
      // none of the project's sources were added or removed by archiving. The
      // histories are read as a 200 page carrying its rendered section.
      const archivedEngagementPage = await get(base, alphaHref);
      assert.equal(archivedEngagementPage.status, 200, "the engagement page is readable after archiving");
      const archivedEngagementSection = sectionOf(archivedEngagementPage.body, "Meeting history");
      assert.notEqual(archivedEngagementSection, "", "the engagement page renders its history section after archiving");
      const archivedEngagementLabels = historyCards(archivedEngagementSection).map((card) => card.label);
      assert.ok(!archivedEngagementLabels.includes(docxLabel), "the archived project's DOCX meeting left the engagement history");
      assert.ok(!archivedEngagementLabels.includes(pdfLabel), "the archived project's PDF meeting left the engagement history");
      assert.deepEqual(
        [...archivedEngagementLabels].sort(),
        [pasteLabel, markdownLabel, manualLabel, siblingLabel].sort(),
        "the engagement history keeps only its active meetings",
      );
      const archivedClientPage = await get(base, clientPath);
      assert.equal(archivedClientPage.status, 200, "the client page is readable after archiving");
      const archivedClientSection = sectionOf(archivedClientPage.body, "Meeting history");
      assert.notEqual(archivedClientSection, "", "the client page renders its history section after archiving");
      const archivedClientLabels = historyCards(archivedClientSection).map((card) => card.label);
      assert.ok(!archivedClientLabels.includes(docxLabel));
      assert.ok(!archivedClientLabels.includes(pdfLabel));
      assert.deepEqual(
        [...archivedClientLabels].sort(),
        [pasteLabel, markdownLabel, manualLabel, betaLabel, siblingLabel, betaManualLabel].sort(),
        "the client history keeps only its active meetings",
      );
      // The project's own history is empty while it is archived, and the
      // project page stays readable with its archive notice and history.
      const archivedProjectPage = await get(base, projectHref);
      assert.equal(archivedProjectPage.status, 200, "the archived project page is readable");
      assert.match(archivedProjectPage.body, /This record is archived/);
      const archivedProjectSection = sectionOf(archivedProjectPage.body, "Meeting history");
      assert.notEqual(archivedProjectSection, "", "the archived project page renders its meeting history section");
      assert.deepEqual(historyMeetingIds(archivedProjectSection), [], "the archived project lists no active meeting");

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
        const view = await readSource(base, savedRow(source), source.view.passages.length || 1);
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
      assert.deepEqual(
        [...historyCards(restartedAlphaHistorySection).map((card) => card.label)].sort(),
        [pasteLabel, markdownLabel, manualLabel, siblingLabel].sort(),
        "the restarted engagement history is the same active history",
      );
      const restartedClientPage = await get(restarted, clientPath);
      assert.equal(restartedClientPage.status, 200);
      const restartedClientHistorySection = sectionOf(restartedClientPage.body, "Meeting history");
      assert.notEqual(restartedClientHistorySection, "", "the restarted client page renders its history section");
      assert.deepEqual(
        [...historyCards(restartedClientHistorySection).map((card) => card.label)].sort(),
        [pasteLabel, markdownLabel, manualLabel, betaLabel, siblingLabel, betaManualLabel].sort(),
        "the restarted client history is the same active history",
      );
      // The archived project's history is empty after the restart, and the
      // project page is read as a successful 200 carrying its section.
      const restartedProjectPage = await get(restarted, projectHref);
      assert.equal(restartedProjectPage.status, 200, "the archived project page is readable after the restart");
      assert.match(restartedProjectPage.body, /This record is archived/);
      const restartedProjectSection = sectionOf(restartedProjectPage.body, "Meeting history");
      assert.notEqual(restartedProjectSection, "", "the archived project still renders its history section");
      assert.deepEqual(historyMeetingIds(restartedProjectSection), [], "the archived project still lists no active meeting after the restart");
      // The archived meetings are still directly readable after the restart.
      for (const meeting of [docxMeeting, pdfMeeting]) {
        assert.equal((await get(restarted, meeting)).status, 200, `${meeting} is readable after the restart`);
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
        assert.notEqual(historyCardFor(section, label, meeting), "", `${label}'s history card is rendered after the restart`);
        const page = await get(restarted, meeting);
        assert.equal(page.status, 200, `${label}'s card destination is readable after the restart`);
        assert.ok(page.body.includes('<main id="main">'), `${label}'s card destination is a page after the restart`);
        await meetingSources(restarted, meeting);
      }

      // Each saved source is rediscovered on its meeting page (found through
      // the card carrying the meeting's label) and read over the new origin:
      // original bytes, full text, quotes, locations and fragment targets
      // (each resolved at its own destination page).
      for (const source of saved.sources) {
        const historySection = historyMeetingIds(restartedAlphaHistorySection).includes(source.meeting)
          ? restartedAlphaHistorySection
          : restartedClientHistorySection;
        const card = historyCardFor(historySection, source.meetingLabel, source.meeting);
        assert.notEqual(card, "", `${source.meetingLabel} is rediscovered in the history after the restart`);
        const rows = await meetingSources(restarted, source.meeting);
        const row = rows.find((candidate) => candidate.filename === source.filename);
        assert.ok(row !== undefined, `${source.filename} is rediscovered on ${source.meeting}`);
        assert.equal(row!.original, source.original, "the rediscovered original path is unchanged");
        assert.equal(row!.text, source.text, "the rediscovered text path is unchanged");
        assert.equal(row!.passages, source.passages, "the rediscovered passages path is unchanged");
        const view = await readSource(restarted, row!, source.view.passages.length);
        assert.deepEqual(view.originalBytes, source.view.originalBytes, `${source.filename} original bytes match across the restart`);
        assert.equal(view.text, source.view.text, `${source.filename} full text matches across the restart`);
        assert.deepEqual(
          view.passages.map((passage) => ({
            anchor: passage.anchor,
            text: passage.text,
            offsets: passage.offsets,
            position: passage.position,
            location: passage.location,
            fragment: fragmentOf(passage.link),
          })),
          source.view.passages.map((passage) => ({
            anchor: passage.anchor,
            text: passage.text,
            offsets: passage.offsets,
            position: passage.position,
            location: passage.location,
            fragment: fragmentOf(passage.link),
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
          const { path, fragment } = splitLink(source.passages, savedPassage.link);
          assert.notEqual(fragment, "", "a saved passage link carries a fragment");
          const anchor = decodeURIComponent(fragment);
          const destination = await get(restarted, path);
          assert.equal(destination.status, 200, `the saved passage destination ${path} is readable after the restart`);
          const targets = renderedPassages(destination.body).filter((candidate) => candidate.anchor === anchor);
          assert.equal(targets.length, 1, `the saved fragment ${anchor} targets one row at its destination`);
          assert.equal(targets[0].text, source.view.passages[index].text, `the saved fragment ${anchor} still shows its quote`);
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
  form: ReturnType<typeof parseForm>,
  values: Readonly<Record<string, string>>,
): Promise<string> {
  const reply = await submit(base, form, values);
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
  return createRecord(base, parseForm(page.body), values);
}

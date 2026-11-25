/**
 * The operator's transcript library, exercised over ordinary loopback HTTP.
 *
 * The test starts the real application (`startApplication`) on port 0 over a
 * temporary workspace and follows only the pages and links the application
 * renders: the import actions in the engagement, project and meeting histories,
 * the multipart forms they lead to, the successful 200 result page's meeting
 * link, the meeting page's source rows and each source's three views
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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { startApplication, type Application } from "../src/index.ts";
import { OCR_UNAVAILABLE_GUIDANCE, RE_EXPORT_GUIDANCE } from "../src/transcript-pdf.ts";
import {
  fragmentOf,
  get,
  parseForm,
  postBytes,
  renderedPassages,
  sectionOf,
  sourceRows,
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

/** The pasted original: two paragraphs, one quoted. */
const PASTED = 'Alice: "The budget is fixed," she said.\n\nBob: We can work within it.';
/** A .txt original: the pasted words with different whitespace, its own file. */
const TEXT_FILE = ' Alice:  "The budget is fixed," she said.\r\n\r\nBob: We can work within it.\n';
/** A .md original whose canonical text differs by case. */
const MARKDOWN = 'Alice: "The budget is fixed," she said.\n\nbob: we can work within it.';
/** An original imported in a second engagement, with the same canonical text. */
const OTHER_ENGAGEMENT_TEXT = 'Alice: "The budget is fixed," she said.\n\nBob: We can work within it.';
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

/**
 * The ids of the meetings a scope's meeting history lists, in rendered order,
 * read from the history's own cards. A meeting appears once per card, so a
 * duplicate link shows up as a duplicate id.
 */
function historyMeetingIds(historySection: string): string[] {
  return [...historySection.matchAll(/<li class="card"><a href="(\/meetings\/[^"]+)">/g)].map((match) => unescapeHtml(match[1]));
}

/** The single import link a history section offers, or "" when it offers none. */
function historyImportLink(historySection: string): string {
  const links = [...historySection.matchAll(/<a href="([^"]+)">Import transcript<\/a>/g)].map((match) => unescapeHtml(match[1]));
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

/**
 * One source's three views read over HTTP, plus what they show: the original
 * bytes, the extracted text and the rendered passages.
 */
interface SourceView {
  readonly originalBytes: Buffer;
  readonly text: string;
  readonly passages: ReturnType<typeof renderedPassages>;
}

/** Read one source row's three views over HTTP and require each to be a 200. */
async function readSource(base: string, row: ReturnType<typeof sourceRows>[number]): Promise<SourceView> {
  const original = await get(base, row.original);
  assert.equal(original.status, 200, `${row.filename} original is served`);
  const text = await get(base, row.text);
  assert.equal(text.status, 200, `${row.filename} text is served`);
  assert.match(String(text.headers["content-type"]), /^text\/plain/, "the extracted text is plain text");
  const passages = await get(base, row.passages);
  assert.equal(passages.status, 200, `${row.filename} passages are served`);
  assert.match(String(passages.headers["content-type"]), /^text\/html; charset=utf-8/, "the passages are a page");
  const rendered = renderedPassages(passages.body);
  // Every passage row's fragment link names that same row's anchor, so a
  // changed anchor or a misdirected fragment fails.
  for (const passage of rendered) {
    assert.equal(fragmentOf(passage.link), passage.anchor, `${row.filename} passage fragment targets its own anchor`);
  }
  return { originalBytes: original.bytes, text: text.body, passages: rendered };
}

/** The source rows a meeting page lists, read from its own markup. */
async function meetingSources(base: string, meetingPath: string): Promise<ReturnType<typeof sourceRows>> {
  const page = await get(base, meetingPath);
  assert.equal(page.status, 200, `${meetingPath} is readable`);
  return sourceRows(page.body);
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
      let base = app.url;

      // -- Clients and two engagements through their rendered forms. ---------
      const clientsPage = await get(base, "/clients");
      assert.equal(clientsPage.status, 200);
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
      // imports create their meetings in it.
      const projectId = await createChild(
        base,
        `/engagements/${encodeURIComponent(alphaEngagementId)}/projects/new`,
        { name: "Alpha project", objectives: "Imported meetings", status: "active" },
      );
      const projectHref = `/projects/${encodeURIComponent(projectId)}`;

      // A manual meeting in the alpha engagement, created through its form.
      const manualMeetingId = await createChild(
        base,
        `/engagements/${encodeURIComponent(alphaEngagementId)}/meetings/new`,
        { title: "Manual kickoff", date: "2026-01-05", notes: MANUAL_NOTES, projectId: "" },
      );
      const manualMeetingPath = `/meetings/${encodeURIComponent(manualMeetingId)}`;

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

      // -- Import 2: a whitespace-equivalent distinct original, same meeting.
      const distinctResult = await importThrough(base, pasteAction, pasteAction, {
        title: "Paste meeting",
        date: "2026-01-10",
        notes: "Imported notes",
        paste: "",
        file: { filename: "notes.txt", body: encoder.encode(TEXT_FILE) },
      });
      assert.equal(resultMeetingLink(distinctResult), pasteMeeting, "a whitespace-equivalent original reuses the meeting");
      const explanation = resultExplanation(distinctResult) ?? "";
      assert.match(explanation, /distinct original was retained/i, "the result explains the distinct original");
      assert.deepEqual(resultConflicts(distinctResult), [], "the supplied metadata matches the preserved meeting");

      const firstRows = await meetingSources(base, pasteMeeting);
      assert.deepEqual(firstRows.map((row) => row.filename), ["Pasted text", "notes.txt"], "the distinct original added a readable source");
      assert.deepEqual(firstRows.map((row) => row.format), ["paste", "txt"]);

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

      // An attachment is never replaced: a different content aimed at it is
      // refused, and the refusal keeps the attach form's own guidance.
      const refusedAttach = await submit(base, parseForm((await get(base, attachAction)).body), {
        paste: "Carol: A different transcript.",
        file: { filename: "", body: "" },
      });
      assert.equal(refusedAttach.status, 400, "a second, different attachment is refused");
      assert.match(refusedAttach.body, /already holds a transcript of different content/);
      assert.match(refusedAttach.body, /Supported formats:/, "the refused form still states the formats");

      // -- Import 7: the DOCX and 8: the PDF, through the project's action. --
      const projectPage = await get(base, projectHref);
      const projectHistory = sectionOf(projectPage.body, "Meeting history");
      const docxAction = historyImportLink(projectHistory);
      assert.match(docxAction, /^\/projects\/[^/]+\/transcripts\/import$/, "the project history links the project import");
      const docxForm = parseForm((await get(base, docxAction)).body);
      assert.equal(docxForm.controls.get("projectId"), projectId, "the project import preselects the URL project");
      const docxResult = await importThrough(base, docxAction, docxAction, {
        title: "DOCX meeting",
        date: "2026-01-13",
        notes: "",
        paste: "",
        file: { filename: "blocks.docx", body: docxBytes(DOCX_PARAGRAPHS) },
      });
      const docxMeeting = resultMeetingLink(docxResult);
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
      assert.equal(resultPageProject(pdfResult), projectHref, "the PDF meeting is in the project");

      // -- Preserved metadata: a repeat with different metadata. -------------
      // The engagement holds the pasted canonical content; supplying a
      // different title, date and project is reported and never written.
      const conflictResult = await importThrough(base, pasteAction, pasteAction, {
        title: "A different title",
        date: "2026-02-01",
        notes: "A different note",
        paste: PASTED,
        file: { filename: "", body: "" },
      });
      assert.equal(resultMeetingLink(conflictResult), pasteMeeting, "the canonical meeting is reused");
      assert.match(resultExplanation(conflictResult) ?? "", /exact original is already stored/i);
      assert.deepEqual(
        resultConflicts(conflictResult).sort(),
        [
          "date: submitted 2026-02-01, kept 2026-01-10",
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
      const refusals: { readonly name: string; readonly filename: string; readonly body: Uint8Array; readonly guidance: RegExp }[] = [
        { name: "invalid UTF-8", filename: "broken.txt", body: INVALID_UTF8, guidance: /not valid UTF-8/ },
        { name: "corrupt DOCX", filename: "broken.docx", body: encoder.encode("This is not a DOCX archive."), guidance: /DOCX|document/i },
        { name: "corrupt PDF", filename: "broken.pdf", body: corruptBytes(), guidance: new RegExp(escapeRegExp(RE_EXPORT_GUIDANCE)) },
        { name: "image-only PDF", filename: "scan.pdf", body: pdfBytes(["image-only"]), guidance: new RegExp(escapeRegExp(OCR_UNAVAILABLE_GUIDANCE)) },
      ];
      for (const refusal of refusals) {
        // The refused form shows the guidance and the recovery sentence; a
        // refused submission is answered with 400 and the multipart form again.
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
        assert.match(reply.body, refusal.guidance, `${refusal.name} carries its recovery guidance`);
        assert.match(reply.body, /Supported formats:/, `${refusal.name} keeps the import guidance`);
        // A refusal adds no meeting to the engagement history.
        const refusedHistory = historyMeetingIds(sectionOf((await get(base, alphaHref)).body, "Meeting history"));
        assert.ok(!refusedHistory.some((path) => path.length === 0), "a refused import adds no meeting");
        assert.equal(refusedHistory.length, 5, `${refusal.name} left the engagement's five meetings as they were`);
      }
      // The prior source links still work after the refusals.
      const afterRefusalsRows = await meetingSources(base, pasteMeeting);
      assert.equal(afterRefusalsRows.length, 2, "the earlier sources are unchanged by refusals");
      await readSource(base, afterRefusalsRows[0]);

      // -- The client history across engagements. ----------------------------
      const clientPath = `/clients/${encodeURIComponent(clientId)}`;
      const clientPage = await get(base, clientPath);
      const clientHistory = sectionOf(clientPage.body, "Meeting history");
      assert.equal(historyImportLink(clientHistory), "", "the client history offers no single import action");
      assert.deepEqual(
        [...historyMeetingIds(clientHistory)].sort(),
        [pasteMeeting, markdownMeeting, betaMeeting, manualMeetingPath, docxMeeting, pdfMeeting].sort(),
        "the client history holds every meeting of both engagements",
      );
      // The other client's engagement holds none of these meetings.
      const foreignPage = await get(base, `/engagements/${encodeURIComponent(foreignEngagementId)}`);
      assert.deepEqual(historyMeetingIds(sectionOf(foreignPage.body, "Meeting history")), []);

      // -- The engagement history, including project meetings once. ----------
      const engagementHistory = historyMeetingIds(sectionOf((await get(base, alphaHref)).body, "Meeting history"));
      assert.equal(engagementHistory.length, new Set(engagementHistory).size, "a project meeting appears once");
      assert.deepEqual(
        [...engagementHistory].sort(),
        [pasteMeeting, markdownMeeting, manualMeetingPath, docxMeeting, pdfMeeting].sort(),
        "the engagement history holds its own meetings, project meetings included, once",
      );

      // -- The project history, only its assigned meetings. ------------------
      const projectHistoryIds = historyMeetingIds(sectionOf((await get(base, projectHref)).body, "Meeting history"));
      assert.deepEqual(projectHistoryIds, [docxMeeting, pdfMeeting], "the project history holds its assigned meetings by date");
      assert.ok(!projectHistoryIds.includes(pasteMeeting), "an engagement-only meeting is not in the project history");

      // -- The DOCX and PDF sources, read over HTTP. -------------------------
      const docxSources = await meetingSources(base, docxMeeting);
      assert.equal(docxSources.length, 1);
      assert.equal(docxSources[0].filename, "blocks.docx");
      const docxView = await readSource(base, docxSources[0]);
      assert.deepEqual(new Uint8Array(docxView.originalBytes), docxBytes(DOCX_PARAGRAPHS), "the DOCX bytes are preserved exactly");
      assert.equal(docxView.text, DOCX_PARAGRAPHS.join("\n\n"), "the DOCX text is the extracted blocks");
      assert.deepEqual(docxView.passages.map((p) => p.text), DOCX_PARAGRAPHS.join("\n\n").split("\n\n"));
      assert.ok(docxView.passages.every((p) => p.location === "Extracted block"), "a DOCX passage names its block");

      const pdfSources = await meetingSources(base, pdfMeeting);
      assert.equal(pdfSources.length, 1);
      assert.equal(pdfSources[0].filename, "report.pdf");
      const pdfView = await readSource(base, pdfSources[0]);
      assert.deepEqual(new Uint8Array(pdfView.originalBytes), pdfBytes(PDF_PAGES), "the PDF bytes are preserved exactly");
      assert.equal(pdfView.text, "Alice: The budget is fixed.\n\nBob: We can work within it.", "the blank page contributes no text");
      assert.deepEqual(pdfView.passages.map((p) => p.location), ["PDF page 1", "PDF page 3"], "the blank page is skipped, not renumbered");

      // The pasted source keeps its exact text and quoted passage.
      const pasteRows = await meetingSources(base, pasteMeeting);
      const pastedView = await readSource(base, pasteRows[0]);
      assert.equal(pastedView.text, PASTED, "a pasted original's text is exact");
      assert.equal(pastedView.passages[0].text, 'Alice: "The budget is fixed," she said.', "the quoted passage is exact");
      // The Markdown source keeps its case in the text it serves.
      const markdownRows = await meetingSources(base, markdownMeeting);
      const markdownView = await readSource(base, markdownRows[0]);
      assert.equal(markdownView.text, MARKDOWN, "the Markdown text is exact");

      // -- Save what a restart must reproduce. -------------------------------
      const saved = {
        pasteMeeting,
        markdownMeeting,
        manualMeetingPath,
        docxMeeting,
        pdfMeeting,
        projectHref,
        alphaHref,
        clientPath,
        sources: [] as {
          readonly meeting: string;
          readonly filename: string;
          readonly original: string;
          readonly text: string;
          readonly passages: string;
          readonly view: SourceView;
        }[],
      };
      for (const [meeting, rows] of [
        [pasteMeeting, pasteRows],
        [manualMeetingPath, await meetingSources(base, manualMeetingPath)],
        [markdownMeeting, markdownRows],
        [docxMeeting, docxSources],
        [pdfMeeting, pdfSources],
      ] as const) {
        for (const row of rows) {
          saved.sources.push({
            meeting,
            filename: row.filename,
            original: row.original,
            text: row.text,
            passages: row.passages,
            view: await readSource(base, row),
          });
        }
      }

      // -- Archive the project: its meetings leave the active histories. -----
      const beforeArchiveRows = saved.sources.length;
      const projectArchivePage = await get(base, projectHref);
      const archiveForm = parseForm(projectArchivePage.body);
      assert.equal(archiveForm.action, `${projectHref}/archive`, "the project page offers its archive action");
      const archived = await postBytes(base, archiveForm.action, "application/x-www-form-urlencoded", Buffer.alloc(0));
      assert.equal(archived.status, 303, "archiving redirects to the project");
      assert.equal(String(archived.headers.location), projectHref);

      // Neither project meeting is in the engagement or client histories.
      const archivedEngagementHistory = historyMeetingIds(sectionOf((await get(base, alphaHref)).body, "Meeting history"));
      assert.ok(!archivedEngagementHistory.includes(docxMeeting), "the archived project's DOCX meeting left the engagement history");
      assert.ok(!archivedEngagementHistory.includes(pdfMeeting), "the archived project's PDF meeting left the engagement history");
      assert.deepEqual(
        [...archivedEngagementHistory].sort(),
        [pasteMeeting, markdownMeeting, manualMeetingPath].sort(),
        "the engagement history keeps only its active meetings",
      );
      const archivedClientHistory = historyMeetingIds(sectionOf((await get(base, clientPath)).body, "Meeting history"));
      assert.ok(!archivedClientHistory.includes(docxMeeting));
      assert.ok(!archivedClientHistory.includes(pdfMeeting));
      assert.deepEqual(
        [...archivedClientHistory].sort(),
        [pasteMeeting, markdownMeeting, manualMeetingPath, betaMeeting].sort(),
        "the client history keeps only its active meetings",
      );
      // The project's own history is empty while it is archived, and the
      // project page stays readable with its archive notice.
      const archivedProjectPage = await get(base, projectHref);
      assert.equal(archivedProjectPage.status, 200);
      assert.match(archivedProjectPage.body, /This record is archived/);
      assert.deepEqual(historyMeetingIds(sectionOf(archivedProjectPage.body, "Meeting history")), [], "the archived project lists no active meeting");

      // Direct meeting and source links still work for the archived meetings,
      // whose own pages keep their source rows with all three links.
      for (const meeting of [docxMeeting, pdfMeeting]) {
        const page = await get(base, meeting);
        assert.equal(page.status, 200, `${meeting} stays directly readable`);
        assert.match(page.body, /archived/, "the archived meeting page says it is archived");
        const rows = sourceRows(page.body);
        assert.equal(rows.length, 1, `${meeting} still lists its source`);
        assert.equal(rows[0].filename, meeting === docxMeeting ? "blocks.docx" : "report.pdf");
      }
      for (const source of saved.sources.filter((candidate) => candidate.meeting === docxMeeting || candidate.meeting === pdfMeeting)) {
        const view = await readSource(base, {
          filename: source.filename,
          format: "",
          original: source.original,
          text: source.text,
          passages: source.passages,
        });
        assert.deepEqual(view.originalBytes, source.view.originalBytes, `${source.filename} original bytes still match after archiving`);
        assert.equal(view.text, source.view.text, `${source.filename} text still matches after archiving`);
      }
      assert.equal(saved.sources.length, beforeArchiveRows, "archiving added no source");

      // -- Restart over the same directory, on a new origin. -----------------
      await app.close();
      app = await startApplication({ dataDirectory: dir, port: 0 });
      const restarted = app.url;
      assert.notEqual(restarted, base, "the restarted application listens on its own origin");

      // The saved paths are resolved against the new origin, and the same
      // pages are rediscovered from the histories, not from the saved paths.
      const restartedAlpha = await get(restarted, alphaHref);
      const restartedAlphaHistory = historyMeetingIds(sectionOf(restartedAlpha.body, "Meeting history"));
      assert.deepEqual(
        [...restartedAlphaHistory].sort(),
        [pasteMeeting, markdownMeeting, manualMeetingPath].sort(),
        "the restarted engagement history is the same active history",
      );
      assert.deepEqual(
        [...historyMeetingIds(sectionOf((await get(restarted, clientPath)).body, "Meeting history"))].sort(),
        [pasteMeeting, markdownMeeting, manualMeetingPath, betaMeeting].sort(),
        "the restarted client history is the same active history",
      );
      assert.deepEqual(
        historyMeetingIds(sectionOf((await get(restarted, projectHref)).body, "Meeting history")),
        [],
        "the archived project still lists no active meeting after the restart",
      );
      // The archived meetings are still directly readable after the restart.
      for (const meeting of [docxMeeting, pdfMeeting]) {
        assert.equal((await get(restarted, meeting)).status, 200, `${meeting} is readable after the restart`);
      }

      // Each saved source is rediscovered on its meeting page and read over the
      // new origin: original bytes, full text, quotes, locations and fragments.
      for (const source of saved.sources) {
        const rows = await meetingSources(restarted, source.meeting);
        const row = rows.find((candidate) => candidate.filename === source.filename);
        assert.ok(row !== undefined, `${source.filename} is rediscovered on ${source.meeting}`);
        assert.equal(row!.original, source.original, "the rediscovered original path is unchanged");
        assert.equal(row!.text, source.text, "the rediscovered text path is unchanged");
        assert.equal(row!.passages, source.passages, "the rediscovered passages path is unchanged");
        const view = await readSource(restarted, row!);
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
        // Each saved fragment link resolves to the saved anchor on the new
        // origin: the fragment target the passage renders still exists there.
        const fragments = await get(restarted, source.passages);
        for (const passage of source.view.passages) {
          assert.ok(fragments.body.includes(`id="${escapeHtml(passage.anchor)}"`), `the saved fragment ${passage.anchor} targets a row`);
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

/** Escape text for a regular expression, so a literal is matched literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The project a result page names, as a path, or "". */
function resultPageProject(resultPage: string): string {
  const match = /<p>Project: <a href="([^"]+)">/.exec(sectionOf(resultPage, "Result"));
  return match === null ? "" : unescapeHtml(match[1]);
}

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

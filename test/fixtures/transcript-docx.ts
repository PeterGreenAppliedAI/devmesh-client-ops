/**
 * Synthetic DOCX bytes for the DOCX adapter tests, built in test source so no
 * binary fixture files and no install-script-generated assets are needed. A
 * DOCX is a ZIP archive of XML parts; this builder writes an uncompressed ZIP
 * (stored entries) with a correct local header, central directory and end
 * record, using only Node built-ins, so the same bytes are produced on every
 * platform and Node version.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One entry of the archive: its path and its bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Build a stored (uncompressed) ZIP archive. Entry names are UTF-8 and flagged
 * as such, so the archive reads the same on every platform.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.bytes;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, 20, true);
    headerView.setUint16(8, 0x0800, true);
    headerView.setUint16(10, 0, true);
    headerView.setUint16(12, 0, true);
    headerView.setUint16(14, 0, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, data.length, true);
    headerView.setUint32(24, data.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true);
    headerView.setUint16(32, 0, true);
    headerView.setUint16(34, 0, true);
    headerView.setUint16(36, 0, true);
    headerView.setUint32(38, 0, true);
    headerView.setUint32(42, offset, true);
    header.set(name, 46);

    locals.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...central, end];
  const total = parts.reduce((size, part) => size + part.length, 0);
  const archive = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.length;
  }
  return archive;
}

const encoder = new TextEncoder();

/** One paragraph of test content: runs of text, joined in document order. */
export interface TestParagraph {
  /** Runs in order; a `\n` inside a run is an in-paragraph line break. */
  readonly runs?: readonly string[];
}

function paragraphXml(paragraph: TestParagraph): string {
  const runs = paragraph.runs ?? [];
  const runsXml = runs
    .map((run) => `<w:r><w:t xml:space="preserve">${escapeXml(run)}</w:t></w:r>`)
    .join("");
  return `<w:p>${runsXml}</w:p>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** A table cell: either paragraphs, or plain text written without a paragraph. */
export type TestCell = readonly TestParagraph[] | { readonly text: string };

/** A table of rows of cells. */
export type TestTable = readonly (readonly TestCell[])[];

function cellXml(cell: TestCell): string {
  if (Array.isArray(cell)) return cell.map(paragraphXml).join("");
  const raw = cell as { readonly text: string };
  return `<w:r><w:t xml:space="preserve">${escapeXml(raw.text)}</w:t></w:r>`;
}

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * Build the bytes of a valid DOCX whose body is the given paragraphs followed
 * by an optional table. The parts are the minimum a word processor needs:
 * `[Content_Types].xml`, `_rels/.rels` and `word/document.xml`.
 */
export function buildDocx(paragraphs: readonly TestParagraph[], table?: TestTable): Uint8Array {
  return buildDocxArchive(paragraphs, table);
}

/** Build a DOCX whose archive has an extra stored entry of the given bytes. */
function buildDocxArchive(
  paragraphs: readonly TestParagraph[],
  table?: TestTable,
  extra?: ZipEntry,
): Uint8Array {
  const body =
    paragraphs.map(paragraphXml).join("") +
    (table === undefined
      ? ""
      : `<w:tbl>${table
          .map(
            (row) =>
              `<w:tr>${row.map((cell) => `<w:tc>${cellXml(cell)}</w:tc>`).join("")}</w:tr>`,
          )
          .join("")}</w:tbl>`);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const relationships =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", bytes: encoder.encode(contentTypes) },
    { name: "_rels/.rels", bytes: encoder.encode(relationships) },
    { name: "word/document.xml", bytes: encoder.encode(document) },
  ];
  if (extra !== undefined) entries.push(extra);
  return buildZip(entries);
}

/** A DOCX with one paragraph per string and, when given, one table. */
export function docxBytes(paragraphs: readonly string[], table?: TestTable): Uint8Array {
  return buildDocx(paragraphs.map((text) => ({ runs: [text] })), table);
}

/**
 * A ZIP archive of a valid DOCX with one extra stored entry whose contents are
 * `filler` bytes. Used to make an original of an exact byte length without
 * changing the document text: the extra entry is ignored by the parser.
 */
export function docxWithPaddedEntry(filler: Uint8Array): Uint8Array {
  return buildDocxArchive([{ runs: ["Padded document."] }], undefined, {
    name: "customXml/padding.bin",
    bytes: filler,
  });
}

/**
 * A valid DOCX archive whose length is exactly `totalBytes`, made by giving an
 * extra stored entry the filler needed. The document text is unchanged; the
 * extra entry has no part relationship, so the parser ignores its content.
 */
export function docxOfLength(totalBytes: number): Uint8Array {
  const emptyArchiveLength = docxWithPaddedEntry(new Uint8Array(0)).length;
  const fillerLength = totalBytes - emptyArchiveLength;
  if (!Number.isSafeInteger(fillerLength) || fillerLength < 0) {
    throw new Error(`a padded DOCX cannot be ${totalBytes} bytes long`);
  }
  const archive = docxWithPaddedEntry(new Uint8Array(fillerLength).fill(0x61));
  if (archive.length !== totalBytes) {
    throw new Error(`padded DOCX is ${archive.length} bytes, expected ${totalBytes}`);
  }
  return archive;
}

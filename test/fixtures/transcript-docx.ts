/**
 * Synthetic DOCX bytes for the DOCX adapter tests, built in test source so no
 * binary fixture files and no install-script-generated assets are needed. A
 * DOCX is a ZIP archive of XML parts; this builder writes stored or deflated
 * ZIP entries with correct local headers, a central directory, an end record
 * and, where asked, data descriptors, using only Node built-ins, so the same
 * bytes are produced on every platform and Node version.
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The ZIP CRC-32 of the given bytes. */
export function crc32(bytes: Uint8Array): number {
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
 * A flexible ZIP entry for structural tests. `bytes` is the uncompressed
 * content used for the default CRC and deflate input; `compressedData`
 * overrides the bytes actually stored. The declared sizes and CRC default to
 * the actual content but may be overridden, which lets a test describe an
 * archive whose declarations do not match its data.
 */
export interface ZipEntrySpec {
  readonly name: string;
  readonly bytes?: Uint8Array;
  /** 0 (stored) or 8 (deflate); another value describes an unsupported method. */
  readonly method?: number;
  /** Raw member data, overriding the bytes produced from `bytes`. */
  readonly compressedData?: Uint8Array;
  readonly declaredCompressedSize?: number;
  readonly declaredUncompressedSize?: number;
  readonly crc?: number;
  /** Write a data descriptor after the member data. */
  readonly dataDescriptor?: boolean;
  /** Include the optional data-descriptor signature (default true). */
  readonly descriptorSignature?: boolean;
  /** Extra field bytes written to both headers unless one side overrides them. */
  readonly extra?: Uint8Array;
  /** Extra field bytes written only to the local header. */
  readonly localExtra?: Uint8Array;
  /** Extra field bytes written only to the central header. */
  readonly centralExtra?: Uint8Array;
  /**
   * Override the local and central header flags. Defaults to the UTF-8 name
   * flag, plus the data-descriptor flag when a descriptor is written. A legacy
   * raw name with a Unicode Path alternate omits the UTF-8 name flag.
   */
  readonly flags?: number;
  /** Raw name bytes, overriding the UTF-8 encoding of `name`. */
  readonly nameBytes?: Uint8Array;
  /** Central-header external file attributes, such as the DOS directory bit. */
  readonly externalAttributes?: number;
}

export interface BuildZipOptions {
  /** Override the end record's declared entry count, for an inconsistent archive. */
  readonly declaredEntryCount?: number;
  readonly comment?: Uint8Array;
}

/** A built archive with the offsets tests may patch to describe a bad structure. */
export interface BuiltZip {
  readonly bytes: Uint8Array;
  readonly localOffsets: readonly number[];
  readonly centralOffsets: readonly number[];
  readonly dataOffsets: readonly number[];
  readonly eocdOffset: number;
}

/**
 * Build a ZIP archive from flexible entry specifications. Entries are written
 * in the given order. A data descriptor follows its member data when asked.
 */
export function buildZipDetailed(
  entries: readonly ZipEntrySpec[],
  options: BuildZipOptions = {},
): BuiltZip {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const localOffsets: number[] = [];
  const dataOffsets: number[] = [];
  let offset = 0;
  const comment = options.comment ?? new Uint8Array(0);
  const declaredEntryCount = options.declaredEntryCount ?? entries.length;

  for (const spec of entries) {
    const name = spec.nameBytes ?? encoder.encode(spec.name);
    const content = spec.bytes ?? new Uint8Array(0);
    const method = spec.method ?? 0;
    let data: Uint8Array;
    if (spec.compressedData !== undefined) data = spec.compressedData;
    else if (method === 8) data = deflateRawSync(content);
    else data = content;
    const compressedSize = spec.declaredCompressedSize ?? data.length;
    const uncompressedSize = spec.declaredUncompressedSize ?? content.length;
    const crc = spec.crc ?? crc32(content);
    const usesDescriptor = spec.dataDescriptor === true;
    const flags = spec.flags ?? (0x0800 | (usesDescriptor ? 0x0008 : 0));
    const sharedExtra = spec.extra ?? new Uint8Array(0);
    const localExtra = spec.localExtra ?? sharedExtra;
    const centralExtra = spec.centralExtra ?? sharedExtra;

    const local = new Uint8Array(30 + name.length + localExtra.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, usesDescriptor ? 0 : crc, true);
    localView.setUint32(18, usesDescriptor ? 0 : compressedSize, true);
    localView.setUint32(22, usesDescriptor ? 0 : uncompressedSize, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, localExtra.length, true);
    local.set(name, 30);
    local.set(localExtra, 30 + name.length);

    let descriptor = new Uint8Array(0);
    if (usesDescriptor) {
      const signed = spec.descriptorSignature !== false;
      descriptor = new Uint8Array(signed ? 16 : 12);
      const descriptorView = new DataView(descriptor.buffer);
      let at = 0;
      if (signed) {
        descriptorView.setUint32(0, 0x08074b50, true);
        at = 4;
      }
      descriptorView.setUint32(at, crc, true);
      descriptorView.setUint32(at + 4, compressedSize, true);
      descriptorView.setUint32(at + 8, uncompressedSize, true);
    }

    const header = new Uint8Array(46 + name.length + centralExtra.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, 20, true);
    headerView.setUint16(8, flags, true);
    headerView.setUint16(10, method, true);
    headerView.setUint16(12, 0, true);
    headerView.setUint16(14, 0, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, compressedSize, true);
    headerView.setUint32(24, uncompressedSize, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, centralExtra.length, true);
    headerView.setUint16(32, 0, true);
    headerView.setUint16(34, 0, true);
    headerView.setUint16(36, 0, true);
    headerView.setUint32(38, spec.externalAttributes ?? 0, true);
    headerView.setUint32(42, offset, true);
    header.set(name, 46);
    header.set(centralExtra, 46 + name.length);

    localOffsets.push(offset);
    dataOffsets.push(offset + local.length);
    locals.push(local, data, descriptor);
    central.push(header);
    offset += local.length + data.length + descriptor.length;
  }

  // The central directory follows every local member, so its offsets are
  // computed from the final local-data length and each central record's length.
  const centralOffsets: number[] = [];
  let centralPosition = offset;
  for (const header of central) {
    centralOffsets.push(centralPosition);
    centralPosition += header.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22 + comment.length);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, declaredEntryCount, true);
  endView.setUint16(10, declaredEntryCount, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, comment.length, true);
  end.set(comment, 22);

  const parts = [...locals, ...central, end];
  const total = parts.reduce((size, part) => size + part.length, 0);
  const archive = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.length;
  }
  return { bytes: archive, localOffsets, centralOffsets, dataOffsets, eocdOffset: offset + centralSize };
}

/**
 * Build a stored (uncompressed) ZIP archive. Entry names are UTF-8 and flagged
 * as such, so the archive reads the same on every platform.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  return buildZipDetailed(entries.map((entry) => ({ name: entry.name, bytes: entry.bytes }))).bytes;
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

/** The ordinary DOCX parts, before any extra test entry is added. */
function docxEntries(
  paragraphs: readonly TestParagraph[],
  table?: TestTable,
): ZipEntrySpec[] {
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
    '<Default Extension="bin" ContentType="application/octet-stream"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const relationships =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  return [
    { name: "[Content_Types].xml", bytes: encoder.encode(contentTypes) },
    { name: "_rels/.rels", bytes: encoder.encode(relationships) },
    { name: "word/document.xml", bytes: encoder.encode(document) },
  ];
}

/**
 * Build the bytes of a valid DOCX whose body is the given paragraphs followed
 * by an optional table. The parts are the minimum a word processor needs:
 * `[Content_Types].xml`, `_rels/.rels` and `word/document.xml`.
 */
export function buildDocx(paragraphs: readonly TestParagraph[], table?: TestTable): Uint8Array {
  return buildZipDetailed(docxEntries(paragraphs, table)).bytes;
}

/**
 * Build a valid DOCX with the ordinary parts plus the given extra entries.
 * The extras may be stored, deflated or carry data descriptors; the parser
 * ignores an extra part that no relationship names.
 */
export function buildDocxWithExtraEntries(
  extras: readonly ZipEntrySpec[],
  paragraphs: readonly TestParagraph[] = [{ runs: ["Extra entries document."] }],
  table?: TestTable,
): Uint8Array {
  return buildZipDetailed([...docxEntries(paragraphs, table), ...extras]).bytes;
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
  return buildDocxWithExtraEntries(
    [{ name: "customXml/padding.bin", bytes: filler }],
    [{ runs: ["Padded document."] }],
  );
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

/** Deterministic pseudo-random bytes, for making an upload whose bytes are not compressed away. */
export function pseudoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(1103515245, state) + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

let ratioChunkCache: Uint8Array | null = null;

/**
 * A deterministic chunk whose raw-deflate form is exactly one hundredth of its
 * uncompressed length, so a valid entry can declare the inclusive 100:1 ratio.
 * The search is done at runtime because zlib's exact output length may differ
 * between Node builds.
 */
export function ratio100Bytes(): Uint8Array {
  if (ratioChunkCache !== null) return ratioChunkCache;
  for (const length of [10000, 20000, 50000, 200000]) {
    for (let prefix = 0; prefix <= length; prefix += 1) {
      const candidate = new Uint8Array(length).fill(0x61);
      candidate.set(pseudoRandomBytes(prefix));
      if (deflateRawSync(candidate).length * 100 === length) {
        ratioChunkCache = candidate;
        return candidate;
      }
    }
  }
  throw new Error("this zlib build produced no chunk with an exact 100:1 deflate ratio");
}

/** A valid DOCX carrying one extra entry whose declared ratio is exactly 100:1. */
export function docxWithExactRatioEntry(): Uint8Array {
  return buildDocxWithExtraEntries(
    [{ name: "customXml/ratio.bin", bytes: ratio100Bytes(), method: 8 }],
    [{ runs: ["Ratio document."] }],
  );
}

/**
 * A valid DOCX whose declared uncompressed parts total exactly `totalBytes`.
 * A short document part is joined by as many exact-100:1 deflated chunks as
 * fit, plus one stored remainder, so every entry is within the per-entry ratio
 * and size limits while the original archive stays far below its expansion.
 */
export function docxOfExpandedLength(totalBytes: number): Uint8Array {
  const paragraphs: readonly TestParagraph[] = [{ runs: ["Expanded document."] }];
  const base = docxEntries(paragraphs);
  const baseExpanded = base.reduce((sum, entry) => sum + (entry.bytes?.length ?? 0), 0);
  const chunk = ratio100Bytes();
  let remaining = totalBytes - baseExpanded;
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error(`a DOCX cannot expand to ${totalBytes} bytes`);
  }
  const extras: ZipEntrySpec[] = [];
  let ordinal = 0;
  while (remaining >= chunk.length) {
    extras.push({ name: `customXml/ratio-${ordinal}.bin`, bytes: chunk, method: 8 });
    ordinal += 1;
    remaining -= chunk.length;
  }
  if (remaining > 0) {
    extras.push({ name: "customXml/remainder.bin", bytes: new Uint8Array(remaining).fill(0x62) });
  }
  const archive = buildDocxWithExtraEntries(extras, paragraphs);
  const expanded = [...base, ...extras].reduce((sum, entry) => sum + (entry.bytes?.length ?? 0), 0);
  if (expanded !== totalBytes) {
    throw new Error(`DOCX expands to ${expanded} bytes, expected ${totalBytes}`);
  }
  return archive;
}

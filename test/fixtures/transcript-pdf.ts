/**
 * Synthetic PDF bytes for the PDF adapter tests, built in test source so no
 * binary fixture files and no install-script-generated assets are needed.
 *
 * A PDF is a short header, numbered objects, a cross-reference table and a
 * trailer. This builder writes those parts itself, using only standard
 * JavaScript, so the same bytes are produced on every platform and Node
 * version. The pages use the standard Helvetica font and uncompressed content
 * streams, which the installed parser reads offline without rendering
 * anything.
 *
 * Objects are written as byte chunks and the cross-reference table's offsets
 * and `startxref` are computed from the bytes actually written, so the
 * document stays valid whatever a stream's bytes are or however much padding a
 * caller asks for. A binary stream (the image-only page's drawing) declares its
 * own byte length, never a text length, so the stream is exactly its `/Length`.
 *
 * A page is either a list of text lines (one text item per line) or an image
 * stand-in: a page with a drawing and no text operator at all, so that the
 * page carries no extractable text.
 */

/** One page of the fixture document. */
export type TestPage = readonly string[] | "image-only";

/** A 1x1 grey RGB image, for the image-only page's drawing: three raw bytes. */
const IMAGE_BYTES = Uint8Array.from([0x80, 0x80, 0x80]);

const encoder = new TextEncoder();

/** Bytes of a text string in UTF-8. */
function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * A byte writer: appends chunks, remembers where each object starts, and
 * produces the final bytes. Offsets are the writer's own position, so they can
 * never disagree with the bytes.
 */
class PdfWriter {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  write(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === "string" ? bytesOf(chunk) : chunk;
    this.#chunks.push(bytes);
    this.#length += bytes.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Escape a string for a PDF literal string inside a content stream. */
function literal(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
}

/** True for characters outside ASCII, which a literal string cannot carry. */
function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7e) return true;
  }
  return false;
}

/**
 * The content stream of a page: its lines as text items, or a drawing with no
 * text operator for the image-only page.
 */
function contentStream(page: TestPage): string {
  if (page === "image-only") {
    return "q 1 0 0 1 100 100 cm 100 0 0 100 0 0 cm /Im1 Do Q";
  }
  if (page.some(hasNonAscii)) {
    throw new Error("fixture text lines must be ASCII; use a Unicode literal page instead");
  }
  return page
    .map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${literal(line)}) Tj ET`)
    .join("\n");
}

/** One PDF object: a dictionary, optionally followed by a stream. */
interface PdfObject {
  readonly dictionary: string;
  /** The stream's bytes; `/Length` is written as exactly their byte length. */
  readonly stream?: Uint8Array;
}

/** Write one object's body: its dictionary, then its stream when it has one. */
function writeObjectBody(writer: PdfWriter, object: PdfObject): void {
  writer.write(`${object.dictionary}\n`);
  if (object.stream === undefined) return;
  writer.write("stream\n");
  writer.write(object.stream);
  writer.write("\nendstream\n");
}

/** Write the objects, then the xref table and trailer, and return the bytes. */
function writeDocument(objects: readonly PdfObject[], trailerExtra = "", prefix = ""): Uint8Array {
  const writer = new PdfWriter();
  writer.write("%PDF-1.4\n");
  writer.write(prefix);
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(writer.length);
    writer.write(`${index + 1} 0 obj\n`);
    writeObjectBody(writer, object);
    writer.write("endobj\n");
  });
  const xrefOffset = writer.length;
  writer.write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) writer.write(`${String(offset).padStart(10, "0")} 00000 n \n`);
  writer.write(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return writer.toBytes();
}

/**
 * The objects of a document with the given pages. Object 1 is the catalog, 2
 * the page tree, 3 Helvetica, 4 the image XObject, then for each page a page
 * dictionary and its content stream.
 */
function documentObjects(pages: readonly TestPage[]): PdfObject[] {
  const firstPageObject = 5;
  const kids = pages.map((_, index) => `${firstPageObject + index * 2} 0 R`).join(" ");
  const objects: PdfObject[] = [
    { dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dictionary: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` },
    { dictionary: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      dictionary:
        "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB " +
        `/BitsPerComponent 8 /Length ${IMAGE_BYTES.length} >>`,
      stream: IMAGE_BYTES,
    },
  ];
  pages.forEach((page, index) => {
    const content = contentStream(page);
    const contentObject = firstPageObject + index * 2 + 1;
    objects.push({
      dictionary:
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        `/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${contentObject} 0 R >>`,
    });
    objects.push({ dictionary: `<< /Length ${bytesOf(content).length} >>`, stream: bytesOf(content) });
  });
  return objects;
}

/**
 * Build a PDF with the given pages. Text pages use Helvetica; an image-only
 * page draws a 1x1 image and carries no text. A password-protected document is
 * not produced here; see `passwordProtected`.
 */
export function buildPdf(pages: readonly TestPage[]): Uint8Array {
  return writeDocument(documentObjects(pages));
}

/**
 * A PDF whose pages carry the given lines. A page with no lines is a text page
 * with an empty content stream, so it carries no text; `"image-only"` is a page
 * with a drawing and no text operator.
 */
export function pdfBytes(pages: readonly TestPage[]): Uint8Array {
  return buildPdf(pages);
}

/**
 * A PDF with the given pages whose total length is exactly `totalBytes`. The
 * extra bytes are a PDF comment line (`%` begins a comment) placed right after
 * the header, where comments are allowed; the cross-reference offsets and
 * `startxref` are computed after it is written, so the document is valid and
 * its page text is unchanged.
 */
export function pdfOfLength(pages: readonly TestPage[], totalBytes: number): Uint8Array {
  const base = buildPdf(pages);
  if (totalBytes < base.length) {
    throw new Error(`a PDF with these pages cannot be shorter than ${base.length} bytes`);
  }
  // Padding shifts every offset, which can widen (or, when the offsets cross
  // a power-of-ten boundary, not widen) the `startxref` number. Measure the
  // padded document and adjust the comment by the difference until the result
  // is exactly the requested length.
  let paddingLength = totalBytes - base.length;
  if (paddingLength === 0) return base;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // A comment line is "%" plus its text plus "\n", exactly `paddingLength`
    // bytes long; it must be at least one byte of text.
    const comment = `%${"p".repeat(Math.max(0, paddingLength - 2))}\n`;
    const padded = writeDocument(documentObjects(pages), "", comment);
    const difference = totalBytes - padded.length;
    if (difference === 0) return padded;
    paddingLength += difference;
    // Shrinking below the unpadded size is impossible.
    if (paddingLength < 3) return padded;
  }
  throw new Error("the padded PDF is not the requested length");
}

/**
 * Build an encrypted PDF with a nonblank password, so the installed parser
 * refuses it as password-protected. The encryption dictionary is a valid
 * Standard security handler with no real key, which is all the parser needs to
 * report that a password is required.
 */
export function passwordProtected(): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td (Secret) Tj ET";
  const objects: PdfObject[] = [
    { dictionary: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dictionary: "<< /Type /Pages /Kids [5 0 R] /Count 1 >>" },
    { dictionary: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      dictionary:
        "<< /Filter /Standard /V 1 /R 2 " +
        "/O <0000000000000000000000000000000000000000000000000000000000000000> " +
        "/U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
    },
    {
      dictionary:
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /Font << /F1 3 0 R >> >> /Contents 6 0 R >>",
    },
    { dictionary: `<< /Length ${bytesOf(content).length} >>`, stream: bytesOf(content) },
  ];
  // Encrypt object 4.
  return writeDocument(
    objects,
    "/Encrypt 4 0 R /ID [<00000000000000000000000000000000> <00000000000000000000000000000000>] ",
  );
}

/** Bytes that are not a PDF at all, for the corrupt-input tests. */
export function corruptBytes(): Uint8Array {
  return bytesOf("This is a plain text file, not a PDF.");
}

/** Truncated PDF header bytes, which do not form a valid document. */
export function truncatedBytes(): Uint8Array {
  return bytesOf("%PDF-1.4\n1 0 obj\n<< /Type /Catalog");
}

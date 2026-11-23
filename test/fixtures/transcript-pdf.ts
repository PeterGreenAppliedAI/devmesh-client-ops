/**
 * Synthetic PDF bytes for the PDF adapter tests, built in test source so no
 * binary fixture files and no install-script-generated assets are needed.
 *
 * A PDF is a short header, numbered objects, a cross-reference table and a
 * trailer. This builder writes those parts itself with plain strings and
 * computed byte offsets, using only standard JavaScript, so the same bytes are
 * produced on every platform and Node version. The pages it writes use the
 * standard Helvetica font and uncompressed content streams, which the
 * installed parser reads offline without rendering anything.
 *
 * A page is either a list of text lines (one text item per line) or an image
 * stand-in: a page with a drawing and no text operator at all, so that the
 * page carries no extractable text.
 */

/** One page of the fixture document. */
export type TestPage = readonly string[] | "image-only";

/** A 1x1 grey RGB image, for the image-only page's drawing. */
const IMAGE_BYTES = Uint8Array.from([0x80, 0x80, 0x80]);

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

/**
 * Build a PDF with the given pages. Text pages use Helvetica; an image-only
 * page draws a 1x1 image and carries no text. A password-protected document is
 * not produced here; see `passwordProtected`.
 */
export function buildPdf(pages: readonly TestPage[]): Uint8Array {
  // Image-only pages carry no text; the document is then text-empty.
  const encoder = new TextEncoder();
  const objects: string[] = [];
  // 1 catalog, 2 pages tree, 3 Helvetica font, 4 image XObject; then for each
  // page a page dictionary and its content stream.
  const firstPageObject = 5;
  const kids = pages.map((_, index) => `${firstPageObject + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push(
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${IMAGE_BYTES.length} >>\nstream\n${String.fromCharCode(...IMAGE_BYTES)}\nendstream`,
  );
  pages.forEach((page, index) => {
    const content = contentStream(page);
    const contentObject = firstPageObject + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    objects.push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
  });
  return assemble(objects);
}

/** Join objects into a PDF with a correct cross-reference table and trailer. */
function assemble(objects: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(body);
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
 * A PDF with the given pages followed by a "padding" comment line long enough
 * that the archive's length is exactly `totalBytes`. The comment is part of
 * the PDF syntax (lines beginning with `%` are comments) and changes no page
 * text, so the extracted text is unchanged.
 */
export function pdfOfLength(pages: readonly TestPage[], totalBytes: number): Uint8Array {
  const base = buildPdf(pages);
  const baseLength = base.length;
  if (totalBytes < baseLength) {
    throw new Error(`a PDF with these pages cannot be shorter than ${baseLength} bytes`);
  }
  // A comment line must end with a newline; the trailer must stay last, so the
  // padding goes right after the header, where comments are allowed.
  const paddingLength = totalBytes - baseLength;
  const encoder = new TextEncoder();
  const header = "%PDF-1.4\n";
  const headerBytes = encoder.encode(header).length;
  const comment = `%${"p".repeat(paddingLength - 2)}\n`;
  if (paddingLength === 0) return base;
  if (paddingLength < 3) {
    throw new Error("the padding is too short to be a comment line");
  }
  const padded = new Uint8Array(totalBytes);
  padded.set(encoder.encode(header));
  padded.set(encoder.encode(comment), headerBytes);
  padded.set(base.subarray(headerBytes), headerBytes + comment.length);
  return padded;
}

/**
 * Build an encrypted PDF with a nonblank password, so the installed parser
 * refuses it as password-protected. The encryption dictionary is a valid
 * Standard security handler with no real key, which is all the parser needs to
 * report that a password is required.
 */
export function passwordProtected(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 6 0 R >>",
  ];
  const content = "BT /F1 12 Tf 72 720 Td (Secret) Tj ET";
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  // Encrypt object 4.
  return assembleEncrypted(objects, 4);
}

/** Like `assemble`, with an `/Encrypt` reference and document identifiers. */
function assembleEncrypted(objects: readonly string[], encryptObject: number): Uint8Array {
  const encoder = new TextEncoder();
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt ${encryptObject} 0 R ` +
    `/ID [<00000000000000000000000000000000> <00000000000000000000000000000000>] >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(body);
}

/** Bytes that are not a PDF at all, for the corrupt-input tests. */
export function corruptBytes(): Uint8Array {
  return new TextEncoder().encode("This is a plain text file, not a PDF.");
}

/** Truncated PDF header bytes, which do not form a valid document. */
export function truncatedBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog");
}

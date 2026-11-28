/**
 * Structural preflight for a DOCX container.
 *
 * The adapter calls this after its original-size check and before any parser
 * call. It reads the ZIP end record, the central directory and every local
 * member header exactly as the supplied bytes describe them, and refuses a
 * structure it cannot account for: a missing or ambiguous end record, an entry
 * count or central-directory size that disagrees with the bytes, an unsupported
 * compression method or feature (encryption, ZIP64, multiple disks), a member
 * whose header or data runs outside the data area, overlapping members, a
 * duplicate name, or local and central declarations that disagree.
 *
 * Declared sizes are checked before any expansion: each declared uncompressed
 * size and their sum must be at most MAX_CONTENT_BYTES, and one entry's
 * uncompressed size may not exceed 100 times its compressed size. Only after
 * those declarations pass are stored members CRC-checked and deflated members
 * expanded with a bounded inflater, so the actual output must have exactly the
 * declared length and CRC. The caller then hands the same original bytes to the
 * parser; this module never writes an expanded member anywhere.
 */
import { inflateRawSync } from "node:zlib";
import { MAX_CONTENT_BYTES } from "./transcript.ts";

/** The largest uncompressed-to-compressed ratio a member may declare. */
export const MAX_ZIP_COMPRESSION_RATIO = 100;

/** A structural refusal: the import is too large, or the container is unreadable. */
export type ZipRefusal =
  | { readonly ok: false; readonly code: "too_large"; readonly detail: string }
  | { readonly ok: false; readonly code: "unreadable_document"; readonly detail: string };

/** A structural check: the container passed, or a refusal names the reason. */
export type ZipCheck = { readonly ok: true } | ZipRefusal;

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_ID = 0x0001;
const AES_EXTRA_ID = 0x9901;
const ZIP64_VALUE = 0xffffffff;

/** Flags this reader accepts: compression options, data descriptor and UTF-8 names. */
const ALLOWED_FLAGS = 0x0002 | 0x0004 | 0x0008 | 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UTF8_NAME_FLAG = 0x0800;

/** The longest possible end record: its fixed part plus a maximal comment. */
const MAX_END_RECORD = 22 + 0xffff;

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

function unreadable(detail: string): ZipRefusal {
  return { ok: false, code: "unreadable_document", detail };
}

function tooLarge(detail: string): ZipRefusal {
  return { ok: false, code: "too_large", detail };
}

interface Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
}

function reader(bytes: Uint8Array): Reader {
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

function u16(input: Reader, offset: number): number {
  return input.view.getUint16(offset, true);
}

function u32(input: Reader, offset: number): number {
  return input.view.getUint32(offset, true);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** The one end record whose comment reaches the end of the bytes, or a refusal. */
function findEndRecord(input: Reader): ZipRefusal | { readonly ok: true; readonly offset: number } {
  const length = input.bytes.length;
  if (length < 22) return unreadable("the file is too short for a ZIP end record");
  const earliest = Math.max(0, length - MAX_END_RECORD);
  const candidates: number[] = [];
  for (let offset = length - 22; offset >= earliest; offset -= 1) {
    if (u32(input, offset) !== END_SIGNATURE) continue;
    const commentLength = u16(input, offset + 20);
    if (offset + 22 + commentLength === length) candidates.push(offset);
  }
  if (candidates.length === 0) return unreadable("the ZIP end record is missing or truncated");
  if (candidates.length > 1) return unreadable("the ZIP end record is ambiguous");
  return { ok: true, offset: candidates[0] };
}

/** True when a local or central extra field block is complete and supported. */
function validExtra(input: Reader, start: number, length: number): boolean {
  let cursor = start;
  const end = start + length;
  while (cursor < end) {
    if (cursor + 4 > end) return false;
    const id = u16(input, cursor);
    const size = u16(input, cursor + 2);
    if (cursor + 4 + size > end) return false;
    if (id === ZIP64_EXTRA_ID || id === AES_EXTRA_ID) return false;
    cursor += 4 + size;
  }
  return cursor === end;
}

/** A central-directory member declaration, before its local header is read. */
interface CentralMember {
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/** The extent of one local member: its header, its data and any descriptor. */
interface MemberExtent {
  readonly start: number;
  readonly end: number;
}

/** One parsed local member, ready for the bounded expansion check. */
interface LocalMember extends CentralMember {
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly extentEnd: number;
}

/** Read the central directory, refusing any structure the EOCD does not account for. */
function readCentralDirectory(
  input: Reader,
  endOffset: number,
): ZipRefusal | { readonly ok: true; readonly members: readonly CentralMember[] } {
  if (u16(input, endOffset + 4) !== 0 || u16(input, endOffset + 6) !== 0) {
    return unreadable("multi-disk ZIP archives are not supported");
  }
  const onDisk = u16(input, endOffset + 8);
  const total = u16(input, endOffset + 10);
  if (onDisk !== total) return unreadable("the ZIP entry count is inconsistent across disks");
  const centralSize = u32(input, endOffset + 12);
  const centralOffset = u32(input, endOffset + 16);
  if (centralOffset > endOffset || centralSize > endOffset - centralOffset) {
    return unreadable("the central directory runs outside the supplied bytes");
  }
  if (centralOffset + centralSize !== endOffset) {
    return unreadable("the central directory size does not end at the ZIP end record");
  }
  if (centralSize < total * 46) {
    return unreadable("the central directory is too short for its declared entry count");
  }

  const members: CentralMember[] = [];
  const seenNames = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > endOffset) return unreadable(`central-directory entry ${index + 1} is truncated`);
    if (u32(input, cursor) !== CENTRAL_SIGNATURE) {
      return unreadable(`central-directory entry ${index + 1} has no entry signature`);
    }
    const flags = u16(input, cursor + 8);
    const method = u16(input, cursor + 10);
    const crc = u32(input, cursor + 16);
    const compressedSize = u32(input, cursor + 20);
    const uncompressedSize = u32(input, cursor + 24);
    const nameLength = u16(input, cursor + 28);
    const extraLength = u16(input, cursor + 30);
    const commentLength = u16(input, cursor + 32);
    const diskStart = u16(input, cursor + 34);
    const localOffset = u32(input, cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > endOffset) return unreadable(`central-directory entry ${index + 1} is truncated`);
    if ((flags & ~ALLOWED_FLAGS) !== 0) {
      return unreadable(`entry ${index + 1} uses unsupported ZIP flags`);
    }
    if (method !== 0 && method !== 8) {
      return unreadable(`entry ${index + 1} uses unsupported compression method ${method}`);
    }
    if (diskStart !== 0) return unreadable(`entry ${index + 1} is not on the first disk`);
    if (
      compressedSize === ZIP64_VALUE ||
      uncompressedSize === ZIP64_VALUE ||
      localOffset === ZIP64_VALUE
    ) {
      return unreadable(`entry ${index + 1} uses ZIP64, which is not supported`);
    }
    if (nameLength === 0) return unreadable(`entry ${index + 1} has an empty name`);
    const nameStart = cursor + 46;
    const nameBytes = input.bytes.subarray(nameStart, nameStart + nameLength);
    if (nameBytes.includes(0)) return unreadable(`entry ${index + 1} has an invalid name`);
    if ((flags & UTF8_NAME_FLAG) !== 0) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
      } catch {
        return unreadable(`entry ${index + 1} has an invalid UTF-8 name`);
      }
    }
    const nameKey = Buffer.from(nameBytes).toString("hex");
    if (seenNames.has(nameKey)) return unreadable(`entry ${index + 1} repeats another entry's name`);
    seenNames.add(nameKey);
    if (!validExtra(input, nameStart + nameLength, extraLength)) {
      return unreadable(`entry ${index + 1} has an unsupported or malformed extra field`);
    }
    members.push({ nameBytes, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    cursor = recordEnd;
  }
  if (cursor !== endOffset) {
    return unreadable("the central directory carries bytes outside its declared entry count");
  }
  return { ok: true, members };
}

/** The end offset of a valid data descriptor, or null when neither form matches. */
function descriptorEnd(input: Reader, start: number, limit: number, member: CentralMember): number | null {
  const matches = (offset: number): boolean =>
    u32(input, offset) === member.crc &&
    u32(input, offset + 4) === member.compressedSize &&
    u32(input, offset + 8) === member.uncompressedSize;

  const signed = start + 16 <= limit && u32(input, start) === DATA_DESCRIPTOR_SIGNATURE && matches(start + 4);
  const unsigned = start + 12 <= limit && matches(start);
  if (signed && unsigned) return null; // both readings fit: ambiguous
  if (signed) return start + 16;
  if (unsigned) return start + 12;
  return null;
}

/** Read each local header, refuse inconsistencies, and collect non-overlapping extents. */
function readLocalMembers(
  input: Reader,
  centralOffset: number,
  members: readonly CentralMember[],
): ZipRefusal | { readonly ok: true; readonly members: readonly LocalMember[] } {
  const locals: LocalMember[] = [];
  const extents: MemberExtent[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const start = member.localOffset;
    if (start + 30 > centralOffset) {
      return unreadable(`entry ${index + 1} has no complete local header inside the data area`);
    }
    if (u32(input, start) !== LOCAL_SIGNATURE) {
      return unreadable(`entry ${index + 1} has no local header signature`);
    }
    const flags = u16(input, start + 6);
    const method = u16(input, start + 8);
    const localCrc = u32(input, start + 14);
    const localCompressedSize = u32(input, start + 18);
    const localUncompressedSize = u32(input, start + 22);
    const nameLength = u16(input, start + 26);
    const extraLength = u16(input, start + 28);
    const headerEnd = start + 30 + nameLength + extraLength;
    if (headerEnd > centralOffset) {
      return unreadable(`entry ${index + 1} has a local header that runs outside the data area`);
    }
    if (flags !== member.flags || method !== member.method) {
      return unreadable(`entry ${index + 1} disagrees between its local and central headers`);
    }
    if (localCompressedSize === ZIP64_VALUE || localUncompressedSize === ZIP64_VALUE) {
      return unreadable(`entry ${index + 1} uses ZIP64, which is not supported`);
    }
    const localName = input.bytes.subarray(start + 30, start + 30 + nameLength);
    if (!sameBytes(localName, member.nameBytes)) {
      return unreadable(`entry ${index + 1} disagrees between its local and central names`);
    }
    if (!validExtra(input, start + 30 + nameLength, extraLength)) {
      return unreadable(`entry ${index + 1} has an unsupported or malformed local extra field`);
    }
    const usesDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0;
    if (usesDescriptor) {
      if (
        (localCrc !== 0 && localCrc !== member.crc) ||
        (localCompressedSize !== 0 && localCompressedSize !== member.compressedSize) ||
        (localUncompressedSize !== 0 && localUncompressedSize !== member.uncompressedSize)
      ) {
        return unreadable(`entry ${index + 1} disagrees between its local header and data descriptor`);
      }
    } else if (
      localCrc !== member.crc ||
      localCompressedSize !== member.compressedSize ||
      localUncompressedSize !== member.uncompressedSize
    ) {
      return unreadable(`entry ${index + 1} disagrees between its local and central sizes`);
    }
    const dataStart = headerEnd;
    const dataEnd = dataStart + member.compressedSize;
    if (dataEnd > centralOffset) {
      return unreadable(`entry ${index + 1} has data running outside the data area`);
    }
    let extentEnd = dataEnd;
    if (usesDescriptor) {
      const descriptor = descriptorEnd(input, dataEnd, centralOffset, member);
      if (descriptor === null) {
        return unreadable(`entry ${index + 1} has a missing, ambiguous or inconsistent data descriptor`);
      }
      extentEnd = descriptor;
    }
    locals.push({ ...member, dataStart, dataEnd, extentEnd });
    extents.push({ start, end: extentEnd });
  }

  extents.sort((left, right) => left.start - right.start);
  if (extents.length > 0 && extents[0].start !== 0) {
    return unreadable("the ZIP data area does not start at the beginning of the file");
  }
  for (let index = 1; index < extents.length; index += 1) {
    if (extents[index].start < extents[index - 1].end) {
      return unreadable("two ZIP members overlap");
    }
  }
  return { ok: true, members: locals };
}

/** Check all declarations before any member is expanded. */
function checkDeclarations(members: readonly CentralMember[]): ZipCheck {
  let total = 0;
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member.uncompressedSize > MAX_CONTENT_BYTES) {
      return tooLarge(
        `entry ${index + 1} declares ${member.uncompressedSize} uncompressed bytes; each entry must declare at most ${MAX_CONTENT_BYTES} bytes`,
      );
    }
    total += member.uncompressedSize;
    if (total > MAX_CONTENT_BYTES) {
      return tooLarge(
        `the archive entries declare ${total} uncompressed bytes; their total must be at most ${MAX_CONTENT_BYTES} bytes`,
      );
    }
  }
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member.uncompressedSize > member.compressedSize * MAX_ZIP_COMPRESSION_RATIO) {
      return unreadable(
        `entry ${index + 1} declares ${member.uncompressedSize} uncompressed bytes against ${member.compressedSize} compressed bytes, over the ${MAX_ZIP_COMPRESSION_RATIO}:1 limit`,
      );
    }
    if (member.method === 0 && member.compressedSize !== member.uncompressedSize) {
      return unreadable(`stored entry ${index + 1} declares different compressed and uncompressed sizes`);
    }
  }
  return { ok: true };
}

/** Verify each member's actual data with a bounded operation after declarations pass. */
function verifyMembers(input: Reader, members: readonly LocalMember[]): ZipCheck {
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const data = input.bytes.subarray(member.dataStart, member.dataEnd);
    if (member.method === 0) {
      if (crc32(data) !== member.crc) {
        return unreadable(`stored entry ${index + 1} does not match its declared CRC`);
      }
      continue;
    }
    let output: Buffer;
    try {
      output = inflateRawSync(data, { maxOutputLength: member.uncompressedSize + 1 });
    } catch {
      return unreadable(`entry ${index + 1} cannot be expanded within its declared size`);
    }
    if (output.length !== member.uncompressedSize) {
      return unreadable(
        `entry ${index + 1} expands to ${output.length} bytes but declares ${member.uncompressedSize} bytes`,
      );
    }
    if (crc32(output) !== member.crc) {
      return unreadable(`entry ${index + 1} expands to bytes that do not match its declared CRC`);
    }
  }
  return { ok: true };
}

/**
 * Check one DOCX container's ZIP structure without expanding anything until
 * all declarations have passed. Returns `{ ok: true }` for a container whose
 * members are ordinary stored or deflated entries within the limits, or a
 * refusal carrying the code and a detail message. The bytes are never changed.
 */
export function checkDocxZip(bytes: Uint8Array): ZipCheck {
  const input = reader(bytes);
  const end = findEndRecord(input);
  if (!end.ok) return end;
  const central = readCentralDirectory(input, end.offset);
  if (!central.ok) return central;
  const local = readLocalMembers(input, end.offset - u32(input, end.offset + 12), central.members);
  if (!local.ok) return local;
  const declarations = checkDeclarations(local.members);
  if (!declarations.ok) return declarations;
  return verifyMembers(input, local.members);
}

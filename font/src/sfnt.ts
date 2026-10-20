// What the font previewer reads of a font file, as pure functions (no DOM):
// the container (TrueType/OpenType sfnt, WOFF 1.0, WOFF 2.0), its table
// directory, and the few tables the header, specimen and glyph grid need —
// `name` (family, style, version, designer, foundry, license), `maxp` (glyph
// count), `cmap` (which characters it has) and `fvar` (variation axes and
// named instances). Drawing is the browser's (FontFace); nothing here
// touches glyph outlines.
//
// WOFF tables are zlib streams and WOFF2's one Brotli stream: unpacked by the
// injected `decompress` (the platform's DecompressionStream). Every engine
// has "deflate"; "brotli" is in WebKit and Node but not Chromium, so a WOFF2
// there keeps only its directory (readFont's `tables` is null with a note).

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

/** Unpacks a zlib ("deflate") or Brotli stream; throws when it cannot. */
export type Decompress = (format: "deflate" | "brotli", data: Uint8Array) => Promise<Uint8Array>;

export interface FontFile {
  readonly format: FontFormat;
  /** The sfnt flavor: TrueType ("glyf") or CFF ("OTTO") outlines. */
  readonly flavor: "truetype" | "cff";
  /** Every table tag in the directory, as listed. */
  readonly tags: readonly string[];
  /** The tables by tag; null when they could not be unpacked here. */
  readonly tables: ReadonlyMap<string, DataView> | null;
  /** Why tables is null ("" otherwise). */
  readonly note: string;
}

export interface NameRecord {
  readonly platformID: number;
  readonly encodingID: number;
  readonly languageID: number;
  readonly nameID: number;
  readonly value: string;
}

export interface Axis {
  readonly tag: string;
  readonly name: string;
  readonly min: number;
  readonly def: number;
  readonly max: number;
  readonly hidden: boolean;
}

export interface Instance {
  readonly name: string;
  /** One value per axis, in the axes' order. */
  readonly coordinates: readonly number[];
}

/** What the previewer shows of a font. Names are "" when the font has none. */
export interface FontInfo {
  readonly format: FontFormat;
  readonly outlines: string;
  readonly tags: readonly string[];
  /** False when the tables could not be unpacked (see note): only the
   *  directory is known. */
  readonly readable: boolean;
  readonly note: string;
  readonly family: string;
  readonly style: string;
  readonly fullName: string;
  readonly version: string;
  readonly postscriptName: string;
  readonly designer: string;
  readonly manufacturer: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly glyphCount: number | null;
  /** Code point → glyph id; null when unknown. */
  readonly cmap: ReadonlyMap<number, number> | null;
  /** A variable font has an fvar table (known from the directory alone). */
  readonly variable: boolean;
  readonly axes: readonly Axis[];
  readonly instances: readonly Instance[];
}

/** What a Decompress throws for a format the platform does not have. */
export class UnsupportedCompression extends Error {
  constructor(format: string) {
    super(`${format} streams cannot be unpacked here`);
    this.name = "UnsupportedCompression";
  }
}

/** The decompressors of the platform this runs on (browser or Node). */
export const streamDecompress: Decompress = async (format, data) => {
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream(format as CompressionFormat);
  } catch {
    throw new UnsupportedCompression(format);
  }
  const writer = stream.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  void writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

function tagAt(view: DataView, at: number): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(at + i));
  return s;
}

/** The container of a font file by its first four bytes; "collection" for
 *  a TrueType collection (.ttc), null when it is not a font. */
export function sniffFont(bytes: ArrayBuffer): FontFormat | "collection" | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes);
  const tag = tagAt(view, 0);
  if (view.getUint32(0) === 0x00010000 || tag === "true") return "ttf";
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "ttcf") return "collection";
  return null;
}

function fail(message: string): never {
  throw new Error(message);
}

function slice(view: DataView, offset: number, length: number, what: string): DataView {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) fail(`the ${what} table runs past the end of the file`);
  return new DataView(view.buffer, view.byteOffset + offset, length);
}

function flavorOf(view: DataView, at: number): "truetype" | "cff" {
  return tagAt(view, at) === "OTTO" ? "cff" : "truetype";
}

function readSfnt(view: DataView): FontFile {
  const n = view.getUint16(4);
  if (12 + n * 16 > view.byteLength) fail("the table directory runs past the end of the file");
  const tables = new Map<string, DataView>();
  const tags: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = tagAt(view, at);
    tags.push(tag);
    tables.set(tag, slice(view, view.getUint32(at + 8), view.getUint32(at + 12), tag.trim()));
  }
  return { format: tagAt(view, 0) === "OTTO" ? "otf" : "ttf", flavor: flavorOf(view, 0), tags, tables, note: "" };
}

async function readWoff(view: DataView, decompress: Decompress): Promise<FontFile> {
  const n = view.getUint16(12);
  if (44 + n * 20 > view.byteLength) fail("the table directory runs past the end of the file");
  const tables = new Map<string, DataView>();
  const tags: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = 44 + i * 20;
    const tag = tagAt(view, at);
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    tags.push(tag);
    const stored = slice(view, offset, compLength, tag.trim());
    if (compLength >= origLength) {
      tables.set(tag, stored);
      continue;
    }
    let out: Uint8Array;
    try {
      out = await decompress("deflate", new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength));
    } catch {
      return fail(`the ${tag.trim()} table could not be unpacked`);
    }
    if (out.byteLength !== origLength) fail(`the ${tag.trim()} table unpacks to the wrong size`);
    tables.set(tag, new DataView(out.buffer, out.byteOffset, out.byteLength));
  }
  return { format: "woff", flavor: flavorOf(view, 4), tags, tables, note: "" };
}

/** WOFF2's known-table index (flags & 63; 63 = the tag follows). */
export const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
] as const;

function base128(view: DataView, at: { pos: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = view.getUint8(at.pos++);
    if (i === 0 && b === 0x80) fail("a WOFF2 length has a leading zero");
    if (value > 0x1ffffff) fail("a WOFF2 length overflows");
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return value;
  }
  return fail("a WOFF2 length is longer than five bytes");
}

async function readWoff2(view: DataView, decompress: Decompress): Promise<FontFile> {
  const n = view.getUint16(12);
  const compressedLength = view.getUint32(20);
  const flavor = flavorOf(view, 4);
  if (tagAt(view, 4) === "ttcf") fail("font collections are not supported");
  const at = { pos: 48 };
  const entries: { tag: string; length: number }[] = [];
  for (let i = 0; i < n; i++) {
    const flags = view.getUint8(at.pos++);
    let tag: string;
    if ((flags & 0x3f) === 0x3f) {
      tag = tagAt(view, at.pos);
      at.pos += 4;
    } else tag = WOFF2_KNOWN_TAGS[flags & 0x3f] ?? fail("a WOFF2 table has an unknown index");
    const origLength = base128(view, at);
    const version = flags >> 6;
    // glyf and loca are transformed unless version 3; others unless version 0.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    const length = transformed ? base128(view, at) : origLength;
    entries.push({ tag, length });
  }
  const tags = entries.map((e) => e.tag);
  const packed = slice(view, at.pos, compressedLength, "compressed");
  let stream: Uint8Array;
  try {
    stream = await decompress("brotli", new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
  } catch (err) {
    if (err instanceof UnsupportedCompression) {
      return { format: "woff2", flavor, tags, tables: null, note: "This browser cannot unpack WOFF2 tables (Brotli), so the font's names, character map and axes are not shown." };
    }
    return fail("the WOFF2 data could not be unpacked");
  }
  const data = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const tables = new Map<string, DataView>();
  let offset = 0;
  for (const e of entries) {
    // A transformed table (glyf, loca, hmtx) is not one the previewer reads.
    tables.set(e.tag, slice(data, offset, e.length, e.tag.trim()));
    offset += e.length;
  }
  return { format: "woff2", flavor, tags, tables, note: "" };
}

/** Reads a font file's container and table directory, unpacking WOFF and
 *  WOFF2 tables. Throws, with a short reason, for anything else. */
export async function readFont(bytes: ArrayBuffer, decompress: Decompress = streamDecompress): Promise<FontFile> {
  const kind = sniffFont(bytes);
  if (kind === null) fail("this is not a TrueType, OpenType, WOFF or WOFF2 font");
  if (kind === "collection") fail("font collections (.ttc) are not supported");
  const view = new DataView(bytes);
  try {
    if (kind === "woff") return await readWoff(view, decompress);
    if (kind === "woff2") return await readWoff2(view, decompress);
    return readSfnt(view);
  } catch (err) {
    if (err instanceof RangeError) fail("the font is truncated");
    throw err;
  }
}

// --- name ---------------------------------------------------------------------

function utf16be(view: DataView, at: number, length: number): string {
  let s = "";
  for (let i = 0; i + 1 < length; i += 2) s += String.fromCharCode(view.getUint16(at + i));
  return s;
}

let macDecoder: TextDecoder | null | undefined;
function macRoman(bytes: Uint8Array): string {
  if (macDecoder === undefined) {
    try {
      macDecoder = new TextDecoder("macintosh");
    } catch {
      macDecoder = null;
    }
  }
  return macDecoder ? macDecoder.decode(bytes) : String.fromCharCode(...bytes);
}

/** Every name record whose encoding the previewer can read (Unicode and
 *  Windows records as UTF-16BE, Macintosh Roman). */
export function parseName(view: DataView): NameRecord[] {
  const count = view.getUint16(2);
  const strings = view.getUint16(4);
  const out: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > view.byteLength) break;
    const platformID = view.getUint16(at);
    const encodingID = view.getUint16(at + 2);
    const languageID = view.getUint16(at + 4);
    const nameID = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const offset = strings + view.getUint16(at + 10);
    if (offset + length > view.byteLength) continue;
    let value: string;
    if (platformID === 0 || platformID === 3) value = utf16be(view, offset, length);
    else if (platformID === 1 && encodingID === 0) value = macRoman(new Uint8Array(view.buffer, view.byteOffset + offset, length));
    else continue;
    out.push({ platformID, encodingID, languageID, nameID, value: value.replace(/\0/g, "").trim() });
  }
  return out;
}

/** A name by id: Windows English (US) first, then any Windows, Unicode and
 *  Macintosh English record; "" when the font has none. */
export function nameOf(records: readonly NameRecord[], nameID: number): string {
  const of = records.filter((r) => r.nameID === nameID && r.value !== "");
  const pick =
    of.find((r) => r.platformID === 3 && r.languageID === 0x409) ??
    of.find((r) => r.platformID === 3) ??
    of.find((r) => r.platformID === 0) ??
    of.find((r) => r.platformID === 1 && r.languageID === 0) ??
    of[0];
  return pick?.value ?? "";
}

// --- maxp, cmap, fvar -------------------------------------------------------------

export function parseMaxp(view: DataView): number {
  return view.getUint16(4);
}

/** The highest code point; larger values in a cmap are ignored. */
const MAX_CODE_POINT = 0x10ffff;
/** How many mappings a subtable may walk: every code point once, twice
 *  over; a malformed table with overlapping ranges stops there. */
const MAX_MAPPINGS = 2 * (MAX_CODE_POINT + 1);

/** One cmap subtable (formats 0, 4, 6, 12 and 13) at `offset` of the cmap
 *  table: code point → glyph id, glyph 0 (.notdef) left out. null for a
 *  format the previewer does not read. */
export function parseCmapSubtable(view: DataView, offset: number): Map<number, number> | null {
  const map = new Map<number, number>();
  const format = view.getUint16(offset);
  let walked = 0;
  if (format === 0) {
    for (let c = 0; c < 256; c++) {
      const g = view.getUint8(offset + 6 + c);
      if (g) map.set(c, g);
    }
    return map;
  }
  if (format === 6) {
    const first = view.getUint16(offset + 6);
    const count = view.getUint16(offset + 8);
    for (let i = 0; i < count; i++) {
      const g = view.getUint16(offset + 10 + i * 2);
      if (g) map.set(first + i, g);
    }
    return map;
  }
  if (format === 4) {
    const segCount = view.getUint16(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segCount * 2 + 2;
    const deltas = starts + segCount * 2;
    const ranges = deltas + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = view.getUint16(ends + s * 2);
      const start = view.getUint16(starts + s * 2);
      const delta = view.getUint16(deltas + s * 2);
      const rangeAt = ranges + s * 2;
      const range = view.getUint16(rangeAt);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        if (++walked > MAX_MAPPINGS) return map;
        let g: number;
        if (range === 0) g = (c + delta) & 0xffff;
        else {
          const at = rangeAt + range + (c - start) * 2;
          if (at + 2 > view.byteLength) break;
          g = view.getUint16(at);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) map.set(c, g);
      }
    }
    return map;
  }
  if (format === 12 || format === 13) {
    const groups = view.getUint32(offset + 12);
    for (let i = 0; i < groups; i++) {
      const at = offset + 16 + i * 12;
      if (at + 12 > view.byteLength) break;
      const start = view.getUint32(at);
      const end = Math.min(view.getUint32(at + 4), MAX_CODE_POINT);
      const glyph = view.getUint32(at + 8);
      for (let c = start; c <= end; c++) {
        if (++walked > MAX_MAPPINGS) return map;
        const g = format === 12 ? glyph + (c - start) : glyph;
        if (g) map.set(c, g);
      }
    }
    return map;
  }
  return null;
}

/** How much a cmap encoding record is preferred: the full Unicode
 *  repertoire first, then the BMP, a symbol font's, a Macintosh one. */
function cmapRank(platformID: number, encodingID: number): number {
  if ((platformID === 3 && encodingID === 10) || (platformID === 0 && (encodingID === 4 || encodingID === 6))) return 4;
  if ((platformID === 3 && encodingID === 1) || (platformID === 0 && encodingID <= 3)) return 3;
  if (platformID === 3 && encodingID === 0) return 2;
  if (platformID === 1 && encodingID === 0) return 1;
  return 0;
}

/** The font's character map: the best Unicode subtable it has (see
 *  cmapRank), code point → glyph id. Empty when it has none readable. */
export function parseCmap(view: DataView): Map<number, number> {
  const count = view.getUint16(2);
  const records: { rank: number; offset: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8;
    if (at + 8 > view.byteLength) break;
    const rank = cmapRank(view.getUint16(at), view.getUint16(at + 2));
    if (rank > 0) records.push({ rank, offset: view.getUint32(at + 4) });
  }
  records.sort((a, b) => b.rank - a.rank);
  for (const r of records) {
    if (r.offset + 2 > view.byteLength) continue;
    const map = parseCmapSubtable(view, r.offset);
    if (map && map.size > 0) return map;
  }
  return new Map();
}

function fixed(view: DataView, at: number): number {
  return view.getInt32(at) / 65536;
}

/** The variation axes and named instances, with their names. */
export function parseFvar(view: DataView, names: readonly NameRecord[]): { axes: Axis[]; instances: Instance[] } {
  const axesAt = view.getUint16(4);
  const axisCount = view.getUint16(8);
  const axisSize = view.getUint16(10);
  const instanceCount = view.getUint16(12);
  const instanceSize = view.getUint16(14);
  const axes: Axis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const at = axesAt + i * axisSize;
    if (at + 20 > view.byteLength) break;
    const tag = tagAt(view, at);
    axes.push({
      tag,
      min: fixed(view, at + 4),
      def: fixed(view, at + 8),
      max: fixed(view, at + 12),
      hidden: (view.getUint16(at + 16) & 0x0001) !== 0,
      name: nameOf(names, view.getUint16(at + 18)) || tag.trim(),
    });
  }
  const instances: Instance[] = [];
  const instancesAt = axesAt + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const at = instancesAt + i * instanceSize;
    if (at + 4 + axes.length * 4 > view.byteLength) break;
    const coordinates = axes.map((_, a) => fixed(view, at + 4 + a * 4));
    instances.push({ name: nameOf(names, view.getUint16(at)) || `Instance ${i + 1}`, coordinates });
  }
  return { axes, instances };
}

// --- the whole picture ---------------------------------------------------------------

function outlinesOf(file: FontFile): string {
  if (file.tags.includes("CFF2")) return "CFF2 outlines";
  if (file.tags.includes("CFF ")) return "CFF outlines";
  if (file.tags.includes("glyf")) return "TrueType outlines";
  if (file.tags.some((t) => t === "sbix" || t === "CBDT" || t === "EBDT")) return "bitmap glyphs";
  return file.flavor === "cff" ? "CFF outlines" : "TrueType outlines";
}

/** A table that does not parse leaves its part of the picture empty
 *  rather than failing the whole font. */
function tryRead<T>(read: () => T, empty: T): T {
  try {
    return read();
  } catch {
    return empty;
  }
}

/** What the previewer shows of a font file, read from its tables (names
 *  prefer the typographic family and style, IDs 16 and 17, over 1 and 2;
 *  the designer, ID 9, over nothing). */
export function describeFont(file: FontFile): FontInfo {
  const base = {
    format: file.format,
    outlines: outlinesOf(file),
    tags: file.tags,
    note: file.note,
    variable: file.tags.includes("fvar"),
  };
  const t = file.tables;
  if (!t) {
    return {
      ...base,
      readable: false,
      family: "",
      style: "",
      fullName: "",
      version: "",
      postscriptName: "",
      designer: "",
      manufacturer: "",
      license: "",
      licenseUrl: "",
      glyphCount: null,
      cmap: null,
      axes: [],
      instances: [],
    };
  }
  const nameTable = t.get("name");
  const names = nameTable ? tryRead(() => parseName(nameTable), []) : [];
  const maxp = t.get("maxp");
  const cmap = t.get("cmap");
  const fvar = t.get("fvar");
  const { axes, instances } = fvar ? tryRead(() => parseFvar(fvar, names), { axes: [], instances: [] }) : { axes: [], instances: [] };
  return {
    ...base,
    readable: true,
    family: nameOf(names, 16) || nameOf(names, 1),
    style: nameOf(names, 17) || nameOf(names, 2),
    fullName: nameOf(names, 4),
    version: nameOf(names, 5),
    postscriptName: nameOf(names, 6),
    designer: nameOf(names, 9),
    manufacturer: nameOf(names, 8),
    license: nameOf(names, 13),
    licenseUrl: nameOf(names, 14),
    glyphCount: maxp ? tryRead<number | null>(() => parseMaxp(maxp), null) : null,
    cmap: cmap ? tryRead(() => parseCmap(cmap), new Map<number, number>()) : null,
    axes,
    instances,
  };
}

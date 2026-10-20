#!/usr/bin/env node
// Regenerates the committed sample fonts deterministically. The font is made
// here, from nothing (no other font's outlines or names), so it is this
// repository's own work under its license (Apache-2.0, ../../LICENSE):
//
//   sample.ttf    "Bnbloc Sample": a variable TrueType font with a wght axis
//                 100–900 (gvar: the counters close as the weight rises),
//                 four named instances, box glyphs for A–Z a–z 0–9 and
//                 ! , . ? and seven Vietnamese letters (Vietnamese partly
//                 covered, no CJK)
//   sample.woff   the same tables, zlib-compressed (WOFF 1.0)
//   sample.woff2  the same tables, Brotli-compressed (WOFF 2.0, glyf and
//                 loca not transformed)
//
// Usage: node font/samples/generate.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants, deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- a big-endian writer ------------------------------------------------------

class Out {
  bytes = [];
  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v) {
    return this.u16(v & 0xffff);
  }
  u32(v) {
    return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
  }
  fixed(v) {
    return this.u32(Math.round(v * 65536) >>> 0);
  }
  f2dot14(v) {
    return this.i16(Math.round(v * 16384));
  }
  tag(t) {
    for (const ch of t) this.u8(ch.charCodeAt(0));
    return this;
  }
  raw(b) {
    for (const v of b) this.u8(v);
    return this;
  }
  pad(n) {
    while (this.bytes.length % n) this.u8(0);
    return this;
  }
  buffer() {
    return Buffer.from(this.bytes);
  }
}

// --- the design ----------------------------------------------------------------

const UPM = 1000;
const ASCENT = 800;
const DESCENT = -200;
const AXIS = { tag: "wght", min: 100, def: 400, max: 900, nameId: 256 };
const INSTANCES = [
  { nameId: 257, name: "Thin", wght: 100 },
  { nameId: 258, name: "Regular", wght: 400 },
  { nameId: 259, name: "Bold", wght: 700 },
  { nameId: 260, name: "Black", wght: 900 },
];

// Each glyph: an advance, an outer box and (for the letters) a counter that
// closes by `bold` units at wght 900 and opens by `light` at wght 100.
const GLYPHS = [
  { name: ".notdef", advance: 500, box: [50, 0, 450, 700], inset: 50 },
  { name: "space", advance: 250 },
  { name: "upper", advance: 600, box: [60, 0, 540, 700], inset: 80, bold: 70, light: 60 },
  { name: "lower", advance: 520, box: [50, 0, 470, 500], inset: 70, bold: 60, light: 50 },
  { name: "digit", advance: 560, box: [60, 0, 500, 680], inset: 80, bold: 70, light: 60 },
  { name: "punct", advance: 280, box: [90, 0, 190, 100] },
];

/** Code point → glyph index. */
function charMap() {
  const map = new Map();
  map.set(0x20, 1);
  for (const ch of "!,.?") map.set(ch.codePointAt(0), 5);
  for (let c = 0x30; c <= 0x39; c++) map.set(c, 4);
  for (let c = 0x41; c <= 0x5a; c++) map.set(c, 2);
  for (let c = 0x61; c <= 0x7a; c++) map.set(c, 3);
  for (const ch of "âêôăđơư") map.set(ch.codePointAt(0), 3);
  return new Map([...map].sort((a, b) => a[0] - b[0]));
}

const NAMES = {
  1: "Bnbloc Sample",
  2: "Regular",
  3: "bnbloc-previewers: Bnbloc Sample Regular: 0.100",
  4: "Bnbloc Sample Regular",
  5: "Version 0.100",
  6: "BnblocSample-Regular",
  8: "bnbloc-previewers",
  9: "font/samples/generate.mjs",
  13: "Licensed under the Apache License, Version 2.0: a test font generated for the bnbloc font previewer; its glyphs are boxes.",
  14: "https://www.apache.org/licenses/LICENSE-2.0",
  [AXIS.nameId]: "Weight",
  ...Object.fromEntries(INSTANCES.map((i) => [i.nameId, i.name])),
};

// --- tables ----------------------------------------------------------------------

/** The outline points of a glyph: the outer box clockwise, the counter
 *  counter-clockwise (TrueType's winding). */
function contours(g) {
  if (!g.box) return [];
  const [x0, y0, x1, y1] = g.box;
  const outer = [
    [x0, y0],
    [x0, y1],
    [x1, y1],
    [x1, y0],
  ];
  if (!g.inset) return [outer];
  const s = g.inset;
  return [
    outer,
    [
      [x0 + s, y0 + s],
      [x1 - s, y0 + s],
      [x1 - s, y1 - s],
      [x0 + s, y1 - s],
    ],
  ];
}

function glyfAndLoca() {
  const glyf = new Out();
  const offsets = [];
  for (const g of GLYPHS) {
    offsets.push(glyf.bytes.length);
    const cs = contours(g);
    if (cs.length === 0) continue;
    const [x0, y0, x1, y1] = g.box;
    glyf.i16(cs.length).i16(x0).i16(y0).i16(x1).i16(y1);
    let end = -1;
    for (const c of cs) glyf.u16((end += c.length));
    glyf.u16(0); // no instructions
    const points = cs.flat();
    for (let i = 0; i < points.length; i++) glyf.u8(0x01); // on curve, word deltas
    let px = 0;
    let py = 0;
    for (const [x] of points) glyf.i16(x - px), (px = x);
    for (const [, y] of points) glyf.i16(y - py), (py = y);
    glyf.pad(2);
  }
  offsets.push(glyf.bytes.length);
  const loca = new Out();
  for (const o of offsets) loca.u16(o / 2);
  return { glyf: glyf.buffer(), loca: loca.buffer() };
}

/** gvar: two tuples per letter glyph, at wght max (+1) and min (−1), moving
 *  the counter's four points; the phantom points stay. */
function gvar() {
  const datas = GLYPHS.map((g) => {
    if (!g.bold) return Buffer.alloc(0);
    const points = contours(g).flat().length + 4;
    const tuple = (d) => {
      const dx = new Array(points).fill(0);
      const dy = new Array(points).fill(0);
      // The counter is points 4..7: bottom-left, bottom-right, top-right, top-left.
      [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ].forEach(([sx, sy], i) => {
        dx[4 + i] = sx * d;
        dy[4 + i] = sy * d;
      });
      const o = new Out();
      for (const list of [dx, dy]) {
        o.u8(0x40 | (points - 1));
        for (const v of list) o.i16(v);
      }
      return o.buffer();
    };
    const up = tuple(g.bold);
    const down = tuple(-g.light);
    const o = new Out();
    o.u16(0x8000 | 2); // shared point numbers, two tuples
    o.u16(4 + 2 * 6); // serialized data offset
    o.u16(up.length).u16(0x8000).f2dot14(1);
    o.u16(down.length).u16(0x8000).f2dot14(-1);
    o.u8(0); // shared points: all of them
    o.raw(up).raw(down).pad(2);
    return o.buffer();
  });
  const head = 20;
  const arrayOffset = head + (GLYPHS.length + 1) * 2;
  const o = new Out();
  o.u16(1).u16(0).u16(1).u16(0).u32(head).u16(GLYPHS.length).u16(0).u32(arrayOffset);
  let at = 0;
  for (const d of datas) o.u16(at / 2), (at += d.length);
  o.u16(at / 2);
  for (const d of datas) o.raw(d);
  return o.buffer();
}

function fvar() {
  const o = new Out();
  o.u16(1).u16(0).u16(16).u16(2).u16(1).u16(20).u16(INSTANCES.length).u16(4 + 4);
  o.tag(AXIS.tag).fixed(AXIS.min).fixed(AXIS.def).fixed(AXIS.max).u16(0).u16(AXIS.nameId);
  for (const i of INSTANCES) o.u16(i.nameId).u16(0).fixed(i.wght);
  return o.buffer();
}

function cmapFormat4(map) {
  // One segment per run of consecutive code points, each through the glyph
  // id array; then the closing 0xFFFF segment.
  const runs = [];
  for (const [cp, gid] of map) {
    const last = runs[runs.length - 1];
    if (last && last.end + 1 === cp) {
      last.end = cp;
      last.gids.push(gid);
    } else runs.push({ start: cp, end: cp, gids: [gid] });
  }
  const segCount = runs.length + 1;
  const log = Math.floor(Math.log2(segCount));
  const o = new Out();
  const glyphIds = runs.flatMap((r) => r.gids);
  const length = 16 + segCount * 8 + glyphIds.length * 2;
  o.u16(4).u16(length).u16(0).u16(segCount * 2).u16(2 * 2 ** log).u16(log).u16(segCount * 2 - 2 * 2 ** log);
  for (const r of runs) o.u16(r.end);
  o.u16(0xffff).u16(0);
  for (const r of runs) o.u16(r.start);
  o.u16(0xffff);
  for (let i = 0; i < runs.length; i++) o.u16(0);
  o.u16(1);
  let base = 0;
  runs.forEach((r, i) => {
    o.u16(2 * (segCount - i) + 2 * base);
    base += r.gids.length;
  });
  o.u16(0);
  for (const g of glyphIds) o.u16(g);
  return o.buffer();
}

function cmapFormat12(map) {
  const o = new Out();
  o.u16(12).u16(0).u32(16 + map.size * 12).u32(0).u32(map.size);
  for (const [cp, gid] of map) o.u32(cp).u32(cp).u32(gid);
  return o.buffer();
}

function cmap() {
  const map = charMap();
  const f4 = cmapFormat4(map);
  const f12 = cmapFormat12(map);
  const o = new Out();
  o.u16(0).u16(2);
  o.u16(3).u16(1).u32(4 + 16);
  o.u16(3).u16(10).u32(4 + 16 + f4.length);
  return Buffer.concat([o.buffer(), f4, f12]);
}

function name() {
  const records = [];
  for (const id of [1, 2]) records.push({ platform: 1, encoding: 0, language: 0, id, data: Buffer.from(NAMES[id], "latin1") });
  for (const id of Object.keys(NAMES).map(Number).sort((a, b) => a - b)) {
    records.push({ platform: 3, encoding: 1, language: 0x409, id, data: Buffer.from(NAMES[id], "utf16le").swap16() });
  }
  const o = new Out();
  o.u16(0).u16(records.length).u16(6 + records.length * 12);
  let at = 0;
  for (const r of records) o.u16(r.platform).u16(r.encoding).u16(r.language).u16(r.id).u16(r.data.length).u16(at), (at += r.data.length);
  for (const r of records) o.raw(r.data);
  return o.buffer();
}

function bounds() {
  const boxes = GLYPHS.filter((g) => g.box).map((g) => g.box);
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

function head() {
  const [x0, y0, x1, y1] = bounds();
  const o = new Out();
  o.fixed(1).u32(0x0000199a).u32(0).u32(0x5f0f3cf5).u16(0x0003).u16(UPM);
  o.u32(0).u32(0xe5b5a400).u32(0).u32(0xe5b5a400); // created, modified: fixed dates
  o.i16(x0).i16(y0).i16(x1).i16(y1).u16(0).u16(8).i16(2).i16(0).i16(0);
  return o.buffer();
}

function hhea() {
  const o = new Out();
  const [, , x1] = bounds();
  o.fixed(1).i16(ASCENT).i16(DESCENT).i16(0).u16(Math.max(...GLYPHS.map((g) => g.advance)));
  o.i16(0).i16(0).i16(x1).i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(GLYPHS.length);
  return o.buffer();
}

function hmtx() {
  const o = new Out();
  for (const g of GLYPHS) o.u16(g.advance).i16(g.box ? g.box[0] : 0);
  return o.buffer();
}

function maxp() {
  const o = new Out();
  o.fixed(1).u16(GLYPHS.length).u16(8).u16(2).u16(0).u16(0).u16(2);
  for (let i = 0; i < 8; i++) o.u16(0);
  return o.buffer();
}

function os2() {
  const map = charMap();
  const cps = [...map.keys()];
  const o = new Out();
  o.u16(4).i16(520).u16(400).u16(5).u16(0);
  o.i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(300).i16(0);
  o.raw(new Array(10).fill(0));
  o.u32(0x00000007).u32(0).u32(0).u32(0); // Basic Latin, Latin-1 Supplement, Latin Extended-A
  o.tag("NONE").u16(0x0040).u16(cps[0]).u16(Math.min(0xffff, cps[cps.length - 1]));
  o.i16(ASCENT).i16(DESCENT).i16(0).u16(ASCENT).u16(-DESCENT).u32(1).u32(0);
  o.i16(500).i16(700).u16(0).u16(0x20).u16(1);
  return o.buffer();
}

function post() {
  return new Out().u32(0x00030000).fixed(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).buffer();
}

function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 4) sum = (sum + ((buf[i] << 24) | ((buf[i + 1] ?? 0) << 16) | ((buf[i + 2] ?? 0) << 8) | (buf[i + 3] ?? 0))) >>> 0;
  return sum;
}

/** The font's tables by tag, sorted. */
export function sampleTables() {
  const { glyf, loca } = glyfAndLoca();
  const tables = { "OS/2": os2(), cmap: cmap(), fvar: fvar(), glyf, gvar: gvar(), head: head(), hhea: hhea(), hmtx: hmtx(), loca, maxp: maxp(), name: name(), post: post() };
  return Object.fromEntries(Object.entries(tables).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The sfnt (.ttf). */
export function sampleTtf() {
  const tables = sampleTables();
  const tags = Object.keys(tables);
  const n = tags.length;
  const log = Math.floor(Math.log2(n));
  const dir = new Out();
  dir.u32(0x00010000).u16(n).u16(16 * 2 ** log).u16(log).u16(n * 16 - 16 * 2 ** log);
  let offset = 12 + 16 * n;
  const body = [];
  for (const tag of tags) {
    const data = tables[tag];
    dir.tag(tag).u32(checksum(data)).u32(offset).u32(data.length);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    body.push(padded);
    offset += padded.length;
  }
  const font = Buffer.concat([dir.buffer(), ...body]);
  const headAt = font.readUInt32BE(12 + 16 * tags.indexOf("head") + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

/** The same tables in a WOFF 1.0 container, zlib-compressed. */
export function sampleWoff() {
  const tables = sampleTables();
  const tags = Object.keys(tables);
  const sfntSize = 12 + 16 * tags.length + tags.reduce((s, t) => s + Math.ceil(tables[t].length / 4) * 4, 0);
  const dir = new Out();
  const body = [];
  let offset = 44 + 20 * tags.length;
  for (const tag of tags) {
    const data = tables[tag];
    const packed = deflateSync(data, { level: 9 });
    const stored = packed.length < data.length ? packed : data;
    dir.tag(tag).u32(offset).u32(stored.length).u32(data.length).u32(checksum(data));
    const padded = Buffer.concat([stored, Buffer.alloc((4 - (stored.length % 4)) % 4)]);
    body.push(padded);
    offset += padded.length;
  }
  const header = new Out();
  header.tag("wOFF").u32(0x00010000).u32(offset).u16(tags.length).u16(0).u32(sfntSize).u16(0).u16(100);
  header.u32(0).u32(0).u32(0).u32(0).u32(0);
  return Buffer.concat([header.buffer(), dir.buffer(), ...body]);
}

const WOFF2_KNOWN_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

function base128(o, v) {
  const groups = [];
  do {
    groups.unshift(v & 0x7f);
    v = Math.floor(v / 128);
  } while (v > 0);
  groups.forEach((g, i) => o.u8(i < groups.length - 1 ? g | 0x80 : g));
}

/** The same tables in a WOFF 2.0 container: one Brotli stream, glyf and
 *  loca with the null transform (version 3), the rest untransformed. */
export function sampleWoff2() {
  const tables = sampleTables();
  const tags = Object.keys(tables);
  const sfntSize = 12 + 16 * tags.length + tags.reduce((s, t) => s + Math.ceil(tables[t].length / 4) * 4, 0);
  const dir = new Out();
  for (const tag of tags) {
    const known = WOFF2_KNOWN_TAGS.indexOf(tag);
    const version = tag === "glyf" || tag === "loca" ? 3 : 0;
    if (known >= 0) dir.u8((version << 6) | known);
    else dir.u8((version << 6) | 63).tag(tag);
    base128(dir, tables[tag].length);
  }
  const stream = Buffer.concat(tags.map((t) => tables[t]));
  const compressed = brotliCompressSync(stream, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: stream.length,
    },
  });
  const unpadded = 48 + dir.bytes.length + compressed.length;
  const length = Math.ceil(unpadded / 4) * 4;
  const header = new Out();
  header.tag("wOF2").u32(0x00010000).u32(length).u16(tags.length).u16(0).u32(sfntSize).u32(compressed.length).u16(0).u16(100);
  header.u32(0).u32(0).u32(0).u32(0).u32(0);
  return Buffer.concat([header.buffer(), dir.buffer(), compressed, Buffer.alloc(length - unpadded)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(HERE, "sample.ttf"), sampleTtf());
  writeFileSync(join(HERE, "sample.woff"), sampleWoff());
  writeFileSync(join(HERE, "sample.woff2"), sampleWoff2());
}

// What the font previewer says about a font, as pure functions (no DOM): the
// default sample, which of its characters the font lacks, how much of a few
// scripts it covers, the font-variation-settings for the axis sliders, the
// glyph grid's pages, what a click on a glyph or a sample names for the Ask
// AI panel, and the font's facts as Compare units.

import type { UnitDraft } from "@bnbloc/previewer-sdk";
import type { Axis, FontInfo, Instance } from "./sfnt.ts";

/** Whether the font has a glyph for a code point. */
export type Has = (cp: number) => boolean;

/** The sample a member sees first, and edits: a Latin pangram, Vietnamese
 *  with its diacritics, Chinese, then digits and punctuation, so a font
 *  without Vietnamese or CJK glyphs shows it at once. */
export const DEFAULT_SAMPLE = [
  "The quick brown fox jumps over the lazy dog.",
  "Tiếng Việt có dấu: Đường phố Hà Nội rực rỡ ánh đèn.",
  "中文字体样例：永和九年，岁在癸丑，暮春之初。",
  "0123456789 !?&@#%*()[]{} “quotes” ‘single’ — … $€£¥",
].join("\n");

/** The sizes the sample is shown at, in CSS pixels (before the zoom). */
export const SAMPLE_SIZES = [72, 48, 32, 20, 14] as const;

/** Glyphs per page of the grid. */
export const GLYPH_PAGE = 256;

const BLANK = /^[\s​-‍⁠﻿]$/u;

function blank(ch: string): boolean {
  return BLANK.test(ch);
}

/** The text split into runs the font has and runs it lacks (white space
 *  never counts as missing: it is not drawn). */
export function coverageRuns(text: string, has: Has): { text: string; missing: boolean }[] {
  const runs: { text: string; missing: boolean }[] = [];
  for (const ch of text) {
    const missing = !blank(ch) && !has(ch.codePointAt(0) as number);
    const last = runs[runs.length - 1];
    if (last && last.missing === missing) last.text += ch;
    else runs.push({ text: ch, missing });
  }
  return runs;
}

/** The characters of text the font lacks, each once, in order. */
export function missingChars(text: string, has: Has): string[] {
  const seen = new Set<string>();
  for (const ch of text) if (!blank(ch) && !has(ch.codePointAt(0) as number)) seen.add(ch);
  return [...seen];
}

export function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

// --- coverage of a few scripts ---------------------------------------------------

function range(start: number, end: number, skip: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let c = start; c <= end; c++) if (!skip.includes(c)) out.push(c);
  return out;
}

function vietnamese(): number[] {
  const out = new Set<number>();
  for (const base of "aăâeêioôơuưy") {
    for (const tone of ["", "̀", "́", "̉", "̃", "̣"]) {
      const lower = (base + tone).normalize("NFC");
      out.add(lower.codePointAt(0) as number);
      out.add(lower.toUpperCase().codePointAt(0) as number);
    }
  }
  out.add(0x0111).add(0x0110);
  return [...out].sort((a, b) => a - b);
}

function codePoints(text: string): number[] {
  return [...text].map((ch) => ch.codePointAt(0) as number);
}

export interface Script {
  readonly name: string;
  readonly chars: readonly number[];
  /** What is checked when coverage is measured by drawing (a few hundred
   *  probes, not twenty thousand). */
  readonly probe?: readonly number[];
}

/** The scripts the header reports, each by the letters it needs. */
export const SCRIPTS: readonly Script[] = [
  { name: "Latin", chars: [...range(0x41, 0x5a), ...range(0x61, 0x7a)] },
  { name: "Latin-1", chars: range(0xc0, 0xff, [0xd7, 0xf7]) },
  { name: "Vietnamese", chars: vietnamese() },
  { name: "Greek", chars: [...range(0x391, 0x3a9, [0x3a2]), ...range(0x3b1, 0x3c9)] },
  { name: "Cyrillic", chars: range(0x410, 0x44f) },
  {
    name: "CJK",
    chars: range(0x4e00, 0x9fff),
    probe: codePoints("的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长"),
  },
];

export interface ScriptCoverage {
  readonly name: string;
  readonly covered: number;
  readonly total: number;
}

/** How much of each script the font covers; approximate (coverage measured
 *  by drawing) checks each script's probe set. */
export function scriptCoverage(has: Has, approximate = false): ScriptCoverage[] {
  return SCRIPTS.map((s) => {
    const chars = approximate && s.probe ? s.probe : s.chars;
    let covered = 0;
    for (const c of chars) if (has(c)) covered++;
    return { name: s.name, covered, total: chars.length };
  });
}

/** "full", "partial" or "none". */
export function coverageLevel(c: ScriptCoverage): "full" | "partial" | "none" {
  return c.covered === 0 ? "none" : c.covered === c.total ? "full" : "partial";
}

/** The characters to look for when the font's character map cannot be read
 *  (and drawing tells): the scripts above without CJK, digits, punctuation. */
export function probeCandidates(): number[] {
  const set = new Set<number>([...range(0x21, 0x7e), ...range(0xa1, 0xff), ...range(0x100, 0x17f), ...range(0x2010, 0x2026), 0x20ac]);
  for (const s of SCRIPTS) if (!s.probe) for (const c of s.chars) set.add(c);
  return [...set].sort((a, b) => a - b);
}

// --- variation axes -----------------------------------------------------------------

function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** The font-variation-settings for the axes at values ("normal" with no
 *  axes): `"wght" 650, "wdth" 87.5`. */
export function variationSettings(axes: readonly Axis[], values: readonly number[]): string {
  if (axes.length === 0) return "normal";
  return axes.map((a, i) => `"${a.tag}" ${num(values[i] ?? a.def)}`).join(", ");
}

/** The settings as a member reads them: "wght 650, wdth 87.5" ("" with no
 *  axes). */
export function settingsText(axes: readonly Axis[], values: readonly number[]): string {
  return axes.map((a, i) => `${a.tag.trim()} ${num(values[i] ?? a.def)}`).join(", ");
}

/** A slider's step: whole units on a wide axis, finer on a narrow one. */
export function axisStep(axis: Axis): number {
  const span = axis.max - axis.min;
  return span >= 100 ? 1 : span >= 10 ? 0.1 : 0.01;
}

/** A value kept on its axis. */
export function clampAxis(axis: Axis, value: number): number {
  return Math.min(axis.max, Math.max(axis.min, value));
}

/** The named instance the values are at, if any. */
export function instanceAt(instances: readonly Instance[], values: readonly number[]): Instance | null {
  return instances.find((i) => i.coordinates.every((c, a) => Math.abs(c - (values[a] ?? c)) < 0.005)) ?? null;
}

// --- the glyph grid -----------------------------------------------------------------

/** The code points the grid shows, in order: every mapped one except
 *  control characters. */
export function gridCodePoints(cmap: ReadonlyMap<number, number>): number[] {
  return [...cmap.keys()].filter((c) => !(c < 0x20 || (c >= 0x7f && c < 0xa0))).sort((a, b) => a - b);
}

/** One page of the grid: its index clamped, the slice bounds and the
 *  page count. */
export function gridPage(total: number, page: number, size = GLYPH_PAGE): { page: number; from: number; to: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages - 1, Math.max(0, Math.floor(page)));
  return { page: p, from: p * size, to: Math.min(total, (p + 1) * size), pages };
}

// --- pointing (the Ask AI panel) ------------------------------------------------------

/** How a glyph is quoted: the character, or its name when it draws
 *  nothing. */
function quoted(cp: number): string {
  const ch = String.fromCodePoint(cp);
  return blank(ch) ? (cp === 0x20 ? "space" : codePointLabel(cp)) : `'${ch}'`;
}

/** The chip a click on a glyph shows: "Glyph 'A' U+0041 in Montserrat". */
export function glyphLabel(cp: number, family: string): string {
  return `Glyph ${quoted(cp)} ${codePointLabel(cp)} in ${family}`;
}

export interface GlyphPick {
  readonly cp: number;
  readonly glyphId: number | null;
  readonly family: string;
  readonly style: string;
  readonly fileName: string;
  /** The axis settings as read ("wght 650"), "" with none. */
  readonly settings: string;
}

/** What a picked glyph tells the agent. */
export function glyphDetail(p: GlyphPick): string {
  return [
    `Glyph ${quoted(p.cp)} ${codePointLabel(p.cp)} in ${[p.family, p.style].filter(Boolean).join(" ")}`,
    p.glyphId !== null ? `Glyph id: ${p.glyphId}` : "",
    `File: ${p.fileName}`,
    p.settings ? `Variation: ${p.settings}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Where a sample row is: "48 px sample in Montserrat". */
export function sampleWhere(size: number, family: string): string {
  return `${size} px sample in ${family}`;
}

export interface SamplePick {
  readonly size: number;
  readonly text: string;
  readonly family: string;
  readonly style: string;
  readonly fileName: string;
  readonly settings: string;
  readonly missing: readonly string[];
}

/** What a picked sample row tells the agent: the text, at what size and
 *  settings, and the characters the font lacks in it. */
export function sampleDetail(p: SamplePick): string {
  const font = [p.family, p.style].filter(Boolean).join(" ");
  const lines = [`Sample text at ${p.size} px in ${font}${p.settings ? ` (${p.settings})` : ""}, file ${p.fileName}:`, p.text];
  if (p.missing.length > 0) {
    const shown = p.missing.slice(0, 40);
    lines.push(`Not in this font (${p.missing.length}): ${shown.map((ch) => `${ch} ${codePointLabel(ch.codePointAt(0) as number)}`).join(", ")}${p.missing.length > shown.length ? ", …" : ""}`);
  }
  return lines.join("\n");
}

// --- the header and the cover ------------------------------------------------------------

const FORMAT_NAMES: Record<FontInfo["format"], string> = { ttf: "TrueType", otf: "OpenType", woff: "WOFF", woff2: "WOFF2" };

function count(n: number): string {
  return n.toLocaleString("en-US");
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 104.8576)) / 10} MB`;
}

/** The font's facts as label/value pairs, empty ones left out. */
export function fontFacts(info: FontInfo, sizeBytes: number): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  const add = (label: string, value: string) => {
    if (value) facts.push({ label, value });
  };
  add("Designer", info.designer);
  add("Foundry", info.manufacturer && info.manufacturer !== info.designer ? info.manufacturer : "");
  add("Version", info.version.replace(/^Version\s+/i, ""));
  add("License", info.license);
  add("License URL", info.licenseUrl);
  if (info.glyphCount !== null) {
    const mapped = info.cmap ? `, ${count(info.cmap.size)} characters` : "";
    add("Glyphs", `${count(info.glyphCount)}${mapped}`);
  }
  add("Axes", info.axes.map((a) => `${a.tag.trim()} ${num(a.min)}–${num(a.max)}`).join(", "));
  add("Format", `${FORMAT_NAMES[info.format]}, ${info.outlines}, ${bytesText(sizeBytes)}`);
  return facts;
}

/** What the cover draws large: "Aa", or the first pair the font has. */
export function coverSample(has: Has, cmap: ReadonlyMap<number, number> | null): string {
  for (const pair of ["Aa", "永字", "あア", "가나", "Жж", "Ωω", "12"]) if ([...pair].every((ch) => has(ch.codePointAt(0) as number))) return pair;
  const first = cmap ? gridCodePoints(cmap).filter((c) => !blank(String.fromCodePoint(c))).slice(0, 2) : [];
  return first.length > 0 ? String.fromCodePoint(...first) : "Aa";
}

// --- Compare ------------------------------------------------------------------------------

/** The font's facts as Compare units, keyed so two versions line up: the
 *  names, the glyph and character counts, each axis and named instance, and
 *  each script's coverage. A version whose tables cannot be read here
 *  compares by its format and table list. */
export function fontUnits(info: FontInfo, sizeBytes: number): UnitDraft[] {
  const units: UnitDraft[] = [];
  const add = (key: string, label: string, text: string) => {
    if (text) units.push({ key, label, text });
  };
  add("format", "Format", `${FORMAT_NAMES[info.format]}, ${info.outlines}`);
  if (!info.readable) {
    add("tables", "Tables", info.tags.map((t) => t.trim()).join(", "));
    add("size", "Size", bytesText(sizeBytes));
    return units;
  }
  add("family", "Family", info.family);
  add("style", "Style", info.style);
  add("full-name", "Full name", info.fullName);
  add("version", "Version", info.version);
  add("designer", "Designer", info.designer);
  add("foundry", "Foundry", info.manufacturer);
  add("license", "License", info.license);
  add("license-url", "License URL", info.licenseUrl);
  if (info.glyphCount !== null) add("glyphs", "Glyphs", count(info.glyphCount));
  if (info.cmap) add("characters", "Characters", count(info.cmap.size));
  for (const a of info.axes) add(`axis:${a.tag.trim()}`, `Axis ${a.tag.trim()}`, `${a.name} ${num(a.min)}–${num(a.max)}, default ${num(a.def)}`);
  for (const i of info.instances) add(`instance:${i.name}`, `Instance ${i.name}`, settingsText(info.axes, i.coordinates));
  if (info.cmap) {
    const cmap = info.cmap;
    for (const c of scriptCoverage((cp) => cmap.has(cp))) add(`coverage:${c.name}`, `Coverage: ${c.name}`, `${count(c.covered)} of ${count(c.total)}`);
  }
  return units;
}

// Font previewer (bnbloc.previewer.contract/v1).
//
// Shows a .ttf / .otf / .woff / .woff2 file as a specimen: the font is drawn
// by the browser from the transferred bytes (new FontFace(family,
// ArrayBuffer): no fetch, so the frame's CSP — connect-src 'none', font-src
// limited to the bundle — has nothing to refuse); its names, glyph count,
// character map and variation axes come from the font's own tables
// (src/sfnt.ts). The header names the family, style, version, designer,
// foundry and license and how much of a few scripts the font covers; an
// editable sample is shown at several sizes with the characters the font
// lacks marked; a variable font gets a slider per axis and its named
// instances; a paged grid lists the glyphs by code point. A click on a
// glyph or a sample row, or text selected in a sample, points the Ask AI
// panel at it (lib/selection.ts); Compare reads the font's facts
// (fontUnits); the cover is "Aa" and the family name, drawn in the font.

import {
  onFile,
  onInit,
  onToolbar,
  onUnits,
  provideThumbnail,
  reportError,
  setTitle,
  setToolbar,
  TITLE_LIMIT,
  type PreviewFile,
  type ToolbarItem,
} from "@bnbloc/previewer-sdk";
import { renderCover } from "@bnbloc/previewer-sdk/cover";
import { quotedLabel, watchPointing } from "../../lib/selection.ts";
import { describeFont, readFont, sniffFont, type FontInfo } from "./sfnt.ts";
import {
  DEFAULT_SAMPLE,
  SAMPLE_SIZES,
  axisStep,
  clampAxis,
  codePointLabel,
  coverageLevel,
  coverageRuns,
  coverSample,
  fontFacts,
  fontUnits,
  glyphDetail,
  glyphLabel,
  gridCodePoints,
  gridPage,
  instanceAt,
  missingChars,
  probeCandidates,
  sampleDetail,
  sampleWhere,
  scriptCoverage,
  settingsText,
  variationSettings,
  type Has,
} from "./specimen.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pageEl = $("page");
const familyEl = $("family");
const subtitleEl = $("subtitle");
const factsEl = $("facts");
const coverageEl = $("coverage");
const noteEl = $("note");
const axesEl = $("axes");
const slidersEl = $("sliders");
const instancesEl = $("instances");
const sampleEl = $<HTMLTextAreaElement>("sample");
const missingEl = $("missing");
const rowsEl = $("rows");
const glyphsEl = $("glyphs");
const rangeEl = $("glyph-range");
const pageLabelEl = $("page-label");
const prevEl = $<HTMLButtonElement>("prev");
const nextEl = $<HTMLButtonElement>("next");
const gridEl = $("grid");
const statusEl = $("status");

const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

let fileName = "";
let sizeBytes = 0;
let info: FontInfo | null = null;
let face: FontFace | null = null;
let faceFamily = "";
let has: Has = () => false;
let approximate = false;
let values: number[] = [];
let sample = DEFAULT_SAMPLE;
let scale = 1;
let page = 0;
let glyphs: number[] = [];
let loadNo = 0;
let coverSent = false;

// --- toolbar ------------------------------------------------------------------

function toolbarItems(): ToolbarItem[] {
  return [
    { id: "zoom", icon: "zoom-in", label: "Sample size", kind: "zoom", value: scale, disabled: !info },
    { id: "reset", icon: "reload", label: "Reset sample and axes", kind: "button", disabled: !info },
  ];
}

function publishToolbar(): void {
  setToolbar(toolbarItems());
}

// --- helpers --------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showStatus(message: string, error = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", error);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortName(name: string, room: number): string {
  const chars = [...name];
  return chars.length <= room ? name : `${chars.slice(0, room - 1).join("")}…`;
}

/** The family a member reads: the font's own, else the file's name. */
function familyName(): string {
  return info?.family || fileName.replace(/\.(ttf|otf|woff2?)$/i, "");
}

function styleName(): string {
  return info?.style ?? "";
}

function currentSettings(): string {
  return info ? settingsText(info.axes, values) : "";
}

// --- drawing the font ------------------------------------------------------------------

/** FontFace descriptors from the axes: a weight or width range lets the
 *  browser use the axis instead of faking bold or stretch. */
function descriptors(font: FontInfo | null): FontFaceDescriptors {
  const out: FontFaceDescriptors = {};
  const wght = font?.axes.find((a) => a.tag === "wght");
  const wdth = font?.axes.find((a) => a.tag === "wdth");
  if (wght) out.weight = `${Math.max(1, Math.min(1000, wght.min))} ${Math.max(1, Math.min(1000, wght.max))}`;
  if (wdth && wdth.min > 0) out.stretch = `${wdth.min}% ${wdth.max}%`;
  return out;
}

async function loadFace(family: string, bytes: ArrayBuffer, font: FontInfo | null): Promise<FontFace> {
  let next: FontFace;
  try {
    next = new FontFace(family, bytes, descriptors(font));
  } catch {
    next = new FontFace(family, bytes);
  }
  await next.load();
  return next;
}

/** Whether the face has a character, by drawing (when its character map
 *  cannot be read): the character measures the same whatever the
 *  fallback, and unlike the fallback alone. Approximate: a glyph exactly
 *  as wide as both fallbacks' reads as missing. */
function drawingProbe(family: string): Has {
  const ctx = document.createElement("canvas").getContext("2d");
  const cache = new Map<number, boolean>();
  return (cp) => {
    const known = cache.get(cp);
    if (known !== undefined) return known;
    if (!ctx) return false;
    const ch = String.fromCodePoint(cp);
    const width = (font: string) => {
      ctx.font = font;
      return ctx.measureText(ch).width;
    };
    const a = width(`40px "${family}", monospace`);
    const b = width(`40px "${family}", serif`);
    const found = a > 0 && a === b && (a !== width("40px monospace") || b !== width("40px serif"));
    cache.set(cp, found);
    return found;
  };
}

function applyVariation(): void {
  const root = document.documentElement.style;
  root.setProperty("--fvs", info ? variationSettings(info.axes, values) : "normal");
  if (!info) return;
  for (const input of slidersEl.querySelectorAll<HTMLInputElement>("input[type=range]")) {
    const i = Number(input.dataset.axis);
    input.value = String(values[i]);
    const out = input.parentElement?.querySelector("output");
    if (out) out.textContent = String(Math.round(values[i] * 100) / 100);
  }
  const at = instanceAt(info.instances, values);
  for (const b of instancesEl.querySelectorAll<HTMLButtonElement>("button")) {
    const on = at !== null && b.textContent === at.name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
}

function applyScale(): void {
  document.documentElement.style.setProperty("--scale", String(scale));
}

// --- header ------------------------------------------------------------------------------

function renderHeader(font: FontInfo, notes: readonly string[]): void {
  familyEl.textContent = familyName();
  const sub = [styleName(), font.variable ? "variable font" : ""].filter(Boolean).join(" · ");
  subtitleEl.textContent = sub;
  factsEl.replaceChildren(
    ...fontFacts(font, sizeBytes).flatMap((f) => {
      const dd = el("dd", "", f.value);
      if (f.label === "License") dd.classList.add("license");
      return [el("dt", "", f.label), dd];
    }),
  );
  const cover = scriptCoverage(has, approximate);
  coverageEl.replaceChildren(
    ...cover.map((c) => {
      const li = el("li", coverageLevel(c));
      li.append(el("span", "script", c.name), el("span", "count", `${c.covered.toLocaleString("en-US")}/${c.total.toLocaleString("en-US")}`));
      li.title = approximate
        ? `${c.name}: ${c.covered} of ${c.total} checked characters found by drawing (approximate)`
        : `${c.name}: ${c.covered} of ${c.total} characters in this font`;
      return li;
    }),
  );
  noteEl.textContent = notes.join(" ");
  noteEl.hidden = notes.length === 0;
}

function renderAxes(font: FontInfo): void {
  const shown = font.axes.map((a, i) => ({ a, i })).filter(({ a }) => !a.hidden);
  axesEl.hidden = shown.length === 0;
  slidersEl.replaceChildren(
    ...shown.map(({ a, i }) => {
      const label = el("label", "axis");
      const name = el("span", "axis-name", a.name);
      name.append(" ", el("code", "", a.tag.trim()));
      const input = el("input");
      input.type = "range";
      input.min = String(a.min);
      input.max = String(a.max);
      input.step = String(axisStep(a));
      input.value = String(values[i]);
      input.dataset.axis = String(i);
      input.addEventListener("input", () => {
        values[i] = clampAxis(a, Number(input.value));
        applyVariation();
      });
      label.append(name, input, el("output", "", String(values[i])), el("span", "axis-range", `${a.min}–${a.max}`));
      return label;
    }),
  );
  instancesEl.replaceChildren(
    ...font.instances.map((inst) => {
      const b = el("button", "instance", inst.name);
      b.type = "button";
      b.title = settingsText(font.axes, inst.coordinates);
      b.addEventListener("click", () => {
        values = font.axes.map((a, i) => clampAxis(a, inst.coordinates[i] ?? a.def));
        applyVariation();
      });
      return b;
    }),
  );
  instancesEl.hidden = font.instances.length === 0;
}

// --- specimen -------------------------------------------------------------------------------

let rowsQueued = false;
function scheduleRows(): void {
  if (rowsQueued) return;
  rowsQueued = true;
  requestAnimationFrame(() => {
    rowsQueued = false;
    renderRows();
  });
}

function renderRows(): void {
  pointing.reset();
  const missing = missingChars(sample, has);
  missingEl.hidden = missing.length === 0;
  if (missing.length > 0) {
    const shown = missing.slice(0, 60);
    missingEl.textContent = `Not in this font (${missing.length}${approximate ? ", by drawing" : ""}): ${shown.join(" ")}${missing.length > shown.length ? " …" : ""} — marked below, drawn in a fallback font.`;
  }
  const runs = coverageRuns(sample, has);
  rowsEl.replaceChildren(
    ...SAMPLE_SIZES.map((size) => {
      const row = el("div", "sample-row");
      row.dataset.size = String(size);
      const text = el("div", "sample-text face");
      text.style.fontSize = `calc(${size}px * var(--scale))`;
      for (const r of runs) {
        if (!r.missing) {
          text.append(r.text);
          continue;
        }
        const mark = el("mark", "missing", r.text);
        mark.title = `Not in this font: ${[...r.text].map((ch) => codePointLabel(ch.codePointAt(0) as number)).join(" ")}`;
        text.append(mark);
      }
      row.append(el("span", "size", `${size} px`), text);
      return row;
    }),
  );
}

sampleEl.addEventListener("input", () => {
  sample = sampleEl.value;
  scheduleRows();
});

// --- glyph grid -------------------------------------------------------------------------------

function renderGrid(): void {
  glyphsEl.hidden = glyphs.length === 0;
  const p = gridPage(glyphs.length, page);
  page = p.page;
  rangeEl.textContent = glyphs.length === 0 ? "" : `${(p.from + 1).toLocaleString("en-US")}–${p.to.toLocaleString("en-US")} of ${glyphs.length.toLocaleString("en-US")}${approximate ? " found by drawing" : ""}`;
  pageLabelEl.textContent = `Page ${p.page + 1} of ${p.pages}`;
  prevEl.disabled = p.page === 0;
  nextEl.disabled = p.page >= p.pages - 1;
  (prevEl.parentElement as HTMLElement).hidden = p.pages <= 1;
  gridEl.replaceChildren(
    ...glyphs.slice(p.from, p.to).map((cp) => {
      const cell = el("div", "glyph");
      cell.dataset.cp = String(cp);
      cell.title = codePointLabel(cp);
      cell.append(el("span", "ch face", String.fromCodePoint(cp)), el("span", "cp", codePointLabel(cp).slice(2)));
      return cell;
    }),
  );
}

function turnPage(delta: number): void {
  pointing.reset();
  page += delta;
  renderGrid();
  glyphsEl.scrollIntoView({ block: "start" });
}

prevEl.addEventListener("click", () => turnPage(-1));
nextEl.addEventListener("click", () => turnPage(1));

// --- pointing ------------------------------------------------------------------------------------

const pointing = watchPointing(
  pageEl,
  (target) => {
    if (!info) return null;
    const cell = target.closest<HTMLElement>(".glyph");
    if (cell && gridEl.contains(cell)) {
      const cp = Number(cell.dataset.cp);
      const glyphId = info.cmap?.get(cp) ?? null;
      return {
        element: cell,
        where: "Glyph",
        text: glyphDetail({ cp, glyphId, family: familyName(), style: styleName(), fileName, settings: currentSettings() }),
        label: glyphLabel(cp, familyName()),
        kind: "block",
      };
    }
    const row = target.closest<HTMLElement>(".sample-row");
    if (row && rowsEl.contains(row)) {
      const size = Number(row.dataset.size);
      const where = sampleWhere(size, familyName());
      return {
        element: row,
        where,
        text: sampleDetail({ size, text: sample, family: familyName(), style: styleName(), fileName, settings: currentSettings(), missing: missingChars(sample, has) }),
        label: quotedLabel(where, sample),
        kind: "block",
      };
    }
    return null;
  },
  { ignore: "textarea, input, button, label, nav, #axes" },
);

// --- cover ---------------------------------------------------------------------------------------

/** The file's card picture: "Aa" (or the first pair the font has) and the
 *  family name, drawn in the font on paper; sent once per file. */
async function sendCover(font: FontInfo, family: string): Promise<void> {
  if (coverSent) return;
  coverSent = true;
  const pair = coverSample(has, font.cmap);
  const name = familyName();
  const meta = [styleName(), font.variable ? "variable" : "", font.glyphCount !== null ? `${font.glyphCount.toLocaleString("en-US")} glyphs` : ""].filter(Boolean).join(" · ");
  try {
    const png = await renderCover((ctx, w) => {
      const room = w - 56;
      ctx.fillStyle = "#2b2b29";
      ctx.textBaseline = "alphabetic";
      let size = 132;
      ctx.font = `${size}px "${family}"`;
      const wide = ctx.measureText(pair).width;
      if (wide > room) {
        size = Math.max(24, Math.floor((size * room) / wide));
        ctx.font = `${size}px "${family}"`;
      }
      ctx.fillText(pair, 28, 168);
      ctx.font = `30px "${family}", system-ui, sans-serif`;
      ctx.fillText(name, 28, 222, room);
      ctx.fillStyle = "#9a9a94";
      ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
      if (meta) ctx.fillText(meta, 28, 256, room);
    });
    await provideThumbnail(png);
  } catch {
    // no cover
  }
}

// --- intake ------------------------------------------------------------------------------------------

/** A stand-in when the tables do not parse but the browser draws the font. */
function unreadInfo(bytes: ArrayBuffer, reason: string): FontInfo {
  const sniffed = sniffFont(bytes);
  const format = sniffed === "otf" || sniffed === "woff" || sniffed === "woff2" ? sniffed : "ttf";
  return {
    format,
    outlines: "outlines unknown",
    tags: [],
    readable: false,
    note: `The font's tables could not be read (${reason}).`,
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
    variable: false,
    axes: [],
    instances: [],
  };
}

function clearView(): void {
  pointing.reset();
  info = null;
  values = [];
  glyphs = [];
  page = 0;
  coverSent = false;
  approximate = false;
  has = () => false;
  familyEl.textContent = "";
  subtitleEl.textContent = "";
  factsEl.replaceChildren();
  coverageEl.replaceChildren();
  noteEl.hidden = true;
  axesEl.hidden = true;
  rowsEl.replaceChildren();
  missingEl.hidden = true;
  gridEl.replaceChildren();
  glyphsEl.hidden = true;
  pageEl.hidden = true;
}

async function show(bytes: ArrayBuffer, file: PreviewFile): Promise<void> {
  const no = ++loadNo;
  clearView();
  fileName = file.name;
  sizeBytes = bytes.byteLength;
  showStatus(`Reading ${file.name}…`);

  let parsed: FontInfo | null = null;
  let parseError = "";
  try {
    parsed = describeFont(await readFont(bytes));
  } catch (err) {
    parseError = messageOf(err);
  }
  if (no !== loadNo) return;

  const family = `bnbloc-font-${no}`;
  let loaded: FontFace | null = null;
  let loadError = "";
  try {
    loaded = await loadFace(family, bytes, parsed);
  } catch (err) {
    loadError = messageOf(err) || "the browser refused it";
  }
  if (no !== loadNo) return;

  if (!parsed && !loaded) {
    const message = `${file.name} could not be read as a font: ${parseError}.`;
    showStatus(message, true);
    reportError(message);
    publishToolbar();
    return;
  }
  if (face) document.fonts.delete(face);
  face = loaded;
  if (loaded) document.fonts.add(loaded);
  faceFamily = loaded ? family : "";
  document.documentElement.style.setProperty("--face", loaded ? `"${family}"` : "system-ui");

  const font = parsed ?? unreadInfo(bytes, parseError);
  info = font;
  const cmap = font.cmap;
  if (cmap) has = (cp) => cmap.has(cp);
  else if (loaded) {
    has = drawingProbe(family);
    approximate = true;
  }
  values = font.axes.map((a) => a.def);
  glyphs = cmap ? gridCodePoints(cmap) : approximate ? probeCandidates().filter(has) : [];

  const notes = [font.note];
  if (approximate) notes.push("Coverage and the glyph list are found by drawing the common characters, so they are approximate.");
  if (!loaded) notes.push(`The browser could not load this font (${loadError}), so the samples are in a fallback font.`);
  if (glyphs.length > 0 && cmap && font.glyphCount !== null && font.glyphCount > cmap.size + 1) {
    notes.push(`${(font.glyphCount - cmap.size).toLocaleString("en-US")} glyphs have no character of their own (alternates, ligatures) and are not in the grid.`);
  }

  renderHeader(font, notes.filter(Boolean));
  renderAxes(font);
  applyVariation();
  applyScale();
  sampleEl.value = sample;
  renderRows();
  renderGrid();
  pageEl.hidden = false;
  showStatus("");
  const named = [familyName(), styleName()].filter(Boolean).join(" ");
  setTitle(shortName(`${shortName(file.name, 70)} — ${named}`, TITLE_LIMIT));
  publishToolbar();
  if (loaded) void sendCover(font, faceFamily);
}

onInit((init) => {
  document.documentElement.dataset.theme = init.theme === "dark" ? "dark" : "light";
  showStatus(`Loading ${init.file.name}…`);
  publishToolbar();
});

onFile((bytes, file) => {
  show(bytes, file).catch((err) => {
    const message = messageOf(err);
    showStatus(message, true);
    reportError(message);
  });
});

onToolbar((id, value) => {
  if (!info) return;
  if (id === "zoom" && typeof value === "number") {
    scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));
    applyScale();
  } else if (id === "reset") {
    scale = 1;
    sample = DEFAULT_SAMPLE;
    sampleEl.value = sample;
    values = info.axes.map((a) => a.def);
    applyScale();
    applyVariation();
    renderRows();
  } else return;
  publishToolbar();
});

// Compare reads a version into its facts (capability "units").
onUnits(async (bytes) => fontUnits(describeFont(await readFont(bytes)), bytes.byteLength));

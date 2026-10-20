// node --test font/build.test.mjs
// Builds the font previewer into a temp dir and checks the bundle the way the
// gateway and desktop will read it (../lib/bundle-check.mjs), then the font
// reader (src/sfnt.ts) on the generated sample font in all three containers,
// and the specimen helpers (src/specimen.ts): coverage marking, the
// variation settings, what a click names, the Compare units.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "./build.mjs";
import { assertBundle } from "../lib/bundle-check.mjs";
import { sampleTables, sampleTtf } from "./samples/generate.mjs";
import { UnsupportedCompression, describeFont, nameOf, parseCmapSubtable, readFont, sniffFont } from "./src/sfnt.ts";
import {
  DEFAULT_SAMPLE,
  axisStep,
  codePointLabel,
  coverSample,
  coverageLevel,
  coverageRuns,
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
} from "./src/specimen.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function sample(name) {
  const buf = await readFile(join(HERE, "samples", name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("the build produces a deterministic, parseable bundle without third-party code", async () => {
  const outA = await mkdtemp(join(tmpdir(), "font-a-"));
  const outB = await mkdtemp(join(tmpdir(), "font-b-"));
  try {
    const { pkg } = await assertBundle(await build({ outDir: outA, quiet: true }), await build({ outDir: outB, quiet: true }), {
      files: ["index.html", "main.js", "style.css"],
      toolbar: ["zoom", "reset"],
    });
    assert.equal(pkg.version, "0.1.0");
    assert.deepEqual(pkg.previewer.match.extensions, [".ttf", ".otf", ".woff", ".woff2"]);
    assert.deepEqual(pkg.previewer.match.mimeTypes, ["font/ttf", "font/otf", "font/woff", "font/woff2"]);
    assert.deepEqual(pkg.previewer.capabilities, ["thumbnail", "toolbar", "selection", "units"]);
  } finally {
    await rm(outA, { recursive: true, force: true });
    await rm(outB, { recursive: true, force: true });
  }
});

test("the committed sample font is the generator's, and small", async () => {
  const ttf = Buffer.from(await sample("sample.ttf"));
  assert.ok(ttf.equals(sampleTtf()), "samples/generate.mjs regenerates sample.ttf byte for byte");
  for (const name of ["sample.ttf", "sample.woff", "sample.woff2"]) assert.ok((await sample(name)).byteLength <= 4096, `${name} stays small`);
});

test("sniffFont tells the containers apart; readFont refuses what is not a font", async () => {
  assert.equal(sniffFont(await sample("sample.ttf")), "ttf");
  assert.equal(sniffFont(await sample("sample.woff")), "woff");
  assert.equal(sniffFont(await sample("sample.woff2")), "woff2");
  const head = (tag) => new Uint8Array([...Buffer.from(tag, "latin1"), ...new Array(12).fill(0)]).buffer;
  assert.equal(sniffFont(head("OTTO")), "otf");
  assert.equal(sniffFont(head("ttcf")), "collection");
  assert.equal(sniffFont(new TextEncoder().encode("hello, this is text").buffer), null);
  await assert.rejects(readFont(new TextEncoder().encode("hello, this is text").buffer), /not a TrueType, OpenType, WOFF or WOFF2 font/);
  await assert.rejects(readFont(head("ttcf")), /collections/);
  const cut = (await sample("sample.ttf")).slice(0, 400);
  await assert.rejects(readFont(cut), /runs past the end|truncated/);
});

test("the name, maxp, fvar and cmap tables read the same from .ttf, .woff and .woff2", async () => {
  for (const name of ["sample.ttf", "sample.woff", "sample.woff2"]) {
    const info = describeFont(await readFont(await sample(name)));
    assert.equal(info.readable, true, name);
    assert.equal(info.family, "Bnbloc Sample", name);
    assert.equal(info.style, "Regular");
    assert.equal(info.fullName, "Bnbloc Sample Regular");
    assert.equal(info.version, "Version 0.100");
    assert.equal(info.postscriptName, "BnblocSample-Regular");
    assert.equal(info.designer, "font/samples/generate.mjs");
    assert.equal(info.manufacturer, "bnbloc-previewers");
    assert.match(info.license, /^Licensed under the Apache License, Version 2\.0/);
    assert.equal(info.licenseUrl, "https://www.apache.org/licenses/LICENSE-2.0");
    assert.equal(info.glyphCount, 6);
    assert.equal(info.outlines, "TrueType outlines");
    assert.equal(info.variable, true);
    assert.deepEqual(info.axes, [{ tag: "wght", name: "Weight", min: 100, def: 400, max: 900, hidden: false }]);
    assert.deepEqual(info.instances, [
      { name: "Thin", coordinates: [100] },
      { name: "Regular", coordinates: [400] },
      { name: "Bold", coordinates: [700] },
      { name: "Black", coordinates: [900] },
    ]);
    assert.equal(info.cmap.size, 74, "space, ! , . ?, 0–9, A–Z, a–z and seven Vietnamese letters");
    assert.equal(info.cmap.get(0x41), 2);
    assert.equal(info.cmap.get(0x7a), 3);
    assert.equal(info.cmap.get(0x0111), 3, "đ");
    assert.equal(info.cmap.has(0x4e2d), false, "no CJK");
  }
});

test("a WOFF2 where Brotli is missing keeps its directory and says why", async () => {
  const unsupported = async (format) => {
    throw new UnsupportedCompression(format);
  };
  const info = describeFont(await readFont(await sample("sample.woff2"), unsupported));
  assert.equal(info.readable, false);
  assert.equal(info.variable, true, "fvar is in the directory");
  assert.equal(info.cmap, null);
  assert.equal(info.family, "");
  assert.match(info.note, /Brotli/);
  assert.deepEqual(info.tags, ["OS/2", "cmap", "fvar", "glyf", "gvar", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"]);
  assert.deepEqual(
    fontUnits(info, 1068).map((u) => u.key),
    ["format", "tables", "size"],
  );
  const corrupt = async () => {
    throw new Error("bad stream");
  };
  await assert.rejects(readFont(await sample("sample.woff2"), corrupt), /could not be unpacked/);
});

test("both cmap subtables (format 4 and format 12) give the same map", () => {
  const cmap = sampleTables().cmap;
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const f4 = parseCmapSubtable(view, view.getUint32(4 + 4));
  const f12 = parseCmapSubtable(view, view.getUint32(4 + 8 + 4));
  assert.equal(view.getUint16(view.getUint32(8)), 4);
  assert.equal(f4.size, 74);
  assert.deepEqual([...f4], [...f12]);
});

test("a name is the Windows English record first, then any other", () => {
  const records = [
    { platformID: 1, encodingID: 0, languageID: 0, nameID: 1, value: "Mac Family" },
    { platformID: 3, encodingID: 1, languageID: 0x407, nameID: 1, value: "German Family" },
    { platformID: 3, encodingID: 1, languageID: 0x409, nameID: 1, value: "Family" },
    { platformID: 1, encodingID: 0, languageID: 0, nameID: 9, value: "Mac Designer" },
  ];
  assert.equal(nameOf(records, 1), "Family");
  assert.equal(nameOf(records.slice(0, 2), 1), "German Family");
  assert.equal(nameOf(records, 9), "Mac Designer");
  assert.equal(nameOf(records, 13), "");
});

test("the characters a font lacks are marked; white space never is", async () => {
  const info = describeFont(await readFont(await sample("sample.ttf")));
  const has = (cp) => info.cmap.has(cp);
  assert.deepEqual(coverageRuns("Ab 中文.", has), [
    { text: "Ab ", missing: false },
    { text: "中文", missing: true },
    { text: ".", missing: false },
  ]);
  assert.deepEqual(coverageRuns("a\n\tb", () => false), [
    { text: "a", missing: true },
    { text: "\n\t", missing: false },
    { text: "b", missing: true },
  ]);
  const missing = missingChars(DEFAULT_SAMPLE, has);
  for (const ch of ["ế", "Đ", "ộ", "中", "永", "：", "@", "€"]) assert.ok(missing.includes(ch), `${ch} is marked`);
  for (const ch of ["T", "q", "0", "ơ", "ư", " "]) assert.ok(!missing.includes(ch), `${ch} is not`);
  assert.equal(new Set(missing).size, missing.length, "each once");

  const cover = Object.fromEntries(scriptCoverage(has).map((c) => [c.name, c]));
  assert.deepEqual(cover.Latin, { name: "Latin", covered: 52, total: 52 });
  assert.equal(coverageLevel(cover.Latin), "full");
  assert.deepEqual([cover.Vietnamese.covered, cover.Vietnamese.total], [19, 146]);
  assert.equal(coverageLevel(cover.Vietnamese), "partial");
  assert.deepEqual([cover.CJK.covered, cover.CJK.total], [0, 20992]);
  assert.equal(coverageLevel(cover.CJK), "none");
  const rough = Object.fromEntries(scriptCoverage(has, true).map((c) => [c.name, c]));
  assert.ok(rough.CJK.total > 50 && rough.CJK.total < 300, "drawing checks a sample of CJK");
  assert.ok(!probeCandidates().some((c) => c >= 0x4e00), "and the glyph list by drawing has no CJK");
});

test("the axis sliders become font-variation-settings", () => {
  const wght = { tag: "wght", name: "Weight", min: 100, def: 400, max: 900, hidden: false };
  const wdth = { tag: "wdth", name: "Width", min: 75, def: 100, max: 125, hidden: false };
  const opsz = { tag: "opsz", name: "Optical size", min: 8, def: 14, max: 14.5, hidden: false };
  assert.equal(variationSettings([wght], [650]), '"wght" 650');
  assert.equal(variationSettings([wght, wdth], [650, 87.5]), '"wght" 650, "wdth" 87.5');
  assert.equal(variationSettings([wght, wdth], [650.1234]), '"wght" 650.12, "wdth" 100', "rounded; a missing value is the default");
  assert.equal(variationSettings([], []), "normal");
  assert.equal(settingsText([wght, wdth], [700, 100]), "wght 700, wdth 100");
  assert.deepEqual([axisStep(wght), axisStep(wdth), axisStep(opsz)], [1, 0.1, 0.01]);
  const instances = [
    { name: "Regular", coordinates: [400] },
    { name: "Bold", coordinates: [700] },
  ];
  assert.equal(instanceAt(instances, [700])?.name, "Bold");
  assert.equal(instanceAt(instances, [650]), null);
});

test("a click on a glyph or a sample names it for the Ask AI panel", () => {
  assert.equal(glyphLabel(0x41, "Montserrat"), "Glyph 'A' U+0041 in Montserrat");
  assert.equal(glyphLabel(0x20, "Montserrat"), "Glyph space U+0020 in Montserrat");
  assert.equal(glyphLabel(0x1f600, "Emoji"), "Glyph '😀' U+1F600 in Emoji");
  assert.equal(codePointLabel(0x4e2d), "U+4E2D");
  assert.equal(
    glyphDetail({ cp: 0x41, glyphId: 36, family: "Montserrat", style: "Regular", fileName: "Montserrat[wght].ttf", settings: "wght 650" }),
    "Glyph 'A' U+0041 in Montserrat Regular\nGlyph id: 36\nFile: Montserrat[wght].ttf\nVariation: wght 650",
  );
  assert.equal(glyphDetail({ cp: 0x61, glyphId: null, family: "X", style: "", fileName: "x.woff2", settings: "" }), "Glyph 'a' U+0061 in X\nFile: x.woff2");
  assert.equal(sampleWhere(48, "Montserrat"), "48 px sample in Montserrat");
  assert.equal(
    sampleDetail({ size: 48, text: "Hi 中文", family: "Montserrat", style: "Regular", fileName: "m.ttf", settings: "wght 700", missing: ["中", "文"] }),
    "Sample text at 48 px in Montserrat Regular (wght 700), file m.ttf:\nHi 中文\nNot in this font (2): 中 U+4E2D, 文 U+6587",
  );
});

test("the glyph grid pages through the mapped characters, controls left out", () => {
  const cmap = new Map([
    [0x09, 1],
    [0x42, 3],
    [0x41, 2],
    [0x85, 4],
    [0xe9, 5],
  ]);
  assert.deepEqual(gridCodePoints(cmap), [0x41, 0x42, 0xe9]);
  assert.deepEqual(gridPage(600, 0), { page: 0, from: 0, to: 256, pages: 3 });
  assert.deepEqual(gridPage(600, 2), { page: 2, from: 512, to: 600, pages: 3 });
  assert.deepEqual(gridPage(600, 9), { page: 2, from: 512, to: 600, pages: 3 }, "clamped");
  assert.deepEqual(gridPage(0, 0), { page: 0, from: 0, to: 0, pages: 1 });
});

test("the header's facts, the cover's sample and the Compare units", async () => {
  const info = describeFont(await readFont(await sample("sample.ttf")));
  const facts = Object.fromEntries(fontFacts(info, 3360).map((f) => [f.label, f.value]));
  assert.equal(facts.Designer, "font/samples/generate.mjs");
  assert.equal(facts.Foundry, "bnbloc-previewers");
  assert.equal(facts.Version, "0.100");
  assert.equal(facts.Glyphs, "6, 74 characters");
  assert.equal(facts.Axes, "wght 100–900");
  assert.equal(facts.Format, "TrueType, TrueType outlines, 3.3 KB");

  assert.equal(coverSample((cp) => info.cmap.has(cp), info.cmap), "Aa");
  assert.equal(coverSample((cp) => cp >= 0x4e00, null), "永字");
  assert.equal(coverSample((cp) => cp === 0xe000 || cp === 0xe001, new Map([[0xe000, 1], [0xe001, 2]])), "");

  const units = fontUnits(info, 3360);
  const byKey = Object.fromEntries(units.map((u) => [u.key, u]));
  assert.equal(byKey.family.text, "Bnbloc Sample");
  assert.equal(byKey.glyphs.text, "6");
  assert.equal(byKey["axis:wght"].text, "Weight 100–900, default 400");
  assert.deepEqual(byKey["instance:Bold"], { key: "instance:Bold", label: "Instance Bold", text: "wght 700" });
  assert.equal(byKey["coverage:Vietnamese"].text, "19 of 146");
  assert.equal(byKey["coverage:CJK"].text, "0 of 20,992");
  assert.equal(new Set(units.map((u) => u.key)).size, units.length, "keys are unique");
});

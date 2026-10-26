// node --test excalidraw/build.test.mjs
// (after `pnpm install --ignore-workspace` in excalidraw/)
// Builds the Excalidraw previewer into temp dirs and checks the bundle the way
// the gateway and desktop will read it (../lib/bundle-check.mjs), then the pure
// model (src/model.ts): the reader, the selection the Ask AI chip carries, and
// the Compare units; and the content packages against the platform's shapes.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "./build.mjs";
import { assertBundle, readTar } from "../lib/bundle-check.mjs";
import { MAX_DRAFT_EDGES, MAX_DRAFT_NODES, MAX_ELEMENTS, draftOrigin, layoutDraft, readDraft, readScene, selectionOf, unitsOf } from "./src/model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const sample = (name) => readFile(join(HERE, "samples", name), "utf8");

const element = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, width: 100, height: 60, isDeleted: false, boundElements: null, ...extra });
const scene = (elements) => JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });

test("the build produces a deterministic, parseable bundle with its notices and its fonts", async () => {
  const outA = await mkdtemp(join(tmpdir(), "excalidraw-a-"));
  const outB = await mkdtemp(join(tmpdir(), "excalidraw-b-"));
  try {
    const a = await build({ outDir: outA, quiet: true });
    const b = await build({ outDir: outB, quiet: true });
    const { files, pkg } = await assertBundle(a, b, {
      files: a.files,
      toolbar: ["zoom", "fit"],
    });
    assert.deepEqual(pkg.previewer.capabilities, ["thumbnail", "toolbar", "selection", "units", "edit", "draft"]);
    assert.deepEqual(pkg.previewer.draft, { task: "draw-diagram" });
    assert.deepEqual(pkg.previewer.match.extensions, [".excalidraw", ".excalidraw.json"]);
    assert.deepEqual(pkg.previewer.match.mimeTypes, ["application/vnd.excalidraw+json"]);

    for (const name of ["index.html", "main.js", "style.css", "excalidraw.css", "NOTICES.txt"]) assert.ok(files.has(name), `${name} is bundled`);
    assert.ok([...files.keys()].some((name) => name.startsWith("fonts/Excalifont/")), "the hand-drawn font is bundled");
    assert.ok(![...files.keys()].some((name) => name.startsWith("fonts/Xiaolai/")), "the Chinese font is left out (12 MB)");

    const notices = files.get("NOTICES.txt").toString("utf8");
    for (const name of ["@excalidraw/excalidraw@0.18.0 — LICENSE", "@radix-ui/primitive@", "react-remove-scroll-bar@"]) {
      assert.ok(notices.includes(name), `${name} attributed`);
    }
    assert.doesNotMatch(files.get("main.js").toString("utf8"), /esm\.sh/, "no CDN font fallback in the bundle");
    assert.doesNotMatch(files.get("index.html").toString("utf8"), /asset-path|https?:\/\//, "the page loads nothing but its own files");
  } finally {
    await rm(outA, { recursive: true, force: true });
    await rm(outB, { recursive: true, force: true });
  }
});

test("the archive stays under the bundle budget", async () => {
  const out = await mkdtemp(join(tmpdir(), "excalidraw-size-"));
  try {
    const { tarPath } = await build({ outDir: out, quiet: true });
    const tar = await readFile(tarPath);
    assert.ok(tar.length < 12 * 1024 * 1024, `archive is ${tar.length} bytes`);
    assert.ok(readTar(tar).size < 512, "at most 512 files");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a file is read as a scene; anything else is refused with a sentence", async () => {
  const s = readScene(await sample("flow.excalidraw"));
  assert.equal(s.elements.length, 7);
  assert.deepEqual(Object.keys(s.files), []);

  assert.throws(() => readScene("{not json"), /not valid JSON/);
  assert.throws(() => readScene(JSON.stringify({ type: "something", elements: [] })), /not an Excalidraw drawing/);
  assert.throws(() => readScene(JSON.stringify({ type: "excalidraw" })), /no elements list/);
  assert.throws(() => readScene(scene([element("a", "rectangle"), { type: "rectangle" }])), /Element 2 has no id or type/);
  const many = Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => element(`e${i}`, "rectangle"));
  assert.throws(() => readScene(scene(many)), /at most 5,000 are shown/);
});

const flow = async () => readScene(await sample("flow.excalidraw"));

test("nothing picked is no selection", async () => {
  assert.equal(selectionOf(await flow(), []), null);
  assert.equal(selectionOf(await flow(), ["missing-id"]), null);
});

test("one picked box names what it is, its text, its id, its connections and where it sits", async () => {
  const sel = selectionOf(await flow(), ["api"]);
  assert.equal(sel.label, "rectangle “API gateway”");
  assert.equal(sel.kind, "block");
  assert.deepEqual(sel.keys, ["api"]);
  assert.match(sel.detail, /^Type: rectangle\nId: api\nText: API gateway\nConnections: to rectangle “Orders DB”\nPosition: x 80, y 120, 180 × 80$/);
});

test("an arrow names both ends it joins", async () => {
  const sel = selectionOf(await flow(), ["arrow-1"]);
  assert.equal(sel.label, "arrow");
  assert.match(sel.detail, /Connections: from rectangle “API gateway”; to rectangle “Orders DB”/);
});

test("several picked elements list their parts; deleted elements are not picked", async () => {
  const s = {
    elements: [element("a", "rectangle"), element("b", "ellipse", { isDeleted: true }), element("c", "diamond")],
    appState: {},
    files: {},
  };
  const sel = selectionOf(s, ["a", "b", "c"]);
  assert.equal(sel.label, "2 elements");
  assert.equal(sel.detail, "- rectangle\n- diamond");
  assert.deepEqual(sel.keys, ["a", "c"]);
});

test("Compare units are the labelled elements and the arrows, keyed by id, and say what is connected", async () => {
  const units = unitsOf(await flow());
  assert.deepEqual(units.map((u) => u.key), ["api", "db", "arrow-1", "note-1"]);
  const byKey = Object.fromEntries(units.map((u) => [u.key, u]));
  assert.equal(byKey.api.label, "rectangle “API gateway”");
  assert.equal(byKey.api.text, "API gateway; to rectangle “Orders DB”");
  assert.equal(byKey["arrow-1"].text, "from rectangle “API gateway”; to rectangle “Orders DB”");
  assert.equal(byKey["note-1"].at, "el:note-1");
});

test("moving an element is not a change of content for Compare", async () => {
  const moved = await flow();
  const moved2 = { ...moved, elements: moved.elements.map((el) => (el.id === "api" ? { ...el, x: 500, y: 40 } : el)) };
  const before = Object.fromEntries(unitsOf(moved).map((u) => [u.key, u.text]));
  const after = Object.fromEntries(unitsOf(moved2).map((u) => [u.key, u.text]));
  assert.deepEqual(after, before);
});

test("the content packages are the platform's shapes", async () => {
  const skill = JSON.parse(await readFile(join(HERE, "content", "excalidraw-skills", "component.json"), "utf8"));
  assert.equal(skill.kind, "bnbloc.skill.package/v1");
  assert.deepEqual(skill.skills, ["excalidraw-diagrams"]);
  const skillText = await readFile(join(HERE, "content", "excalidraw-skills", "excalidraw-diagrams", "SKILL.md"), "utf8");
  assert.match(skillText, /^---\nname: excalidraw-diagrams\n/);

  const prompts = JSON.parse(await readFile(join(HERE, "content", "excalidraw-prompts", "component.json"), "utf8"));
  assert.equal(prompts.kind, "bnbloc.prompt.package/v1");
  for (const p of prompts.prompts) {
    assert.ok(p.files.extensions.includes(".excalidraw"), `${p.id} is for .excalidraw files`);
  }
});

test("the draft task the previewer declares is the assist package it ships", async () => {
  const pkg = JSON.parse(await readFile(join(HERE, "previewer.json"), "utf8"));
  const assist = JSON.parse(await readFile(join(HERE, "content", "draw-diagram", "component.json"), "utf8"));
  assert.equal(assist.kind, "bnbloc.assist.package/v1");
  assert.equal(assist.name, pkg.previewer.draft.task);
  assert.equal(assist.output, "json");
  assert.deepEqual(assist.fields.map((f) => f.name), ["title", "nodes", "edges"]);
});

const reply = (nodes, edges = [], title = "Login") => ({ title, nodes, edges });
const box = (id, label) => ({ id, label });

test("a reply is read into a draft; an arrow that names no box is left out and counted", () => {
  const d = readDraft(reply([box("a", "Enter password"), box("b", "Check")], [{ from: "a", to: "b", label: "submit" }, { from: "b", to: "zz" }]));
  assert.equal(d.title, "Login");
  assert.deepEqual(d.edges, [{ from: "a", to: "b", label: "submit" }]);
  assert.equal(d.dropped, 1);
});

test("a reply that holds no diagram is refused with a sentence", () => {
  assert.throws(() => readDraft("text"), /did not come back as a diagram/);
  assert.throws(() => readDraft(reply([])), /has no boxes/);
  assert.throws(() => readDraft(reply([box("a", "x"), box("a", "y")])), /same id/);
  assert.throws(() => readDraft(reply([{ label: "no id" }])), /no id/);
  const many = Array.from({ length: MAX_DRAFT_NODES + 1 }, (_, i) => box(`n${i}`, `box ${i}`));
  assert.throws(() => readDraft(reply(many)), /at most 30 are drawn/);
});

test("arrows past the limit are counted, and labels are cut", () => {
  const nodes = [box("a", "a".repeat(200)), box("b", "b")];
  const edges = Array.from({ length: MAX_DRAFT_EDGES + 3 }, () => ({ from: "a", to: "b" }));
  const d = readDraft(reply(nodes, edges));
  assert.equal(d.edges.length, MAX_DRAFT_EDGES);
  assert.equal(d.dropped, 3);
  assert.ok(d.nodes[0].label.length <= 60);
});

test("a draft goes to the right of what the drawing holds, or at the origin when it is empty", async () => {
  assert.deepEqual(draftOrigin([]), { x: 0, y: 0 });
  const s = await flow();
  // flow.excalidraw's right edge is the note box at x 80 + 260 wide, and the boxes at 420 + 180 = 600.
  assert.deepEqual(draftOrigin(s.elements), { x: 760, y: 120 });
});

test("a draft lays out in columns by arrow depth, and a loop still places every box", () => {
  const d = readDraft(reply([box("a", "Start"), box("b", "Middle"), box("c", "End")], [{ from: "a", to: "b" }, { from: "b", to: "c" }]));
  const skeletons = layoutDraft(d, { x: 0, y: 0 });
  const boxes = Object.fromEntries(skeletons.filter((k) => k.type === "rectangle").map((k) => [k.id, k]));
  assert.ok(boxes["n-a"].x < boxes["n-b"].x && boxes["n-b"].x < boxes["n-c"].x, "columns follow the chain");
  const arrow = skeletons.find((k) => k.type === "arrow");
  assert.deepEqual(arrow.start, { id: "n-a" });
  assert.deepEqual(arrow.end, { id: "n-b" });

  const loop = readDraft(reply([box("a", "x"), box("b", "y")], [{ from: "a", to: "b" }, { from: "b", to: "a" }]));
  const placed = layoutDraft(loop, { x: 0, y: 0 }).filter((k) => k.type === "rectangle");
  assert.equal(placed.length, 2, "both boxes placed");
});

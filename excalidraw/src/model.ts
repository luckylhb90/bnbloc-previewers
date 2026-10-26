// The Excalidraw scene file (.excalidraw, a JSON document): the reader, and
// the two things the host asks of the file beside its drawing: what a member
// points at (the Ask AI chip and the detail the agent reads) and the Compare
// units (one per labelled element, keyed by its id). Pure: no DOM, no React,
// so it is unit-tested under node (build.test.mjs).

import {
  SELECTION_DETAIL_LIMIT,
  SELECTION_KEYS_LIMIT,
  SELECTION_LABEL_LIMIT,
  UNITS_LIMIT,
  UNIT_LABEL_LIMIT,
  UNIT_TEXT_LIMIT,
  type Selection,
  type Unit,
} from "@bnbloc/previewer-sdk/protocol";

/** Elements a file may hold before the reader refuses it (a scene this big is
 *  not something a member reads in a frame). */
export const MAX_ELEMENTS = 5000;
/** The most elements a selection names in its detail. */
const SELECTION_ITEMS = 30;

/** The fields of an Excalidraw element this viewer reads; the rest is kept as
 *  the editor wrote it (the file is saved from the editor, not from here). */
export interface SceneElement {
  readonly id: string;
  readonly type: string;
  readonly isDeleted?: boolean;
  readonly text?: string;
  /** The shape a label sits in (a text element inside a box or an arrow). */
  readonly containerId?: string | null;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null;
  readonly startBinding?: { readonly elementId: string } | null;
  readonly endBinding?: { readonly elementId: string } | null;
  /** Drawing style, for the thumbnail. */
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
  readonly strokeWidth?: number;
  readonly fontSize?: number;
  readonly textAlign?: string;
  readonly points?: readonly (readonly [number, number])[];
  readonly endArrowhead?: string | null;
}

export interface Scene {
  readonly elements: readonly SceneElement[];
  readonly appState: Record<string, unknown>;
  readonly files: Record<string, unknown>;
  /** Fields the reader filled in or fixed (see repairElement); 0 for a clean file. */
  readonly repairs: number;
}

const NOUNS: Readonly<Record<string, string>> = {
  rectangle: "rectangle",
  diamond: "diamond",
  ellipse: "ellipse",
  arrow: "arrow",
  line: "line",
  freedraw: "freehand drawing",
  text: "text",
  image: "image",
  frame: "frame",
  magicframe: "frame",
  embeddable: "embed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapses whitespace and cuts to a limit (an ellipsis when cut). */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** clip for a multi-line text: each line is collapsed, the lines are kept. */
function clipLines(text: string, limit: number): string {
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const joined = lines.join("\n");
  return joined.length > limit ? `${joined.slice(0, limit - 1)}…` : joined;
}

/** Reads a file's text into a scene. Throws an Error whose message is one
 *  sentence the frame shows as is. */
export function readScene(text: string): Scene {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON, so it is not an Excalidraw drawing.");
  }
  if (!isRecord(value) || value.type !== "excalidraw") {
    throw new Error("This is not an Excalidraw drawing (its type is not \"excalidraw\").");
  }
  if (!Array.isArray(value.elements)) throw new Error("The drawing has no elements list.");
  if (value.elements.length > MAX_ELEMENTS) {
    throw new Error(`The drawing has ${value.elements.length.toLocaleString("en")} elements; at most ${MAX_ELEMENTS.toLocaleString("en")} are shown.`);
  }
  let repairs = 0;
  const elements = value.elements.map((item, i): SceneElement => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string") {
      throw new Error(`Element ${i + 1} has no id or type.`);
    }
    const fixed = repairElement(item);
    repairs += fixed.changes;
    return fixed.element as unknown as SceneElement;
  });
  return {
    elements,
    appState: isRecord(value.appState) ? value.appState : {},
    files: isRecord(value.files) ? value.files : {},
    repairs,
  };
}

const LINEAR_TYPES: ReadonlySet<string> = new Set(["arrow", "line", "freedraw"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Points are pairs of finite numbers, at least two of them. */
function validPoints(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]));
}

/** A file an agent wrote is often almost right: an arrow with no points (the
 *  editor throws on it and draws nothing), coordinates written as text, a text
 *  with no font. Those are fixed here, and counted, so the drawing shows. */
export function repairElement(raw: Record<string, unknown>): { readonly element: Record<string, unknown>; readonly changes: number } {
  const el: Record<string, unknown> = { ...raw };
  let changes = 0;
  for (const key of ["x", "y", "width", "height", "angle"] as const) {
    const v = el[key];
    if (finite(v)) continue;
    const parsed = typeof v === "string" ? Number(v) : NaN;
    el[key] = finite(parsed) ? parsed : key === "angle" ? 0 : 0;
    changes += 1;
  }
  if (LINEAR_TYPES.has(String(el.type)) && !validPoints(el.points)) {
    const w = el.width as number;
    const h = el.height as number;
    el.points = w !== 0 || h !== 0 ? [[0, 0], [w, h]] : [[0, 0], [0, 0]];
    changes += 1;
  }
  if (el.type === "text") {
    if (typeof el.text !== "string") {
      el.text = "";
      changes += 1;
    }
    if (!finite(el.fontSize)) {
      el.fontSize = 20;
      changes += 1;
    }
    if (!finite(el.fontFamily)) {
      el.fontFamily = 5;
      changes += 1;
    }
  }
  if (el.boundElements !== undefined && el.boundElements !== null && !Array.isArray(el.boundElements)) {
    el.boundElements = null;
    changes += 1;
  }
  return { element: el, changes };
}

/** The element's text: a text element's own, or the label bound inside it. */
export function labelOf(el: SceneElement, byId: ReadonlyMap<string, SceneElement>): string {
  if (el.type === "text") return clip(el.text ?? "", SELECTION_LABEL_LIMIT);
  const bound = el.boundElements?.find((b) => b.type === "text");
  const label = bound ? byId.get(bound.id)?.text : undefined;
  return label ? clip(label, SELECTION_LABEL_LIMIT) : "";
}

/** "rectangle “Checkout”" and the like: what the element is, in words. */
export function describe(el: SceneElement, byId: ReadonlyMap<string, SceneElement>): string {
  const label = labelOf(el, byId);
  const noun = NOUNS[el.type] ?? el.type;
  return label ? `${noun} “${label}”` : noun;
}

/** The connections an element takes part in, as words: "to …", "from …". An
 *  arrow names both ends; a shape names the arrows bound to it. */
export function connectionsOf(el: SceneElement, byId: ReadonlyMap<string, SceneElement>): string[] {
  const end = (id: string | undefined) => {
    const other = id ? byId.get(id) : undefined;
    return other ? describe(other, byId) : "nothing";
  };
  if (el.type === "arrow" || el.type === "line") {
    const out: string[] = [];
    if (el.startBinding) out.push(`from ${end(el.startBinding.elementId)}`);
    if (el.endBinding) out.push(`to ${end(el.endBinding.elementId)}`);
    return out;
  }
  const out: string[] = [];
  for (const bound of el.boundElements ?? []) {
    if (bound.type !== "arrow") continue;
    const arrow = byId.get(bound.id);
    if (!arrow) continue;
    if (arrow.startBinding?.elementId === el.id && arrow.endBinding) out.push(`to ${end(arrow.endBinding.elementId)}`);
    else if (arrow.endBinding?.elementId === el.id && arrow.startBinding) out.push(`from ${end(arrow.startBinding.elementId)}`);
  }
  return out;
}

function liveElements(scene: Scene): SceneElement[] {
  return scene.elements.filter((el) => !el.isDeleted);
}

function indexOf(elements: readonly SceneElement[]): Map<string, SceneElement> {
  return new Map(elements.map((el) => [el.id, el]));
}

/** The platform's word for what was picked (SELECTION_KINDS), which scopes the
 *  suggestions the host offers: a text is `text`, a shape is `block`, an arrow, a
 *  line, a drawing or several elements are an area, `region`. */
export function kindOf(picked: readonly SceneElement[]): "text" | "block" | "region" {
  if (picked.length !== 1) return "region";
  const type = picked[0].type;
  if (type === "text") return "text";
  if (type === "rectangle" || type === "diamond" || type === "ellipse") return "block";
  return "region";
}

/** What the member picked. Nothing selected is no selection (null: the chip
 *  is cleared). One element names it in full; several list their parts. */
export function selectionOf(scene: Scene, selectedIds: readonly string[]): Selection | null {
  const elements = liveElements(scene);
  const byId = indexOf(elements);
  const picked = selectedIds.map((id) => byId.get(id)).filter((el): el is SceneElement => el !== undefined);
  if (picked.length === 0) return null;
  const keys = picked.slice(0, SELECTION_KEYS_LIMIT).map((el) => el.id);
  if (picked.length === 1) {
    const [el] = picked;
    const lines = [`Type: ${NOUNS[el.type] ?? el.type}`, `Id: ${el.id}`];
    const label = labelOf(el, byId);
    if (label) lines.push(`Text: ${label}`);
    const connections = connectionsOf(el, byId);
    if (connections.length > 0) lines.push(`Connections: ${connections.join("; ")}`);
    if (el.x !== undefined && el.y !== undefined) {
      lines.push(`Position: x ${Math.round(el.x)}, y ${Math.round(el.y)}, ${Math.round(el.width ?? 0)} × ${Math.round(el.height ?? 0)}`);
    }
    return {
      label: clip(describe(el, byId), SELECTION_LABEL_LIMIT),
      detail: clipLines(lines.join("\n"), SELECTION_DETAIL_LIMIT),
      kind: kindOf(picked),
      keys,
    };
  }
  const items = picked.slice(0, SELECTION_ITEMS).map((el) => `- ${describe(el, byId)}`);
  if (picked.length > SELECTION_ITEMS) items.push(`- and ${picked.length - SELECTION_ITEMS} more`);
  return {
    label: `${picked.length} elements`,
    detail: clipLines(items.join("\n"), SELECTION_DETAIL_LIMIT),
    kind: kindOf(picked),
    keys,
  };
}

/** Compare units: every element that says something (a label, or an arrow).
 *  The key is the element's id, stable across versions; the text is what the
 *  element says and how it connects, not where it sits, so moving a box is
 *  not a change of content. */
export function unitsOf(scene: Scene): Unit[] {
  const elements = liveElements(scene);
  const byId = indexOf(elements);
  const units: Unit[] = [];
  for (const el of elements) {
    // A label inside a shape is said by the shape's own unit.
    if (el.type === "text" && el.containerId) continue;
    const label = labelOf(el, byId);
    const connections = connectionsOf(el, byId);
    if (!label && el.type !== "arrow" && el.type !== "line") continue;
    if (units.length === UNITS_LIMIT) break;
    const text = [label, ...connections].filter(Boolean).join("; ");
    units.push({
      key: el.id,
      label: clip(describe(el, byId), UNIT_LABEL_LIMIT),
      text: clip(text || describe(el, byId), UNIT_TEXT_LIMIT),
      at: `el:${el.id}`,
    });
  }
  return units;
}

// --- Draft with AI -----------------------------------------------------------
// The assist's reply (content/draw-diagram) is untrusted: it is read here and
// nothing else. Labels are plain text; counts and lengths are bounded; an arrow
// that names a box the reply does not hold is left out and counted.

export const MAX_DRAFT_NODES = 30;
export const MAX_DRAFT_EDGES = 50;
const DRAFT_ID_LIMIT = 40;
const DRAFT_NODE_LABEL_LIMIT = 60;
const DRAFT_EDGE_LABEL_LIMIT = 40;
const DRAFT_TITLE_LIMIT = 60;

export interface DraftNode {
  readonly id: string;
  readonly label: string;
  /** What the model said the box is; a decision is drawn as a diamond. */
  readonly kind: "step" | "decision";
}

export interface DraftEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface Draft {
  readonly title: string;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
  /** Arrows left out because an end named no box of the draft. */
  readonly dropped: number;
}

/** A draft's text as the reply gave it: a string, cut to a limit. */
function text(value: unknown, limit: number): string {
  return typeof value === "string" ? clip(value, limit) : "";
}

/** Reads the assist's reply into a draft. Throws an Error whose message is one
 *  sentence the frame shows as is. */
export function readDraft(value: unknown): Draft {
  if (!isRecord(value)) throw new Error("The draft did not come back as a diagram. Try again.");
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) throw new Error("The draft has no boxes. Try a more concrete sentence.");
  if (value.nodes.length > MAX_DRAFT_NODES) throw new Error(`The draft has ${value.nodes.length} boxes; at most ${MAX_DRAFT_NODES} are drawn.`);
  const seen = new Set<string>();
  const nodes: DraftNode[] = [];
  for (const item of value.nodes) {
    const id = isRecord(item) ? text(item.id, DRAFT_ID_LIMIT) : "";
    const label = isRecord(item) ? text(item.label, DRAFT_NODE_LABEL_LIMIT) : "";
    if (!id || seen.has(id)) throw new Error("The draft has a box with no id, or two boxes with the same id. Try again.");
    seen.add(id);
    const said = isRecord(item) ? text(item.kind, 20).toLowerCase() : "";
    // The model says what a box is. Only when it did not (an older task) is a
    // question mark, ASCII or full-width, taken as the sign of a decision.
    const kind = said === "decision" || said === "step" ? said : /[?？]\s*$/.test(label) ? "decision" : "step";
    nodes.push({ id, label: label || id, kind });
  }
  const edges: DraftEdge[] = [];
  let dropped = 0;
  for (const item of Array.isArray(value.edges) ? value.edges : []) {
    const from = isRecord(item) ? text(item.from, DRAFT_ID_LIMIT) : "";
    const to = isRecord(item) ? text(item.to, DRAFT_ID_LIMIT) : "";
    if (!seen.has(from) || !seen.has(to)) {
      dropped += 1;
      continue;
    }
    if (edges.length === MAX_DRAFT_EDGES) {
      dropped += 1;
      continue;
    }
    edges.push({ from, to, label: isRecord(item) ? text(item.label, DRAFT_EDGE_LABEL_LIMIT) : "" });
  }
  return { title: text(value.title, DRAFT_TITLE_LIMIT), nodes, edges, dropped };
}

/** Where a draft goes: to the right of what the drawing holds, or at the origin
 *  when the drawing is empty. */
export function draftOrigin(elements: readonly SceneElement[]): { readonly x: number; readonly y: number } {
  const live = elements.filter((el) => !el.isDeleted && el.x !== undefined && el.y !== undefined);
  if (live.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...live.map((el) => (el.x ?? 0) + (el.width ?? 0)));
  const top = Math.min(...live.map((el) => el.y ?? 0));
  return { x: Math.round(right + DRAFT_GAP_X), y: Math.round(top) };
}

/** Layout of a draft, in scene pixels: a flow reads top to bottom. */
export const DRAFT_GAP_X = 160;
const DRAFT_ROW_GAP = 100;
const DRAFT_COL_GAP = 70;
const DRAFT_BOX_H = 80;
const DRAFT_DIAMOND_H = 120;
const DRAFT_BOX_MIN = 160;
const DRAFT_BOX_MAX = 260;
const DRAFT_DIAMOND_MIN = 200;
const DRAFT_DIAMOND_MAX = 300;
const DRAFT_LOOP_CHANNEL = 70;

/** Element skeletons for convertToExcalidrawElements: the boxes (decisions are
 *  diamonds) in rows by arrow depth, ordered to reduce crossings, and the arrows
 *  bound to them. A forward arrow runs straight down, or through a channel
 *  between rows when it skips a row. An arrow that loops back runs out to the
 *  left of the drawing and in again, so it never crosses a box. */
export function layoutDraft(draft: Draft, origin: { readonly x: number; readonly y: number }): Record<string, unknown>[] {
  const ids = draft.nodes.map((n) => n.id);
  const byId = new Map(draft.nodes.map((n) => [n.id, n]));
  const edges = draft.edges;

  // Back edges: a depth-first walk finds the arrows that close a loop.
  const backEdges = new Set<number>();
  const state = new Map<string, 1 | 2>();
  const visit = (u: string): void => {
    state.set(u, 1);
    edges.forEach((e, ei) => {
      if (e.from !== u) return;
      const s = state.get(e.to);
      if (s === 1) backEdges.add(ei);
      else if (s === undefined) visit(e.to);
    });
    state.set(u, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);

  // Rows: the longest chain of forward arrows into each box.
  const row = new Map(ids.map((id) => [id, 0]));
  for (let round = 0; round < ids.length; round++) {
    let changed = false;
    edges.forEach((e, ei) => {
      if (backEdges.has(ei)) return;
      const next = (row.get(e.from) ?? 0) + 1;
      if (next > (row.get(e.to) ?? 0)) {
        row.set(e.to, next);
        changed = true;
      }
    });
    if (!changed) break;
  }
  const rowCount = Math.max(...ids.map((id) => row.get(id) ?? 0)) + 1;
  const rows: string[][] = Array.from({ length: rowCount }, () => []);
  for (const id of ids) rows[row.get(id) ?? 0].push(id);

  // Order within a row by the average position of the boxes it connects to
  // (barycentre), down and up, a few passes: fewer crossings.
  const forward = edges.filter((_, ei) => !backEdges.has(ei));
  const position = new Map<string, number>();
  const refresh = () => rows.forEach((r) => r.forEach((id, i) => position.set(id, i)));
  const orderBy = (r: string[], neighbours: (id: string) => number[]) => {
    const bary = new Map(r.map((id, i) => {
      const ns = neighbours(id);
      return [id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i] as const;
    }));
    r.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0));
  };
  refresh();
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 1; r < rowCount; r++) {
      orderBy(rows[r], (id) => forward.filter((e) => e.to === id).map((e) => position.get(e.from) ?? 0));
      refresh();
    }
    for (let r = rowCount - 2; r >= 0; r--) {
      orderBy(rows[r], (id) => forward.filter((e) => e.from === id).map((e) => position.get(e.to) ?? 0));
      refresh();
    }
  }

  // Sizes and places.
  const size = new Map(draft.nodes.map((n) => {
    const decision = n.kind === "decision";
    const w = decision
      ? Math.min(DRAFT_DIAMOND_MAX, Math.max(DRAFT_DIAMOND_MIN, 9 * n.label.length + 60))
      : Math.min(DRAFT_BOX_MAX, Math.max(DRAFT_BOX_MIN, 9 * n.label.length + 40));
    return [n.id, { w, h: decision ? DRAFT_DIAMOND_H : DRAFT_BOX_H, decision }] as const;
  }));
  const rowWidth = (r: string[]) => r.reduce((sum, id) => sum + (size.get(id)?.w ?? 0), 0) + DRAFT_COL_GAP * Math.max(0, r.length - 1);
  const widest = Math.max(...rows.map(rowWidth));
  const left = origin.x + (backEdges.size > 0 ? DRAFT_LOOP_CHANNEL : 0);
  const place = new Map<string, { x: number; y: number; w: number; h: number }>();
  let top = origin.y;
  for (const r of rows) {
    const rowH = Math.max(0, ...r.map((id) => size.get(id)?.h ?? 0));
    let x = left + (widest - rowWidth(r)) / 2;
    for (const id of r) {
      const s = size.get(id)!;
      place.set(id, { x, y: top + (rowH - s.h) / 2, w: s.w, h: s.h });
      x += s.w + DRAFT_COL_GAP;
    }
    top += rowH + DRAFT_ROW_GAP;
  }
  const rowTop = (r: number) => origin.y + rows.slice(0, r).reduce((sum, rr) => sum + Math.max(0, ...rr.map((id) => size.get(id)?.h ?? 0)) + DRAFT_ROW_GAP, 0);

  const boxes = draft.nodes.map((node) => {
    const p = place.get(node.id)!;
    const s = size.get(node.id)!;
    return { type: s.decision ? "diamond" : "rectangle", id: `n-${node.id}`, x: p.x, y: p.y, width: p.w, height: p.h, label: { text: byId.get(node.id)?.label ?? node.id, fontSize: 20 } };
  });

  let loop = 0;
  const arrows = edges.map((edge, i) => {
    const a = place.get(edge.from)!;
    const b = place.get(edge.to)!;
    const down = (p: { x: number; y: number; w: number; h: number }) => ({ x: p.x + p.w / 2, y: p.y + p.h });
    const up = (p: { x: number; y: number; w: number; h: number }) => ({ x: p.x + p.w / 2, y: p.y });
    const sideLeft = (p: { x: number; y: number; w: number; h: number }) => ({ x: p.x, y: p.y + p.h / 2 });
    let path: { x: number; y: number }[];
    if (backEdges.has(i)) {
      // Down from the source, along the gap under its row, up the channel left of
      // every box, and into the target's left side: no box is crossed.
      const channel = origin.x + 24 - 18 * (loop++);
      const from = down(a);
      const under = rowTop((row.get(edge.from) ?? 0) + 1) - DRAFT_ROW_GAP / 2;
      const to = sideLeft(b);
      path = [from, { x: from.x, y: under }, { x: channel, y: under }, { x: channel, y: to.y }, to];
    } else {
      const from = down(a);
      const to = up(b);
      if ((row.get(edge.to) ?? 0) > (row.get(edge.from) ?? 0) + 1) {
        const channelY = rowTop(row.get(edge.to) ?? 0) - DRAFT_ROW_GAP / 2;
        path = [from, { x: from.x, y: channelY }, { x: to.x, y: channelY }, to];
      } else {
        path = [from, to];
      }
    }
    const origin0 = path[0];
    const arrow: Record<string, unknown> = {
      type: "arrow",
      id: `a-${i}`,
      x: origin0.x,
      y: origin0.y,
      points: path.map((p) => [p.x - origin0.x, p.y - origin0.y]),
      start: { id: `n-${edge.from}` },
      end: { id: `n-${edge.to}` },
    };
    if (edge.label) arrow.label = { text: edge.label, fontSize: 16 };
    return arrow;
  });
  return [...boxes, ...arrows];
}

// --- Thumbnail and selection geometry ---------------------------------------

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The scene box an element covers: its frame, or for a line or an arrow the
 *  points it runs through (an arrow's frame alone misses its bends). */
export function elementBox(el: SceneElement): Box {
  const x = el.x ?? 0;
  const y = el.y ?? 0;
  if (el.points && el.points.length > 0) {
    const xs = el.points.map((p) => x + p[0]);
    const ys = el.points.map((p) => y + p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  return { x, y, w: el.width ?? 0, h: el.height ?? 0 };
}

/** The box that covers every live element; null for an empty drawing. */
export function sceneBox(elements: readonly SceneElement[]): Box | null {
  const live = elements.filter((el) => !el.isDeleted);
  if (live.length === 0) return null;
  const boxes = live.map(elementBox);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** How to fit a scene box into a canvas: a uniform scale and the offset that
 *  centres it, with a margin on every side. */
export function coverFit(box: Box, width: number, height: number, margin: number): { scale: number; dx: number; dy: number } {
  const availW = Math.max(1, width - 2 * margin);
  const availH = Math.max(1, height - 2 * margin);
  const scale = Math.min(availW / Math.max(1, box.w), availH / Math.max(1, box.h), 1);
  return {
    scale,
    dx: margin + (availW - box.w * scale) / 2 - box.x * scale,
    dy: margin + (availH - box.h * scale) / 2 - box.y * scale,
  };
}

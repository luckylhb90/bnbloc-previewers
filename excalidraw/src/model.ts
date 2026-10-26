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
}

export interface Scene {
  readonly elements: readonly SceneElement[];
  readonly appState: Record<string, unknown>;
  readonly files: Record<string, unknown>;
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
  const elements = value.elements.map((item, i): SceneElement => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string") {
      throw new Error(`Element ${i + 1} has no id or type.`);
    }
    return item as unknown as SceneElement;
  });
  return {
    elements,
    appState: isRecord(value.appState) ? value.appState : {},
    files: isRecord(value.files) ? value.files : {},
  };
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
      kind: "block",
      keys,
    };
  }
  const items = picked.slice(0, SELECTION_ITEMS).map((el) => `- ${describe(el, byId)}`);
  if (picked.length > SELECTION_ITEMS) items.push(`- and ${picked.length - SELECTION_ITEMS} more`);
  return {
    label: `${picked.length} elements`,
    detail: clipLines(items.join("\n"), SELECTION_DETAIL_LIMIT),
    kind: "block",
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

/** Layout of a draft, in CSS-free scene units (pixels). */
export const DRAFT_GAP_X = 160;
const DRAFT_COLUMN_GAP = 120;
const DRAFT_ROW_GAP = 60;
const DRAFT_BOX_HEIGHT = 80;
const DRAFT_BOX_MIN = 160;
const DRAFT_BOX_MAX = 280;

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
    nodes.push({ id, label: label || id });
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

/** Element skeletons for convertToExcalidrawElements: boxes with their labels,
 *  and arrows bound to them. The boxes sit in columns by arrow depth (a box
 *  reached by a longer chain of arrows goes further right); a loop is cut where
 *  it closes, so every box gets a column. */
export function layoutDraft(draft: Draft, origin: { readonly x: number; readonly y: number }): Record<string, unknown>[] {
  const depth = new Map<string, number>(draft.nodes.map((n) => [n.id, 0]));
  // Longest path by relaxation, bounded by the box count so a loop stops.
  for (let round = 0; round < draft.nodes.length; round++) {
    let changed = false;
    for (const edge of draft.edges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0) && next < draft.nodes.length) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const widths = new Map(draft.nodes.map((n) => [n.id, Math.min(DRAFT_BOX_MAX, Math.max(DRAFT_BOX_MIN, 10 * n.label.length + 40))]));
  const columns: DraftNode[][] = [];
  for (const node of draft.nodes) {
    const d = depth.get(node.id) ?? 0;
    (columns[d] ??= []).push(node);
  }
  const place = new Map<string, { x: number; y: number; w: number; h: number }>();
  let x = origin.x;
  columns.forEach((column) => {
    const colWidth = Math.max(...column.map((n) => widths.get(n.id) ?? DRAFT_BOX_MIN));
    column.forEach((node, row) => {
      const w = widths.get(node.id) ?? DRAFT_BOX_MIN;
      place.set(node.id, { x: x + Math.round((colWidth - w) / 2), y: origin.y + row * (DRAFT_BOX_HEIGHT + DRAFT_ROW_GAP), w, h: DRAFT_BOX_HEIGHT });
    });
    x += colWidth + DRAFT_COLUMN_GAP;
  });

  const boxes = draft.nodes.map((node) => {
    const p = place.get(node.id)!;
    return { type: "rectangle", id: `n-${node.id}`, x: p.x, y: p.y, width: p.w, height: p.h, label: { text: node.label, fontSize: 20 } };
  });
  const arrows = draft.edges.map((edge, i) => {
    const a = place.get(edge.from)!;
    const b = place.get(edge.to)!;
    const start = { x: a.x + a.w, y: a.y + a.h / 2 };
    const end = { x: b.x, y: b.y + b.h / 2 };
    const arrow: Record<string, unknown> = {
      type: "arrow",
      id: `a-${i}`,
      x: start.x,
      y: start.y,
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      start: { id: `n-${edge.from}` },
      end: { id: `n-${edge.to}` },
    };
    if (edge.label) arrow.label = { text: edge.label, fontSize: 16 };
    return arrow;
  });
  return [...boxes, ...arrows];
}

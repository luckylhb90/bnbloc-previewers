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

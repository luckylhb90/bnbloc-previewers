// Excalidraw previewer (bnbloc.previewer.contract/v1).
//
// Opens a .excalidraw file in Excalidraw's own editor, inside the frame. The
// frame is read-write: a member edits the drawing and saves it as the next
// version of the file (preview.save, capability "edit"; the host publishes it
// with the same compare-and-swap as an agent's edit, so a save made on an old
// version is refused, never merged). Ask AI works on what the member picked:
// the selection is the picked elements, described with their text and their
// connections (model.ts). Compare reads each labelled element as a unit.
// Thumbnail: the first render of the file.

import {
  onFile,
  onInit,
  onReveal,
  onSaved,
  onSaveFailed,
  onToolbar,
  onUnits,
  provideThumbnail,
  reportError,
  savePreview,
  sendSelection,
  setTitle,
  setToolbar,
  type PreviewFile,
  type ToolbarItem,
} from "@bnbloc/previewer-sdk";
import { pendingReveal } from "../../lib/selection.ts";
import { shortName } from "../../lib/office.ts";
import { mountEditor, ZOOM_MAX, ZOOM_MIN, type Editor, type EditorState } from "./editor.tsx";
import { readScene, selectionOf, unitsOf, type Scene } from "./model.ts";

/** How long a save may wait for the host's answer before the frame says so. */
const SAVE_TIMEOUT_MS = 10_000;
/** The summary line a save's version carries in the file's history. */
const SAVE_SUMMARY = "Edited in the drawing editor";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const editorEl = byId<HTMLElement>("editor");
const statusEl = byId<HTMLElement>("status");
const saveEl = byId<HTMLButtonElement>("save");

/** The line under the drawing: the last thing that happened (a load, a save,
 *  a refusal). It stays until the next save attempt, so a refusal is not lost
 *  to a later edit. */
let notice = { text: "", error: false };
let file: PreviewFile | null = null;
let loaded = false;
/** A member has pointed or typed since the file loaded. The editor also changes
 *  element versions on its own (it re-measures text once its fonts arrive), so
 *  "unsaved" counts only what a member did. */
let touched = false;
/** The version of the scene the host holds (the last one loaded or saved). */
let savedVersion = -1;
/** The version the save now in flight carries, while it waits for the host. */
let sentVersion = -1;
let saving = false;
let saveTimer = 0;
let lastSelection = "";
let lastZoom = -1;
let thumbnailSent = false;

function dirty(): boolean {
  return loaded && touched && editor.version() !== savedVersion;
}

/** Paints the status line and enables Save for a loaded file with edits. A
 *  refusal (an error notice) stays on the line while the file has edits. */
function render(): void {
  const changed = dirty();
  saveEl.disabled = !loaded || saving || !changed;
  let text = notice.text;
  let error = notice.error;
  if (saving) {
    text = "Saving…";
    error = false;
  } else if (changed && !error) {
    text = "Unsaved changes. Save (Ctrl/⌘ S) to make them a new version.";
  }
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}

function say(text: string, error = false): void {
  notice = { text, error };
  render();
}

function toolbarItems(zoom: number): ToolbarItem[] {
  return [
    { id: "zoom", icon: "zoom-in", label: "Zoom", kind: "zoom", value: zoom, disabled: !loaded },
    { id: "fit", icon: "fit", label: "Fit to view", kind: "button", disabled: !loaded },
  ];
}

function publishToolbar(zoom: number): void {
  lastZoom = zoom;
  setToolbar(toolbarItems(zoom));
}

/** The picked elements as the model reads them; the chip follows the picks. */
function reportSelection(ids: readonly string[]): void {
  const key = [...ids].sort().join(",");
  if (key === lastSelection) return;
  lastSelection = key;
  const scene: Scene = { elements: editor.elements(), appState: {}, files: {} };
  sendSelection(selectionOf(scene, ids));
}

function onEditorChange(state: EditorState): void {
  if (state.zoom !== lastZoom) publishToolbar(state.zoom);
  if (loaded) reportSelection(state.selectedIds);
  render();
}

const editor: Editor = mountEditor(editorEl, onEditorChange);

const reveals = pendingReveal((at) => {
  if (!loaded || !at.startsWith("el:")) return loaded;
  editor.reveal(at.slice(3));
  return true;
});

onInit((init) => {
  document.documentElement.dataset.theme = init.theme === "dark" ? "dark" : "light";
  say(`Loading ${init.file.name}…`);
  publishToolbar(lastZoom < 0 ? 1 : lastZoom);
});

onFile((bytes, info) => {
  file = info;
  loaded = false;
  touched = false;
  thumbnailSent = false;
  let scene: Scene;
  try {
    scene = readScene(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    say(message, true);
    reportError(message);
    return;
  }
  setTitle(shortName(info.name));
  editor.load(scene, (state) => {
    loaded = true;
    savedVersion = state.version;
    publishToolbar(state.zoom);
    editor.fit();
    reveals.apply();
    say("");
    if (!thumbnailSent) {
      thumbnailSent = true;
      void editor
        .thumbnail()
        .then((png) => (png ? provideThumbnail(png) : undefined))
        .catch(() => {});
    }
  });
});

onToolbar((id, value) => {
  if (!loaded) return;
  if (id === "zoom" && typeof value === "number") editor.zoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)));
  else if (id === "fit") editor.fit();
});

/** Compare: each labelled element of this version, keyed by its id. */
onUnits(async (bytes) => unitsOf(readScene(new TextDecoder("utf-8").decode(bytes))));

onReveal((at) => reveals.ask(at));

function save(): void {
  if (!file || !loaded || saving || !dirty()) return;
  saving = true;
  notice = { text: "", error: false };
  sentVersion = editor.version();
  const bytes = new TextEncoder().encode(editor.serialize()).buffer;
  saveTimer = window.setTimeout(() => {
    if (!saving) return;
    saving = false;
    say("Saving did not answer; the file is not saved.", true);
  }, SAVE_TIMEOUT_MS);
  try {
    savePreview(bytes, SAVE_SUMMARY);
  } catch (err) {
    // The SDK refuses a file over the save limit before it is sent.
    window.clearTimeout(saveTimer);
    saving = false;
    say(err instanceof Error ? err.message : String(err), true);
  }
  render();
}

onSaved((version) => {
  window.clearTimeout(saveTimer);
  saving = false;
  savedVersion = sentVersion;
  say(`Saved as v${version}.`);
});

onSaveFailed((message) => {
  window.clearTimeout(saveTimer);
  saving = false;
  say(message, true);
});

saveEl.addEventListener("click", () => save());
// Ctrl/⌘ S saves; the browser's own save dialog is not offered in the frame.
window.addEventListener(
  "keydown",
  (e) => {
    touched = true;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
    render();
  },
  true,
);
window.addEventListener(
  "pointerdown",
  () => {
    touched = true;
  },
  true,
);

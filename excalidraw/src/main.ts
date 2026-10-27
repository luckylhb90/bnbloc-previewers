// Excalidraw previewer (bnbloc.previewer.contract/v1).
//
// Opens a .excalidraw file in Excalidraw's own editor, inside the frame. The
// frame is read-write: a member edits the drawing and saves it as the next
// version of the file (preview.save, capability "edit"; the host publishes it
// with the same compare-and-swap as an agent's edit, so a save made on an old
// version is refused, never merged). Ask AI works on what the member picked:
// the selection is the picked elements, described with their text and their
// connections (model.ts). Compare reads each labelled element as a unit.
// Draft with AI: the footer asks the host for a diagram from one sentence; the
// reply is laid out and added to the drawing as one undoable step, unsaved
// until the member saves it (AI proposes, the member decides).
// Thumbnail: the first render of the file.

import {
  onFile,
  onInit,
  onDrafted,
  onDraftFailed,
  onReveal,
  onSaved,
  onSaveFailed,
  onToolbar,
  onUnits,
  provideThumbnail,
  reportError,
  requestDraft,
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
import { draftOrigin, layoutDraft, readDraft, readScene, selectionOf, unitsOf, type Scene } from "./model.ts";
import { drawCover } from "./cover.ts";

/** How long after the fonts load the editor is given to settle before the baseline. */
const SETTLE_MS = 400;
/** How long a save may wait for the host's answer before the frame says so. */
const SAVE_TIMEOUT_MS = 10_000;
/** How long a draft may wait for the host's answer before the frame says so. */
const DRAFT_TIMEOUT_MS = 90_000;
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
const promptEl = byId<HTMLInputElement>("prompt");
const draftEl = byId<HTMLButtonElement>("draft");
const removeDraftEl = byId<HTMLButtonElement>("remove-draft");

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
/** A draft is being written by the host; its timer says so if it never answers. */
let drafting = false;
let draftTimer = 0;
/** The elements the last draft added: "Remove draft" takes exactly these out. */
let lastDraft: string[] = [];
/** Bumped when a baseline is taken or superseded, so a late settle is dropped. */
let baselineToken = 0;
let lastSelection = "";
let lastZoom = -1;
let thumbnailSent = false;
/** The host asked for a view-only frame (a shared file): look, zoom, pan; no save,
 *  no draft, no Ask AI. The host refuses those messages anyway (a frame is not
 *  trusted to comply); this makes the page not offer them. */
let viewOnly = false;

function dirty(): boolean {
  return loaded && touched && editor.version() !== savedVersion;
}

/** Paints the status line and enables Save and Draft as the state allows. A
 *  refusal (an error notice) stays on the line while the file has edits. */
function render(): void {
  const changed = dirty();
  saveEl.disabled = !loaded || saving || drafting || !changed;
  draftEl.disabled = !loaded || saving || drafting || promptEl.value.trim() === "";
  promptEl.disabled = drafting;
  removeDraftEl.hidden = lastDraft.length === 0 || !loaded;
  let text = notice.text;
  let error = notice.error;
  if (saving) {
    text = "Saving…";
    error = false;
  } else if (drafting) {
    text = "Drafting with AI…";
    error = false;
  } else if (changed && !error) {
    const hint = "Unsaved changes. Save (Ctrl/⌘ S) keeps them as a new version; Ctrl/⌘ Z undoes the last step.";
    text = notice.text ? `${hint} ${notice.text}` : hint;
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

/** The picked elements as the model reads them, with where they are on screen:
 *  the host places its Ask AI action under that rectangle. Sent again when the
 *  view moves (the rectangle changes), so the action stays beside its selection. */
function reportSelection(ids: readonly string[]): void {
  if (viewOnly) return;
  const rect = ids.length > 0 ? editor.selectionRect(ids) : null;
  const where = rect ? [rect.x, rect.y, rect.w, rect.h].map((v) => Math.round(v)).join(",") : "";
  const key = `${[...ids].sort().join(",")}|${where}`;
  if (key === lastSelection) return;
  lastSelection = key;
  const scene: Scene = { elements: editor.elements(), appState: {}, files: {}, repairs: 0 };
  const picked = selectionOf(scene, ids);
  sendSelection(picked && rect ? { ...picked, rect } : picked);
}

function onEditorChange(state: EditorState): void {
  if (state.zoom !== lastZoom) publishToolbar(state.zoom);
  if (loaded) reportSelection(state.selectedIds);
  render();
}

const editor: Editor = mountEditor(editorEl, onEditorChange);

// The frame's size is set by the workbench, and can change after the file is
// shown: fit to the box again until the member zooms or pans by hand, or a
// drawing fitted to a small box stays small when the box grows. A click or an
// edit does not end the automatic fit; zooming does.
let manualView = false;
new ResizeObserver(() => {
  if (loaded && !manualView) editor.fit();
}).observe(editorEl);
const endAutoFit = () => {
  manualView = true;
};
editorEl.addEventListener("wheel", endAutoFit, { passive: true });
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "_") endAutoFit();
  },
  true,
);

const reveals = pendingReveal((at) => {
  if (!loaded || !at.startsWith("el:")) return loaded;
  editor.reveal(at.slice(3));
  return true;
});

onInit((init) => {
  viewOnly = init.viewOnly === true;
  document.documentElement.dataset.theme = init.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.viewOnly = viewOnly ? "true" : "false";
  editor.setViewOnly(viewOnly);
  say(`Loading ${init.file.name}…`);
  publishToolbar(lastZoom < 0 ? 1 : lastZoom);
});

onFile((bytes, info) => {
  file = info;
  loaded = false;
  touched = false;
  lastDraft = [];
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
  const token = ++baselineToken;
  const opened = (state: EditorState) => {
    loaded = true;
    manualView = false;
    savedVersion = state.version;
    publishToolbar(state.zoom);
    editor.fit();
    reveals.apply();
    say(scene.repairs > 0 ? `Opened with ${scene.repairs} repair${scene.repairs === 1 ? "" : "s"}: some shapes had missing or invalid coordinates, points or text fields.` : "");
    // Excalidraw re-measures text once its fonts arrive, which changes element
    // versions without any edit: the saved baseline is taken after that.
    void document.fonts.ready
      .then(() => new Promise((done) => window.setTimeout(done, SETTLE_MS)))
      .then(() => {
        if (token !== baselineToken || !loaded) return;
        // Text drawn before its font was ready is drawn again (WebKit does not do it on its own).
        editor.refresh();
        savedVersion = editor.version();
        touched = false;
        render();
      });
    if (!thumbnailSent) {
      thumbnailSent = true;
      // Not during the editor's own mount: in WebKit (the desktop app's engine)
      // an export started from inside the mount clears the scene.
      window.setTimeout(() => {
        void drawCover(editor.elements())
          .then((png) => (png ? provideThumbnail(png) : undefined))
          .catch(() => {});
      }, 0);
    }
  };
  try {
    editor.load(scene, opened);
  } catch (err) {
    // A scene the editor cannot draw says so, rather than sitting on "Loading".
    loaded = false;
    const message = `This drawing could not be drawn: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
    say(message, true);
    reportError(message);
  }
});

onToolbar((id, value) => {
  if (!loaded) return;
  if (id === "zoom" && typeof value === "number") {
    manualView = true;
    editor.zoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)));
  } else if (id === "fit") {
    manualView = false;
    editor.fit();
  }
});

/** Compare: each labelled element of this version, keyed by its id. */
onUnits(async (bytes) => unitsOf(readScene(new TextDecoder("utf-8").decode(bytes))));

onReveal((at) => reveals.ask(at));

function save(): void {
  if (viewOnly || !file || !loaded || saving || !dirty()) return;
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
  baselineToken += 1;
  savedVersion = sentVersion;
  // The draft is part of the saved version now: it is no longer a step to remove.
  lastDraft = [];
  say(`Saved as v${version}.`);
});

onSaveFailed((message) => {
  window.clearTimeout(saveTimer);
  saving = false;
  say(message, true);
});

/** Asks the host for a draft of the sentence in the footer. */
function askDraft(): void {
  const prompt = promptEl.value.trim();
  if (viewOnly || !loaded || drafting || !prompt) return;
  drafting = true;
  notice = { text: "", error: false };
  render();
  draftTimer = window.setTimeout(() => {
    if (!drafting) return;
    drafting = false;
    say("The draft did not answer. Try again.", true);
  }, DRAFT_TIMEOUT_MS);
  try {
    requestDraft(prompt);
  } catch (err) {
    window.clearTimeout(draftTimer);
    drafting = false;
    say(err instanceof Error ? err.message : String(err), true);
  }
}

onDrafted((reply) => {
  window.clearTimeout(draftTimer);
  drafting = false;
  let draft;
  try {
    draft = readDraft(reply);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
    return;
  }
  if (!loaded) {
    say("The file closed before the draft came back; nothing was added.", true);
    return;
  }
  lastDraft = editor.addSkeletons(layoutDraft(draft, draftOrigin(editor.elements())));
  if (lastDraft.length === 0) {
    say("The drawing is not ready for a draft yet. Try again.", true);
    return;
  }
  touched = true;
  const left = draft.dropped > 0 ? ` ${draft.dropped} arrow${draft.dropped === 1 ? "" : "s"} named no box and were left out.` : "";
  say(`Added a draft: ${draft.nodes.length} boxes, ${draft.edges.length} arrows.${left}`);
});

removeDraftEl.addEventListener("click", () => {
  editor.removeElements(lastDraft);
  lastDraft = [];
  say("Removed the draft.");
});

onDraftFailed((message) => {
  window.clearTimeout(draftTimer);
  drafting = false;
  say(message, true);
});

promptEl.addEventListener("input", () => render());
// The frame's sandbox allows scripts but not forms, so a draft is a click or an
// Enter key, never a form submit.
draftEl.addEventListener("click", () => askDraft());
promptEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  askDraft();
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

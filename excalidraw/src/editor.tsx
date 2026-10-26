// The drawing surface: Excalidraw's own editor, mounted in the frame. This
// module owns the editor's API (load, zoom, fit, reveal, serialize, thumbnail)
// and reports what changed (the scene's version, the zoom, the picked ids);
// main.ts wires those to the host protocol. Menus that need a file system, a
// library store or a share link are switched off: the frame has no storage and
// no network, and the host saves through preview.save. Excalidraw's AI
// features (text to diagram, diagram to code) call a back end, so they are off.

import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  hashElementsVersion,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import type { Scene, SceneElement } from "./model.ts";

type ExcalidrawAPI = Parameters<NonNullable<ComponentProps<typeof Excalidraw>["excalidrawAPI"]>>[0];

/** Zoom limits the toolbar may ask for. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
/** Blank space around a thumbnail's drawing, in pixels. */
const THUMBNAIL_PADDING = 16;

export interface EditorState {
  /** The scene's version: changes with every edit, the same for the same scene. */
  readonly version: number;
  readonly zoom: number;
  readonly selectedIds: readonly string[];
}

export interface Editor {
  /** Shows the scene; loaded runs once it is on the canvas, with its version. */
  load(scene: Scene, loaded: (state: EditorState) => void): void;
  zoom(value: number): void;
  fit(): void;
  /** Selects the element and brings it into view. */
  reveal(id: string): void;
  /** The file's bytes as the editor writes them (an .excalidraw JSON). */
  serialize(): string;
  /** The scene's version now (compare with a saved version to see an edit). */
  version(): number;
  /** The drawing as a PNG with its padding, or null when there is nothing to draw. */
  thumbnail(): Promise<Blob | null>;
  /** The live elements, read the way the model reads a file. */
  elements(): readonly SceneElement[];
  /** Adds skeletons (boxes and arrows, see layoutDraft) to the drawing as one
   *  undoable step; returns the ids of the elements it added. */
  addSkeletons(skeletons: readonly Record<string, unknown>[]): string[];
  /** Removes the elements with these ids as one undoable step (other edits stay). */
  removeElements(ids: readonly string[]): void;
}

export function mountEditor(container: HTMLElement, onChange: (state: EditorState) => void): Editor {
  let api: ExcalidrawAPI | null = null;
  let pending: { scene: Scene; loaded: (state: EditorState) => void } | null = null;

  const state = (): EditorState => {
    if (!api) return { version: 0, zoom: 1, selectedIds: [] };
    const app = api.getAppState();
    return {
      version: hashElementsVersion(api.getSceneElements()),
      zoom: app.zoom.value,
      selectedIds: Object.keys(app.selectedElementIds).filter((id) => app.selectedElementIds[id]),
    };
  };
  const apply = (scene: Scene, loaded: (state: EditorState) => void) => {
    if (!api) return;
    const elements = restoreElements(scene.elements as never, null, { repairBindings: true });
    const appState = restoreAppState(scene.appState as never, null);
    api.updateScene({ elements, appState });
    if (Object.keys(scene.files).length > 0) api.addFiles(Object.values(scene.files) as never);
    loaded(state());
  };

  createRoot(container).render(
    <Excalidraw
      excalidrawAPI={(next) => {
        api = next;
        if (pending) apply(pending.scene, pending.loaded);
        pending = null;
      }}
      theme="light"
      langCode="en"
      aiEnabled={false}
      onChange={() => onChange(state())}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          saveAsImage: false,
          toggleTheme: false,
          export: { saveFileToDisk: false },
        },
      }}
    />,
  );

  return {
    load(scene, loaded) {
      if (api) apply(scene, loaded);
      else pending = { scene, loaded };
    },
    zoom(value) {
      if (!api) return;
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
      api.updateScene({ appState: { zoom: { value: clamped } } as never });
    },
    fit() {
      api?.scrollToContent(undefined, { fitToContent: true, animate: false });
    },
    reveal(id) {
      if (!api) return;
      const el = api.getSceneElements().find((e) => e.id === id && !e.isDeleted);
      if (!el) return;
      api.updateScene({ appState: { selectedElementIds: { [id]: true } } as never });
      api.scrollToContent(el, { animate: true, fitToContent: false });
    },
    serialize() {
      if (!api) return "";
      return serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");
    },
    version() {
      return state().version;
    },
    async thumbnail() {
      if (!api) return null;
      const elements = api.getSceneElements().filter((e) => !e.isDeleted);
      if (elements.length === 0) return null;
      return exportToBlob({
        elements,
        appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor } as never,
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: THUMBNAIL_PADDING,
      });
    },
    elements() {
      return (api?.getSceneElements() ?? []) as unknown as readonly SceneElement[];
    },
    addSkeletons(skeletons) {
      if (!api || skeletons.length === 0) return [];
      // New ids: a second draft must not clash with the first one's ids.
      const fresh = convertToExcalidrawElements(skeletons as never, { regenerateIds: true });
      api.updateScene({ elements: [...api.getSceneElements(), ...fresh], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      api.scrollToContent(fresh, { fitToContent: false, animate: true });
      return fresh.map((el) => el.id);
    },
    removeElements(ids) {
      if (!api || ids.length === 0) return;
      const gone = new Set(ids);
      api.updateScene({ elements: api.getSceneElements().filter((el) => !gone.has(el.id)), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
  };
}

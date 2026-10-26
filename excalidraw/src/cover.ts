// The card picture of a drawing: a schematic drawn straight onto a canvas from
// the scene's own elements (boxes, diamonds, ellipses, arrows, text). It does
// not use Excalidraw's export, which is slow for a card and, in WebKit (the
// desktop app's engine), can clear the scene it is exporting from. No fonts are
// needed: the labels use the system font.

import { coverFit, sceneBox, type SceneElement } from "./model.ts";

export const COVER_WIDTH = 480;
export const COVER_HEIGHT = 300;
const MARGIN = 16;
const ARROWHEAD = 10;

function colour(value: string | undefined, fallback: string): string {
  return value && value !== "transparent" ? value : fallback;
}

/** The drawing as a PNG card, or null when there is nothing to draw. */
export function drawCover(elements: readonly SceneElement[]): Promise<Blob | null> {
  const live = elements.filter((el) => !el.isDeleted);
  const box = sceneBox(live);
  if (!box) return Promise.resolve(null);
  const canvas = document.createElement("canvas");
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  const { scale, dx, dy } = coverFit(box, COVER_WIDTH, COVER_HEIGHT, MARGIN);
  const X = (v: number) => v * scale + dx;
  const Y = (v: number) => v * scale + dy;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 1.5;

  for (const el of live) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    const stroke = colour(el.strokeColor, "#1e1e1e");
    const fill = el.backgroundColor && el.backgroundColor !== "transparent" ? el.backgroundColor : null;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill ?? "transparent";
    if (el.type === "rectangle" || el.type === "diamond" || el.type === "ellipse") {
      ctx.beginPath();
      if (el.type === "rectangle") {
        ctx.rect(X(x), Y(y), w * scale, h * scale);
      } else if (el.type === "diamond") {
        ctx.moveTo(X(x + w / 2), Y(y));
        ctx.lineTo(X(x + w), Y(y + h / 2));
        ctx.lineTo(X(x + w / 2), Y(y + h));
        ctx.lineTo(X(x), Y(y + h / 2));
        ctx.closePath();
      } else {
        ctx.ellipse(X(x + w / 2), Y(y + h / 2), (w / 2) * scale, (h / 2) * scale, 0, 0, Math.PI * 2);
      }
      if (fill) ctx.fill();
      ctx.stroke();
    } else if ((el.type === "arrow" || el.type === "line") && el.points && el.points.length > 1) {
      const pts = el.points.map(([px, py]) => [X(x + px), Y(y + py)] as const);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
      ctx.stroke();
      if (el.endArrowhead === "arrow") {
        const [ex, ey] = pts[pts.length - 1];
        const [sx, sy] = pts[pts.length - 2];
        const angle = Math.atan2(ey - sy, ex - sx);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ARROWHEAD * Math.cos(angle - Math.PI / 7), ey - ARROWHEAD * Math.sin(angle - Math.PI / 7));
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ARROWHEAD * Math.cos(angle + Math.PI / 7), ey - ARROWHEAD * Math.sin(angle + Math.PI / 7));
        ctx.stroke();
      }
    } else if (el.type === "text" && el.text) {
      const size = (el.fontSize ?? 20) * scale;
      ctx.fillStyle = stroke;
      ctx.font = `${size}px sans-serif`;
      ctx.textBaseline = "top";
      const centred = el.textAlign === "center";
      ctx.textAlign = centred ? "center" : "left";
      const anchor = centred ? X(x + w / 2) : X(x);
      el.text.split("\n").forEach((line, i) => ctx.fillText(line, anchor, Y(y) + i * size * 1.25));
    }
  }
  return new Promise((done) => canvas.toBlob((blob) => done(blob), "image/png"));
}

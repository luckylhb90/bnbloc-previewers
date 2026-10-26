// Browser check of the built Excalidraw previewer under the frame's own rules.
// Manual, not in CI: it needs a local Chromium and playwright-core.
//
//   npm i --no-save playwright-core@1.56.1          (in any scratch directory)
//   CHROME_PATH=/path/to/chrome node --import ... check/frame-check.mjs \
//     excalidraw/dist/site excalidraw/samples/flow.excalidraw
//
// Input routing: headless Chromium drops pointer events below the top of an
// out-of-process iframe; --disable-site-isolation-trials keeps the frame
// in-process so clicks reach it (a test-browser artifact, not the product).
//

// sandboxed opaque-origin iframe (allow-scripts only), the gateway's CSP
// (connect-src none, no worker-src), and a host page that speaks the frame
// protocol. Scenario: load, render, fit, select all, nudge, save, conflict,
// compare units, reveal. Prints a JSON report; never touches the repos.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright-core";

const SITE = process.argv[2];
const SAMPLE = process.argv[3];
const CHROME = process.env.CHROME_PATH;
if (!CHROME) throw new Error("set CHROME_PATH to a Chromium binary");
const HOST_PORT = 4100;
const FRAME_PORT = 4101;
const FRAME_BASE = `http://localhost:${FRAME_PORT}/frame/`;
const HOST_ORIGIN = `http://localhost:${HOST_PORT}`;
const CSP = [
  "default-src 'none'",
  `script-src 'self' ${FRAME_BASE}`,
  `style-src 'self' ${FRAME_BASE} 'unsafe-inline'`,
  "img-src blob: data:",
  "media-src blob: data:",
  `font-src 'self' ${FRAME_BASE} data:`,
  "connect-src 'none'",
  `frame-ancestors 'self' ${HOST_ORIGIN}`,
].join("; ");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json" };

const hostHtml = `<!doctype html><meta charset="utf-8"><title>host</title>
<body style="margin:0"><iframe id="f" sandbox="allow-scripts" referrerpolicy="no-referrer"
  style="position:absolute;inset:0;width:100%;height:100%;border:0"
  src="${FRAME_BASE}index.html#host=${HOST_ORIGIN}"></iframe>
<script>
  window.log = [];
  window.file = null;
  const frame = document.getElementById("f");
  const file = (window.file = null);
  window.addEventListener("message", (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    window.log.push({ type: m.type, ...(m.type === "preview.draft" ? { prompt: m.prompt } : {}), ...(m.type === "preview.selection" ? { selection: m.selection } : {}),
      ...(m.type === "preview.save" ? { bytes: m.bytes.byteLength, summary: m.summary } : {}),
      ...(m.type === "preview.saved" ? {} : {}),
      ...(m.type === "preview.units" ? { units: m.units, error: m.error, truncated: m.truncated } : {}),
      ...(m.type === "preview.error" ? { message: m.message } : {}),
      ...(m.type === "preview.toolbar.set" ? { items: m.items } : {}),
      ...(m.type === "preview.thumbnail" ? { bytes: m.png.byteLength } : {}),
      ...(m.type === "preview.save.failed" ? { message: m.message } : {}),
    });
    if (m.type === "preview.save") window.lastSave = m;
    if (m.type === "preview.ready") window.loadFile();
    // The host's assist answer: a canned diagram, or a refusal when the prompt says "fail".
    if (m.type === "preview.draft") {
      setTimeout(() => {
        if (/fail/.test(m.prompt)) window.post({ type: "preview.draft.failed", message: "The drawing assistant is off in this organization." });
        else window.post({ type: "preview.drafted", reply: { title: "Login", nodes: [{ id: "a", label: "Enter password" }, { id: "b", label: "Check password" }, { id: "c", label: "Signed in" }], edges: [{ from: "a", to: "b", label: "submit" }, { from: "b", to: "c", label: "match" }] } });
      }, 200);
    }
  });
  window.loadFile = () => {
    const bytes = window.fileBytes;
    frame.contentWindow.postMessage({ type: "preview.init", protocol: 1,
      file: { name: window.fileName, mimeType: "application/vnd.excalidraw+json", sizeBytes: bytes.byteLength, version: window.fileVersion ?? 1 },
      theme: "light", viewport: { w: innerWidth, h: innerHeight } }, "*");
    frame.contentWindow.postMessage({ type: "preview.file", bytes: bytes.slice(0) }, "*", [bytes.slice(0)]);
  };
  window.post = (msg, transfer = []) => frame.contentWindow.postMessage(msg, "*", transfer);
</script>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.port === "" && req.headers.host === `localhost:${HOST_PORT}`) {
    if (url.pathname === "/" || url.pathname === "/host.html") {
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self' 'unsafe-inline'; frame-src http://localhost:4101" });
      res.end(hostHtml);
      return;
    }
    res.writeHead(404).end();
    return;
  }
  if (!url.pathname.startsWith("/frame/")) {
    res.writeHead(404).end();
    return;
  }
  const rel = decodeURIComponent(url.pathname.slice("/frame/".length)) || "index.html";
  const path = join(SITE, rel);
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((r) => server.listen(FRAME_PORT, r));
const hostServer = createServer(async (req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(hostHtml);
});
await new Promise((r) => hostServer.listen(HOST_PORT, r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process"] });
const report = { checks: {}, console: [], pageErrors: [] };
const check = (name, ok, detail) => {
  report.checks[name] = { ok: Boolean(ok), detail };
};
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") report.console.push(`${m.type()}: ${m.text().slice(0, 240)}`);
  });
  page.on("pageerror", (e) => report.pageErrors.push(String(e.stack ?? e).slice(0, 500)));

  const bytes = [...(await readFile(SAMPLE))];
  // The bytes are in place before the frame reports ready (the host reads them then).
  await page.addInitScript((arr) => {
    window.fileBytes = new Uint8Array(arr).buffer;
    window.fileName = "flow.excalidraw";
  }, bytes);
  await page.goto(`${HOST_ORIGIN}/`);
  // The host hands the file over on preview.ready; the frame renders it.
  const frame = await (await page.waitForSelector("#f")).contentFrame();

  await frame.waitForSelector("#save", { timeout: 60000 });
  await frame.waitForFunction(() => document.querySelector(".excalidraw canvas") !== null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  check("editor canvas mounted", await frame.evaluate(() => document.querySelector(".excalidraw canvas") !== null));
  check("status cleared after load", (await frame.textContent("#status")).trim() === "", await frame.textContent("#status"));
  check("save disabled on a clean load", await frame.isDisabled("#save"));

  const fonts = await frame.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
  });
  check("bundled fonts load in the frame", fonts.length > 0, fonts.slice(0, 6));

  const toolbar = await page.evaluate(() => window.log.filter((m) => m.type === "preview.toolbar.set").pop()?.items ?? null);
  check("toolbar published (zoom, fit)", toolbar && toolbar.map((t) => t.id).join(",") === "zoom,fit", toolbar);

  const thumb = await page.waitForFunction(() => window.log.some((m) => m.type === "preview.thumbnail"), null, { timeout: 30000 }).then(() => true).catch(() => false);
  check("thumbnail sent after first render", thumb);

  // Select everything: the selection chip reports the picked elements.
  // Pick the "API gateway" box (the frame fills the page; the box sits at 380,260).
  await page.mouse.click(380, 262);
  await page.waitForTimeout(600);
  const sel = await page.evaluate(() => window.log.filter((m) => m.type === "preview.selection").pop()?.selection ?? null);
  check("selection names the picked box and its connection", sel && sel.label === "rectangle “API gateway”" && /to rectangle “Orders DB”/.test(sel.detail), sel && { label: sel.label, detail: sel.detail, keys: sel.keys });

  // Units for Compare: each labelled element, keyed by id, read from bytes.
  await page.evaluate(() => {
    window.log.length = 0;
    window.post({ type: "preview.units.request", id: "u1", file: { name: "flow.excalidraw", mimeType: "application/vnd.excalidraw+json", sizeBytes: window.fileBytes.byteLength, version: 1 }, bytes: window.fileBytes.slice(0) });
  });
  await page.waitForFunction(() => window.log.some((m) => m.type === "preview.units"), null, { timeout: 15000 }).catch(() => {});
  const units = await page.evaluate(() => window.log.find((m) => m.type === "preview.units") ?? null);
  check("units for Compare", units && Array.isArray(units.units) && units.units.length >= 4, units && units.units.map((u) => `${u.key}:${u.label}`));

  // Edit: nudge the selection right, save, expect a save message with the new bytes.
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  check("save enabled after an edit", !(await frame.isDisabled("#save")));
  await frame.click("#save");
  await page.waitForTimeout(800);
  await page.waitForFunction(() => window.lastSave !== undefined, null, { timeout: 15000 }).catch(() => {});
  const save = await page.evaluate(() => (window.lastSave ? { summary: window.lastSave.summary, bytes: window.lastSave.bytes.byteLength, text: new TextDecoder().decode(window.lastSave.bytes) } : null));
  let saved = null;
  if (save) {
    const doc = JSON.parse(save.text);
    saved = { type: doc.type, elements: doc.elements.length, summary: save.summary };
  }
  check("save sends the edited scene", saved && saved.type === "excalidraw" && saved.elements >= 7, saved);
  await page.evaluate(() => window.post({ type: "preview.saved", version: 2 }));
  await page.waitForTimeout(300);
  check("saved reply shows the version", /Saved as v2/.test(await frame.textContent("#status")), await frame.textContent("#status"));
  check("save disabled after a save", await frame.isDisabled("#save"));

  // Conflict: a second save of a new edit is refused by the host; the frame says why.
  const savesBefore = await page.evaluate(() => window.log.filter((m) => m.type === "preview.save").length);
  await page.mouse.click(380, 262);
  await page.waitForTimeout(300);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+s");
  await page.waitForFunction((n) => window.log.filter((m) => m.type === "preview.save").length > n, savesBefore, { timeout: 15000 }).catch(() => {});
  report.conflictSaveSent = (await page.evaluate(() => window.log.filter((m) => m.type === "preview.save").length)) > savesBefore;
  await page.evaluate(() => window.post({ type: "preview.save.failed", message: "changed meanwhile: a newer version exists; reload the file to take it" }));
  await page.waitForTimeout(300);
  check("refused save was sent by the frame", report.conflictSaveSent, report.conflictSaveSent);
  check("conflict message shown", /changed meanwhile/.test(await frame.textContent("#status")), await frame.textContent("#status"));
  check("save stays enabled after a refused save", !(await frame.isDisabled("#save")));

  // Reveal: an element unit is selected and brought into view.
  // The Library button (top right): the frame has no storage; it must not break the editor.
  const consoleBefore = report.console.length;
  await page.mouse.click(1056, 25);
  await page.waitForTimeout(800);
  report.libraryClick = { newConsole: report.console.slice(consoleBefore), pageErrors: report.pageErrors.length, canvas: await frame.evaluate(() => document.querySelector(".excalidraw canvas") !== null) };
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.log.length = 0; window.post({ type: "preview.reveal", at: "el:db" }); });
  await page.waitForTimeout(700);
  const revealed = await page.evaluate(() => window.log.filter((m) => m.type === "preview.selection").pop()?.selection ?? null);
  check("reveal selects the unit's element", revealed && revealed.label === "rectangle “Orders DB”", revealed && revealed.label);

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // Draft with AI: the host's canned diagram is added as one undoable step, unsaved.
  await frame.fill("#prompt", "Login with a password check");
  check("draft button enabled with a sentence", !(await frame.isDisabled("#draft")));
  await frame.click("#draft");
  await page.waitForFunction(() => window.log.some((m) => m.type === "preview.draft"), null, { timeout: 5000 }).catch(() => {});
  check("draft request reaches the host", await page.evaluate(() => window.log.some((m) => m.type === "preview.draft" && m.prompt === "Login with a password check")));
  await frame.waitForFunction(() => /Added a draft/.test(document.getElementById("status").textContent), null, { timeout: 10000 }).catch(() => {});
  const added = await frame.textContent("#status");
  check("draft is added and says what it added", /Added a draft: 3 boxes, 2 arrows/.test(added), added);
  check("draft leaves the file unsaved", !(await frame.isDisabled("#save")));
  await frame.click("#remove-draft");
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.lastSave = undefined; });
  await frame.click("#save").catch(() => {});
  await page.waitForFunction(() => window.lastSave !== undefined, null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.post({ type: "preview.saved", version: 3 }));
  await page.waitForTimeout(200);
  const undone = await page.evaluate(() => (window.lastSave ? JSON.parse(new TextDecoder().decode(window.lastSave.bytes)).elements.length : null));
  check("remove draft takes the draft out (saved scene is the original seven elements)", undone === 7, undone);
  await frame.fill("#prompt", "fail on purpose");
  await frame.click("#draft");
  await frame.waitForFunction(() => /assistant is off/.test(document.getElementById("status").textContent), null, { timeout: 8000 }).catch(() => {});
  check("a refused draft says why", /assistant is off/.test(await frame.textContent("#status")), await frame.textContent("#status"));

  // Refusal: a non-scene file is refused with a sentence.
  await page.evaluate(() => {
    window.log.length = 0;
    window.fileBytes = new TextEncoder().encode(JSON.stringify({ name: "config", items: [1] })).buffer;
    window.fileName = "config.excalidraw";
    window.loadFile();
  });
  await page.waitForTimeout(800);
  const refusal = await frame.textContent("#status");
  check("non-scene refused with a sentence", /not an Excalidraw drawing/.test(refusal), refusal);
} catch (err) {
  report.harnessError = String(err && err.stack ? err.stack : err).slice(0, 800);
} finally {
  await browser.close();
  server.close();
  hostServer.close();
}
report.console = [...new Set(report.console)].slice(0, 40);
console.log(JSON.stringify(report, null, 2));

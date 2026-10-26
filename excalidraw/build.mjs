#!/usr/bin/env node
// Builds the Excalidraw previewer into an installable bundle (layout and
// install: ../lib/bundle.mjs; `pnpm install --ignore-workspace` in this
// directory first).
//
// Usage: node excalidraw/build.mjs

import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildBundle } from "../lib/bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXCALIDRAW = join(HERE, "node_modules", "@excalidraw", "excalidraw", "dist", "prod");

/** The families the editor draws with by default. Xiaolai (Chinese hand-drawn,
 *  12 MB) is not bundled: Chinese text falls back to the system font. */
const FONT_FAMILIES = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];

/** The MIT licenses of the packages that ship none, from their upstream
 *  repositories (excalidraw/licenses/<family>/LICENSE): Excalidraw itself, the
 *  Radix primitives (@radix-ui/*) and react-remove-scroll-bar. */
function vouchedLicense(name) {
  if (name === "@excalidraw/excalidraw") return join(HERE, "licenses", "excalidraw");
  if (name.startsWith("@radix-ui/")) return join(HERE, "licenses", "radix-ui");
  if (name === "react-remove-scroll-bar") return join(HERE, "licenses", "react-remove-scroll-bar");
  return null;
}

/** Excalidraw's fallback font base is its CDN (esm.sh), which the frame refuses:
 *  a font whose bytes cannot be fetched falls back to the last URL in its list,
 *  which is that CDN. The chunk that writes the fallback is rewritten to name
 *  the frame's own directory instead, where the fonts are bundled. The count is
 *  checked, so an Excalidraw upgrade that changes the code fails the build. */
const ownFontBase = {
  name: "own-font-base",
  setup(build) {
    build.onLoad({ filter: /dist[\\/]prod[\\/]chunk-[^\\/]+\.js$/ }, async ({ path }) => {
      const src = await readFile(path, "utf8");
      const key = '"ASSETS_FALLBACK_URL",';
      if (src.split(key).length !== 2) return undefined;
      const start = src.indexOf(key) + key.length;
      const open = src.indexOf("`", start);
      const endMark = "/dist/prod/`";
      const close = src.indexOf(endMark, open);
      if (open < 0 || close < 0) throw new Error(`ASSETS_FALLBACK_URL has an unknown shape in ${path}`);
      const rewritten = src.slice(0, open) + "new URL('./', document.baseURI).href" + src.slice(close + endMark.length);
      return { contents: rewritten, loader: "js" };
    });
  },
};

/** Copies the stylesheet and fonts from the Excalidraw package into this
 *  directory (where buildBundle reads its assets); returns their bundle names. */
async function stage() {
  await rm(join(HERE, "fonts"), { recursive: true, force: true });
  await copyFile(join(EXCALIDRAW, "index.css"), join(HERE, "excalidraw.css"));
  const names = ["excalidraw.css"];
  for (const family of FONT_FAMILIES) {
    const from = join(EXCALIDRAW, "fonts", family);
    await mkdir(join(HERE, "fonts", family), { recursive: true });
    for (const file of await readdir(from)) {
      await copyFile(join(from, file), join(HERE, "fonts", family, file));
      names.push(`fonts/${family}/${file}`);
    }
  }
  return names;
}

export async function build({ outDir = join(HERE, "dist"), quiet = false } = {}) {
  const fonts = await stage();
  return buildBundle({
    dir: HERE,
    title: "Excalidraw previewer",
    assets: ["index.html", "style.css", ...fonts],
    outDir,
    quiet,
    licenses: vouchedLicense,
    esbuild: {
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        // The frame has no network (connect-src 'none'). Excalidraw calls fetch
        // for fonts (it falls back to the bundled files), WASM and user-started
        // library or share actions, which the frame never offers; the font
        // subsetter's loader reads its WASM with a synchronous XMLHttpRequest.
        // Made unreachable, so the bundle check for network calls stays strict.
        fetch: "undefined",
        XMLHttpRequest: "undefined",
      },
      alias: { "@excalidraw/mermaid-to-excalidraw": join(HERE, "src", "mermaid-stub.ts") },
      plugins: [ownFontBase],
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

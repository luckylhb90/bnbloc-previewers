#!/usr/bin/env node
// Builds the font previewer into an installable bundle (layout and install:
// ../lib/bundle.mjs). It has no runtime dependencies: the few font tables it
// reads are parsed by its own code (src/sfnt.ts), and the browser draws.
//
// Usage: node font/build.mjs

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildBundle } from "../lib/bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function build({ outDir = join(HERE, "dist"), quiet = false } = {}) {
  return buildBundle({ dir: HERE, title: "font previewer", assets: ["index.html", "style.css"], outDir, quiet });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

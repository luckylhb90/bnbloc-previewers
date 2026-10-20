# bnbloc-previewers

**File previewers for [bnbloc](https://github.com/luckylhb90/bnbloc).**

Installable previewer components (`bnbloc.previewer.package/v1`, runtime
`bundle`): each one shows a file type in place in a room's workbench, in a
sandboxed iframe with no network, and talks to bnbloc only through
[`@bnbloc/previewer-sdk`](https://github.com/luckylhb90/bnbloc/tree/main/web/previewer-sdk).

| Previewer | Files | |
|---|---|---|
| `sprite-sheet` | images, sprite-sheet / texture-atlas JSON | the reference previewer: zoom, fit, grid, frame boundaries, live layer state |
| `pptx` | PowerPoint | slides in place, a click picks a slide, Compare by slide |
| `docx` | Word | pages in place, a click picks a paragraph or table |
| `xlsx` | Excel | sheets with formats and merges, cell ranges picked by drag |
| `mermaid` | `.mmd`, `.mermaid` | strict mode, a parse error shown with its line |
| `drawio` | `.drawio`, `.dio` | every page as a tab, draw.io's own geometry |
| `font` | `.ttf`, `.otf`, `.woff`, `.woff2` | a specimen: names and license, an editable sample with missing characters marked, variation-axis sliders, a glyph grid |

All of them point (a click names what it is for the Ask AI panel) and offer
units for Compare (the font previewer's units are the font's facts: names,
axes, instances and script coverage). How previewers work:
[previewer components](https://github.com/luckylhb90/bnbloc/blob/main/docs/architecture/previewer-components.md).

The font previewer draws the font with `new FontFace(family, bytes)`: the
file's own bytes, no fetch, so the frame's CSP has nothing to refuse. Its
names, character map and axes come from its own reader of the `name`,
`maxp`, `cmap` and `fvar` tables. WOFF2 tables are one Brotli stream, which
WebKit (the desktop app on macOS, Safari) unpacks and Chromium does not: there
a WOFF2 shows its format and table list, and its coverage and glyph list are
found by drawing (marked approximate).

## Build

Node 24 and pnpm:

```sh
scripts/ci.sh            # install, type-check, test and build all of them
node pptx/build.mjs      # one: <previewer>/dist/{site/,bundle.tar,bundle.tar.sha256,package.json}
```

The shared build (`lib/bundle.mjs`) makes a deterministic ustar archive, the
package with an upload placeholder, and `NOTICES.txt` with the license files
of every third-party package esbuild inlined (a bundled package without one
fails the build). The SDK comes from the bnbloc repository, pinned to a
commit in `package.json`.

## Install into bnbloc

As a bnbloc super-admin, from a release's files or a build:

```sh
bnbloc previewers publish --package pptx/dist/package.json --bundle pptx/dist/bundle.tar --rollout optin
```

## License

[Apache License 2.0](LICENSE). Each bundle's `NOTICES.txt` carries the
licenses of the packages it inlines.

#!/usr/bin/env bash
# Install, type-check, test and build every previewer (what CI runs).
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
for p in pptx docx xlsx mermaid drawio excalidraw; do
  pnpm --dir "$p" install --frozen-lockfile --ignore-workspace --silent
done
pnpm run typecheck
pnpm test
pnpm run build

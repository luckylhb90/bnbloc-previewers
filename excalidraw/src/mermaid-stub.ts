// Stands in for @excalidraw/mermaid-to-excalidraw (aliased in build.mjs): this
// viewer never converts Mermaid, and the real package would add several MB to
// the bundle. The editor only reaches it from its Mermaid paste, which the
// frame does not offer; if it is reached, the member is told why.

export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error("Mermaid conversion is not available in the drawing editor.");
}

export async function mermaidToExcalidraw(): Promise<never> {
  throw new Error("Mermaid conversion is not available in the drawing editor.");
}

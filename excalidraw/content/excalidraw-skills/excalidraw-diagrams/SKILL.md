---
name: excalidraw-diagrams
description: Use when the person asks to draw, change, tidy or explain an Excalidraw drawing (a .excalidraw file), or points at a shape or an arrow in one and asks about it or for a change.
---

# Excalidraw diagrams

An `.excalidraw` file is one JSON document: `type` "excalidraw", `version`
2, `elements` (the shapes, text, arrows), `appState` (background, grid) and
`files` (embedded images, keyed by id). The member sees it drawn by
Excalidraw; you change the JSON, and saving the file publishes the next
version of the drawing.

## Changing a drawing in place

- Work on the file the turn names (its path is in the turn input). Write
  the whole document back to that path, as valid JSON with two-space
  indentation. Saving it there is what updates the room's drawing.
- Change only what the request concerns. Every other element stays
  byte-identical: same `id`, `seed`, `versionNonce` and `version`. A
  reviewer compares versions element by element, so an untouched element
  that changes shows up as a change nobody asked for.
- When you change an element, bump its `version` by one, set a new random
  `versionNonce` and set `updated` to the current time in milliseconds.
- If the member pointed at something, the selection names it with its
  `Id:` line. Find that element by id first; the text it carries is what
  they mean.
- To remove an element, drop it from `elements` and remove every reference
  to it (a shape's `boundElements`, an arrow's bindings). Setting
  `isDeleted: true` is the other way; prefer dropping it.

## Adding a shape

Give every new element a unique `id` (a short random string). These fields
are required on every element:

`type`, `x`, `y`, `width`, `height`, `angle` (0), `strokeColor` (e.g.
"#1e1e1e"), `backgroundColor` ("transparent" or a colour), `fillStyle`
("solid"), `strokeWidth` (2), `strokeStyle` ("solid"), `roughness` (1),
`opacity` (100), `groupIds` ([]), `frameId` (null), `roundness` (null or
`{"type": 3}` for rounded corners), `seed` (a random integer),
`version` (1), `versionNonce` (a random integer), `isDeleted` (false),
`boundElements` ([]), `updated` (milliseconds), `link` (null),
`locked` (false).

Rectangles, diamonds and ellipses are `rectangle`, `diamond`, `ellipse`.
Keep sizes sensible (a box of 160 to 220 by 60 to 90 holds a short label);
leave at least 40 px between shapes that are not joined.

## Text

A label inside a shape is its own `text` element with `containerId` set to
the shape's `id`, and the shape lists it in its `boundElements` as
`{"id": "<text id>", "type": "text"}`. Its fields: `text`, `originalText`
(the same string), `fontSize` (20 by default), `fontFamily` (5 is the
hand-drawn Excalifont; 1 Virgil, 2 Helvetica, 3 Cascadia, 6 Nunito, 7
Lilita One, 8 Comic Shanns, 9 Liberation Sans, 10 Assistant), `textAlign`
("center"), `verticalAlign` ("middle"), `containerId`, `autoResize` (true),
`lineHeight` (1.25). Its `x`, `y`, `width`, `height` are its box; centre it
on the shape.

A free-standing text element has `containerId` null.

## Arrows

An arrow is `type` "arrow" with `points` (the first is `[0, 0]`, the rest
are offsets from `x`, `y`), `startArrowhead` (null) and `endArrowhead`
("arrow"). It is joined to shapes through `startBinding` and `endBinding`:
`{"elementId": "<shape id>", "focus": 0, "gap": 4}`. Each joined shape lists
the arrow in its `boundElements` as `{"id": "<arrow id>", "type": "arrow"}`.

The two ends of a binding and the `boundElements` entry must agree, or the
arrow will not follow its shapes when the member moves them. Put an arrow's
end on the edge of its target: for a box at `x, y` of size `w, h`, the
middle of the left edge is `(x, y + h / 2)`.

## Checking before you save

- The file parses as JSON, and `type` is still "excalidraw".
- Every `id` is unique.
- Every `containerId`, `elementId` and `boundElements` id refers to an
  element that exists.
- No arrow is bound to a shape that does not list it back.

## Explaining a drawing

When asked what a drawing shows, read its text elements and its arrows
(`from` and `to` tell the flow) and say what they show in plain words. Do not
edit the file for an explanation.

# 0063. A vault plugin's views draw in its worker, and the page shows them cleaned

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md)
runs a plugin from a vault in a worker, inside a hidden sandboxed frame,
because code in a frame's page has two ways out that a worker lacks: it
can navigate its frame to any address, and it can send by WebRTC. It
left views to this record. Its plan was a visible sandboxed frame for
each view, running the plugin's code again in that frame's page, kept
from navigating away by the page's `frame-src` and kept from WebRTC
somehow.

Looking closer:

- **The desktop page has no content security policy at all**, so nothing
  stops a frame navigating itself away with what it knows. Adding one
  means a policy for the whole app page, its media server's port among
  it, before any plugin can draw.
- **WebRTC has no off switch a page controls.** Chromium ignores the
  `webrtc` directive. The frame's own script could remove
  `RTCPeerConnection` before the plugin's code runs; a probe found that
  a child frame of an opaque frame is cross-origin to it, so that trick
  cannot fetch a fresh one. But every other way back to a constructor
  would have to be found and closed, and stay closed in every Chromium
  to come.
- **A frame per view is heavy.** A property type's view shows in every
  cell of its column; a table of 500 rows would be 500 documents.

The plugin API already allows another way. A view's `mount` gets an
`HTMLElement`, and `startPlugin` takes a `surface` that gives the
elements views mount in: "a plugin running apart will make its own". A
view's props, and what it changes (`setAttrs`, `setValue`, `openRow`),
already cross as messages.

## Decision

**A plugin from a vault draws its views in its worker**, in a DOM of the
worker's own, and the page copies what it draws, cleaned, into the
element the app made for the view. The plugin's code still runs only in
the worker of ADR 0058, so there is still no page to navigate and no
WebRTC.

- **The worker's DOM** is `@remote-dom/polyfill` (MIT): `document`,
  elements, text, attributes, events and `innerHTML`, with hooks for each
  change. The worker gives `startPlugin` a surface whose element for each
  view is a root in that DOM, and adds what the polyfill lacks and views
  need: `value`, `checked`, `selected` and `indeterminate`, `style`, and
  `focus()` and `blur()`.
- **What it draws crosses as changes**: a subtree inserted, a node
  removed, an attribute, a text, a property, an event listened for or
  not, a focus. A subtree is sent when it joins a view, so what is built
  apart crosses once. Changes are sent once per task, by the view's slot,
  through the plugin's connection.
- **The page shows a view in a shadow root** on the app's element, so
  the plugin's styles stay in it, and the app's theme reaches in through
  its custom properties. The view's box has `contain: content`, so
  nothing it draws, a fixed position included, leaves it.
- **The page builds only what it allows**, and puts an empty comment in
  place of anything else, so that what follows stays in step:
  - elements: text, lists, tables, forms' controls without a form,
    `details`, images and a set of SVG shapes; never scripts, frames,
    objects, forms, links that go anywhere, `dialog`, or SVG's `use`,
    animations, `foreignObject` and `feImage`;
  - attributes: the usual ones of those elements, `aria-*` and `data-*`;
    never an `on…` handler, `autofocus`, `contenteditable`, `accesskey`,
    or `popover`, which would leave the view's box; an image's `src` only
    as a data image, or `https:` with the network; `url(…)` in SVG only
    to a fragment of the drawing;
  - styles: a `style` element's sheet is read by the browser and only its
    style, media, supports and keyframes rules kept; a rule, or a `style`
    attribute, that still names `url(`, `image(`, `image-set(`,
    `cross-fade(`, `element(`, `paint(` or `src(`, or a `\`, once the
    browser has written it out again, is left out. The browser writing it
    out undoes escapes, so `u\72l(` is caught as `url(`. With the
    network, `url(https:…)` and `image-set(` stay.
  - at most 10,000 nodes in a view.
- **Events cross back** for the types the plugin listens for: pointer,
  mouse and key events, clicks, input and change, focus, wheel, scroll,
  toggle, and `resize` on the view's root. The page listens once per type
  on the shadow root, and the worker dispatches each event at its target,
  so it bubbles there as on a page. Moves, wheels and scrolls are sent at
  most once a frame. An input's value and a box's checked state come with
  its events, so the worker's DOM knows them. The worker cannot cancel
  the page's event: what the browser does by default, it has done.
- **All five kinds of views** now run from a vault: blocks, panels,
  views of panes, layouts and property types. A plugin from a vault no
  longer waits on this part to add them.

This replaces ADR 0058's plan of a frame for each view. Its hidden frame
and worker for each plugin stay as they are.

## Alternatives

- **A frame for each view, running the plugin's code in its page**, as
  ADR 0058 planned. It needs a policy for the whole desktop page, and
  a guard against WebRTC that a page cannot be sure of; and it costs a
  document for each view.
- **A frame for each view, drawing what the worker sends.** The frame
  would add nothing the page's own cleaning does not, at a document's
  cost for each view; and the app's theme would have to be sent into
  each.
- **Views as HTML strings, like code blocks, with clicks named by
  attribute.** Safe, but a view could not keep a text box's caret or
  react to a key, so nothing much could be built with it.
- **`@remote-dom/core`, with its receivers.** Its DOM receiver is
  deprecated, and its policy is for custom elements a host defines; the
  page would still need its own cleaning for ordinary HTML, and its own
  way of sending events.
- **Writing the worker's DOM ourselves.** Frameworks such as Preact need
  a fair part of the DOM: node order, `insertBefore`, `innerHTML`,
  events that bubble. The polyfill has these, with hooks made for this.

## Consequences

- A plugin from a vault can show anything a page of controls can, with
  any framework that renders to the DOM, but cannot measure what it
  draws: `getBoundingClientRect` and layout sizes are not there. A view
  listening for `resize` on its root is told its width and height.
- A canvas does not draw yet. A later change can hand the worker each
  canvas as an `OffscreenCanvas`.
- An event's default cannot be prevented from the worker. A view wanting
  that needs it built in, as text boxes and checkboxes already behave.
- Links in a view lead nowhere; a later call can open a note or, with
  the network, an address in the browser.
- The worker's script carries the polyfill, some tens of kilobytes, loaded
  only for a plugin from a vault that is on.
- The desktop page still has no content security policy. Nothing of a
  plugin's needs one now; a policy for the page stays worth its own
  record.

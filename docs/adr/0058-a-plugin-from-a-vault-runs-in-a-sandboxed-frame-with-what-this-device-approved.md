# 0058. A plugin from a vault runs in a sandboxed frame, with what this device approved

- Status: Accepted; its plan for views is replaced by [0063](0063-a-vault-plugins-views-draw-in-its-worker-and-the-page-shows-them-cleaned.md)
- Date: 2026-11-16

## Context

[ADR 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)
built the plugin API so that a plugin reaches the app only by messages,
and left to this record "how a plugin's folder becomes code running apart:
where it runs, on which origin, how the web app's policy changes, and how
permissions are asked and kept". Until now only built-in plugins run, in
the page. The [requirements](../requirements.md#extensibility) ask that
plugins declare permissions (network, file system, vault read and write),
that the user approves them at install, and that untrusted plugins run
isolated.

What the page holds, and so what a plugin must never reach:

- **On the desktop**, the page's top frame has MyGO's bridge, through
  which it calls every Go service the app binds: the vault's files, the
  keychain's server tokens, the system. MyGO runs its bridge script in the
  top frame only (`if(window===window.top)`), and drops any message that
  does not start with the window's secret, 128 random bits that only that
  script holds.
- **In the web app**, the page's origin holds the browser's vaults in
  IndexedDB and the session's cookie for the server. Its policy allows no
  frames (`frame-src 'none'`).
- **In both**, what a plugin draws as HTML, a code block's drawing, is
  written into the page. HTML with an event handler runs in the page; an
  image or a style that loads from elsewhere carries what the plugin
  knows, a note's text among it, out of the vault.

A probe showed what a frame with `sandbox="allow-scripts"`, and no
`allow-same-origin`, loaded from the app's own server with a policy of its
own, can do, in Chromium and in the desktop app's own WebView2:

- its origin is `null`; the page behind it, its globals, its storage,
  IndexedDB and cookies throw a SecurityError; MyGO's bridge is not there;
- its own `connect-src 'none'` blocks every request, the app's server
  included; it cannot navigate the page, nor open windows;
- a classic script of the app's own, allowed by `script-src 'self'`, runs;
  a module script does not, its origin being opaque; a module the frame
  makes as a `blob:` URL imports, while `data:` imports and `eval` stay
  blocked;
- a `MessageChannel` port the page posts to it carries messages both ways;
- in WebView2, `chrome.webview` is there too, and what it posts reaches
  the app, but without the window's secret MyGO drops it; while the page
  called the app, the frame heard none of the answers.

Two ways out stay open to the frame's page. It can navigate itself to any
address, carrying what it knows in it, which only the policy of the page
that holds the frame stops, by its `frame-src`. And it can open a WebRTC
connection, whose packets reached a listener whatever the frame's policy
said: Chromium does not know the `webrtc` directive. A classic worker the
frame makes has neither: no document to navigate, no `RTCPeerConnection`.
It inherits the frame's policy, so its requests are blocked as the
frame's are, its origin is `null` too, and a `blob:` module imports in it.

## Decision

**A plugin from a vault is a folder, `.nether/plugins/<id>/`**, as ADR 0055
says, with its `manifest.json` and `main.js`. The app lists the folders it
finds in the Plugins tab, with what each adds and the permissions it asks
for. None runs until it is turned on and approved.

**It runs in a sandboxed frame.** Each plugin that is on gets a hidden
`<iframe sandbox="allow-scripts">` of the app's `plugin-frame.html`, never
`allow-same-origin`, so its origin is opaque. The frame's page has a
policy of its own: scripts only from the app and from `blob:`, no
network, and nothing loaded from elsewhere. Its one script is the app's
classic `plugin-frame.js`. The app reads the plugin's `main.js` itself and
posts its text, with a `MessageChannel` port, to the frame. The frame
starts a classic worker of the app's own and hands both on to it; the
worker holds the SDK's side of the protocol, imports the plugin from a
`blob:` URL it makes, and starts it with `startPlugin` over the port. The
plugin's code runs only in that worker, never in the frame's page.
Everything after is ADR 0055's protocol, unchanged: a plugin cannot tell
a worker from the page, though it has no page of its own to draw in.

**What it draws is cleaned before the page shows it.** A frame plugin's
HTML, in a note and in an exported page, loses its scripts, event
handlers, styles, forms and frames, and, without the `network`
permission, every address outside the page: a `src` or `href` that is
not a `#` fragment or a `data:` image, any `srcset`, and any `url()` in
an attribute. With it, `https:` addresses stay. Built-in plugins' HTML is
the app's own, and shows as it is.

**Its views each get a frame of their own**, in the sandbox's next part:
a view, a panel, a block's view, a layout or a property's view is a
visible sandboxed frame of the same page, running the plugin's code again
for that one view, sized to what it draws. A view draws in a page, so
that part decides how its frame is kept from navigating away, by the app's
page's `frame-src`, and from WebRTC. Until then, a plugin from a folder
may add commands, code blocks and settings; one that adds views is listed
with why it cannot run yet.

**A plugin asks for permissions in its manifest**, as
`"permissions": ["network", "vault:read", "vault:write"]`:

- **`network`** gives its frame a policy that lets it connect to `https:`
  addresses, and keeps addresses in what it draws. Without it, it reaches
  nothing outside.
- **`vault:read`** lets it list and read the vault's notes and files.
- **`vault:write`** lets it change them, each note through its document,
  as an edit the app makes.

Reading and writing the vault come in the sandbox's last part, with the
calls the SDK adds for them; the app refuses what a plugin was not
approved for.

**Approval is this device's, for this code.** Turning a plugin on shows
what it asks for; turning it on is approving it. The device keeps the
approval outside the vault, in the app's own storage, with the plugin's
version, the hash of its `main.js` and the permissions approved. A plugin
runs only when its code's hash is the one approved: a plugin whose code
changed, or that came with a vault copied from elsewhere, is off until it
is approved again. A plugin runs with all it asks for, or not at all.

**The web app's policy allows the app's own frames**: the page's
`frame-src 'self'`, and the frame page's own policy, with
`frame-ancestors 'self'`, served with it. Nothing else changes for the
page.

**Built-in plugins still run in the page**, with `context.host`, as before.
A plugin from a folder never gets the host.

## Alternatives

- **A worker per plugin, made by the page.** It runs on the page's origin:
  in the web app it can read the browser's vaults and call the server with
  the session's cookie.
- **The plugin's code in the frame's page.** It could navigate the frame
  away with what it knows, or send it by WebRTC, as the probe did.
- **A module script for the frame's page.** An opaque origin fetches the
  app's own modules across origins, which the app would then have to
  allow for every origin.
- **One frame for a plugin's code and its views.** A frame draws only in
  itself, where it is; a panel beside a note and a cell of a table are in
  different places of the page.
- **Approval kept in the vault**, in `.nether/plugins.json`. A vault copied
  by another tool, as git or a shared folder, would bring both a plugin's
  code and the approval to run it.
- **Approving some of a plugin's permissions.** Each plugin would need to
  work without any of them, which none is written to do.
- **`allow-same-origin` with a separate origin.** The desktop app has one
  origin, the page's; a second would need a server of its own on every
  device.

## Consequences

- The sandbox comes in parts, one pull request each: plugins from folders
  in a frame, with commands, code blocks, settings and the approval; their
  views, each in a frame; and the vault, read and written by permission.
- `.nether/plugins.json` still says which plugins are on; for a plugin
  from a folder, that is so only once this device approved its code.
- Each plugin that is on costs a frame and a worker, a few megabytes
  while it runs.
- In the web app, a plugin from a vault starts only while the server
  answers: Chromium loads no sandboxed frame from the service worker, so
  offline its page does not load. Once started, it keeps running. The
  desktop app serves the frame's page itself, offline too.
  Built-in plugins cost nothing more.
- The directory, Phase 4's next item, installs a plugin's folder; the
  plugin then asks for the same approval before it runs.

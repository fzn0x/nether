# 0055. Plugins declare what they add, and reach the app only by messages

- Status: Accepted
- Date: 2026-11-16

## Context

The [requirements](../requirements.md#extensibility) ask, in Phase 4, for
a versioned TypeScript SDK through which plugins add commands, block
types, views, sidebar panels, settings tabs, Markdown post-processors and
database property types. Principle 6 asks that Nether's own features use
it wherever practical. The next item of the Phase 4 plan is the sandbox:
plugins declare permissions that the user approves at install, and
untrusted ones run isolated. After it comes a directory of plugins and
themes.

Most of what plugins need exists, but closed in place:

- **Commands** are a closed list of 40 IDs (`apps/desktop/src/commands.ts`)
  whose actions are closures in `VaultView.tsx`. The palette, the menus and
  the shortcuts already take any ID.
- **Block types**: the file format already has plugin blocks, named
  `plugin-id/type` and written as a fenced code block of JSON
  ([ADR 0006](0006-markdown-file-format.md)). The editor shows one as a
  card it cannot open, and export writes it as an empty element.
- **Views** are notes, canvases by file, the graph, and the six database
  layouts, a closed list.
- **Panels** are the left sidebar's fixed tabs, and the outline,
  backlinks and unlinked mentions beside a note.
- **Settings** are separate dialogs, with data per vault in
  `.nether/<name>.json`.
- **Post-processing**: one renderer turns blocks into HTML for export and
  canvas cards, with Mermaid written into it.
- **Property types** are a closed list in `packages/core`.

What any design must live with:

- **Code in the desktop page is trusted with everything.** MyGO gives the
  page's top frame every Go service the app binds, the vault's files and
  the server tokens in the keychain among them. The web app's policy
  allows scripts only from its own origin, and no frames; a worker on that
  origin can read the browser's vaults and call the server with the
  session's cookie. So no code from a vault may run in the page until
  the sandbox exists.
- **Hidden paths never sync**, `.nether` among them
  ([ADR 0040](0040-attachments-sync-by-path-and-hash-in-the-vault-document.md)),
  so no member of a workspace can plant files on another's device.
- **Idle memory has a limit of 300 MB**, and the features loaded only
  when used (databases, queries, canvases, the graph) must stay that way.
- **Open notes are Yjs documents**
  ([ADR 0043](0043-a-note-open-in-the-editor-syncs-live-with-awareness-for-carets.md)):
  an edit goes through the note's document, not its file.
- **Every string is translatable and every screen passes axe**
  ([ADR 0015](0015-check-accessibility-and-lay-out-by-direction.md)), and
  every command sits in a menu
  ([ADR 0047](0047-every-command-is-in-a-menu-at-the-top-of-the-sidebar.md)).
- **The repository is AGPL-3.0-or-later**
  ([ADR 0001](0001-license-agpl-and-dco.md)). A plugin that bundles code
  from an AGPL SDK would have to be AGPL-compatible itself.

## Decision

**A plugin is a folder in the vault**, `.nether/plugins/<id>/`, holding:

- `manifest.json`: its ID, name, version, description, author, the API
  versions it works with, and what it adds;
- `main.js`, an ES module;
- `styles.css`, when it has styles;
- `data.json`, its settings, read and written through the API.

`.nether/plugins.json` lists the plugins turned on: it maps each
plugin's ID to whether it is on, and a built-in plugin it does not name is
on (as built in step 5, below). Like the rest of
`.nether`, plugins never sync: each device installs its own. The manifest
uses Obsidian's field names where they mean the same (`id`, `name`,
`version`, `description`, `author`, `authorUrl`), and command IDs are
`plugin-id:command`, so an Obsidian plugin ports with small changes. No
Obsidian plugin runs unchanged. They reach into Obsidian's editor, which
is CodeMirror where Nether's is ProseMirror
([ADR 0002](0002-editor-tiptap.md)), and into its workspace, its DOM and
Node.

**Until the sandbox exists, only built-in plugins run.** Nether's own
features become plugins in the app's code, loaded in the page. Nothing in
`.nether/plugins` is loaded until code from it can run isolated, with the
permissions its user approved. The sandbox's own record decides how.

**The manifest declares what a plugin adds**: commands with their menus
and default shortcuts, slash entries, block types, the code-block
languages it renders, panels, views, settings fields and property types.
Each name is a string, or an object of strings by language tag. The app
shows these without running the plugin, and loads its code when one of
them is first used. Startup and idle memory then pay only for what is
used, and the sandbox's install screen can show what a plugin adds before
it runs.

**`activate(ctx)` attaches what the manifest declared.** The module's
default export is `definePlugin({ activate(ctx) })`. `activate` registers
a handler for each ID its manifest declared. Each registration returns a
disposable, and the host disposes them all when the plugin is turned off.
The context holds the vault's notes, read and changed through each note's
document; the plugin's data; the app's language and direction; and the
registries.

**Every call is made as if across a boundary.** Calls are async,
arguments and results are plain JSON values, and a callback is passed as
an ID that the host calls back. Built-in plugins use the same protocol in
the page, without copying, and a sandboxed plugin will use it through a
`MessageChannel`. Tests run plugins through both. Nothing in the API hands
out the editor, React, Yjs or an element of the app's page.

**A plugin's UI mounts into an element it is given.** A view, a panel or
a block view is `mount(element, props)`, returning `update(props)` and
`unmount()`. A plugin may use any framework or none, and the same contract
can run in an isolated frame later. The host gives each slot its label and
landmark. A plugin's strings come from its manifest, or from its own
tables by the app's language. Settings tabs are fields the app draws
itself: text, number, toggle and choice, themed, translated and accessible
like the rest. A tab mounts its own UI only when fields are not enough.

**Built-in plugins get more.** Some core features need what cannot cross
a boundary: the editor's schema, a note's live document, a React root.
Built-in plugins receive `ctx.host` for those. It is not part of the SDK,
it has no version, and no plugin from a folder ever gets it. A lint rule
keeps it out of all but the built-in plugins.

**The API has its own version.** `@nether/plugin-api` has a semantic
version apart from the app's. A manifest's `api` field is a range, such as
`^0.3`, and the app loads a plugin only when its API version is in that
range. The host speaks one major version, and a handshake tells a plugin
which minor features the host has.

- **Breaking**, so a new major version: removing or renaming an export, a
  manifest field or a message; changing what a call takes or returns;
  making an optional field required; changing what plugins write to vault
  files, such as plugin blocks, `plugin-id/type` names and `data.json`.
- **Not breaking**: adding optional fields, calls or kinds of contribution.

The API stays at 0.x, where a minor version may break, until the
directory opens. 1.0 comes with the directory.

**The SDK is MIT-licensed.** `packages/plugin-api` holds what a plugin
imports: its types, `definePlugin`, the manifest's schema and the plugin's
side of the protocol. It has the MIT license, with a LICENSE file of its
own and `"license": "MIT"` in its `package.json`, so a plugin may use any
license. It depends on nothing else in the repository, so no AGPL code
passes into it, and the app's packages may import it. The host, which runs
plugins and answers their calls, is in the app and stays
AGPL-3.0-or-later, like the rest of the repository. This amends ADR 0001's
one license, for that one package.

## Alternatives

- **An Obsidian-like `Plugin` class with `onload`.** Familiar, but the app
  knows nothing a plugin adds until its code has run, and a base class
  that holds the app cannot cross a boundary.
- **React components from plugins, drawn in the app's tree.** This ties
  every plugin to the app's React version and to its page, and cannot run
  isolated.
- **Running third-party plugins now, in the page, behind a trust prompt.**
  Such a plugin would hold every vault on the device and the server
  tokens. That is too much to ask a user to judge.
- **Plugins per app, turned on per vault.** Safer when a vault is handed
  on, but a vault would not carry its plugins as an Obsidian vault does,
  and the sandbox and the directory would have two places to look.
- **Plugins that sync with the workspace.** Every member would run code
  that any other member added.
- **Running Obsidian plugins unchanged.** A layer covering Obsidian's
  editor and workspace would amount to a second editor. A shim could come
  later, as a plugin, for the few plugins it would fit.
- **One API object for core features and plugins alike.** Either it gives
  the editor, Yjs and React to every plugin, or core features cannot use
  it.
- **An AGPL SDK.** Plugins bundling its helpers would have to be
  AGPL-compatible. That would keep authors away for no gain, since the app
  that runs their plugins stays AGPL.

## Consequences

- The plugin API is built in steps, one pull request each, every one
  updating the plugin developer guide:
  1. The SDK, the host, manifests and commands, with the 40 core commands
     registered through them.
  2. Code-block processors, in the editor and in HTML, with Mermaid and
     query blocks moved onto them.
  3. Block views and slash entries for plugin blocks.
  4. Panels, with tags, assigned tasks, the outline, backlinks and
     unlinked mentions moved onto them.
  5. A settings dialog with tabs, whose plugins tab turns built-in plugins
     on and off.
  6. Views by file extension, views in a pane and database layouts, with
     the canvas, the graph and the six layouts moved. Layouts from
     plugins change what a database's base file says, so they need a
     record of their own.
  7. Property types. A `plugin-id/type` written into a vault's properties
     needs a record of its own too, saying what shows when the plugin is
     missing.
- The sandbox's record decides how a plugin's folder becomes code running
  apart: where it runs, on which origin, how the web app's policy changes,
  and how permissions are asked and kept.
- Commands from plugins, built-in ones included, each sit in a menu, as
  ADR 0047 asks.
- No core feature moved onto the API may cost memory at idle; each move
  is measured as the performance README says.
- Plugins on mobile wait for Phase 5's apps.
- We would revisit this record if crossing the boundary made a core
  feature miss its target. Built-in plugins could then make direct calls
  through `ctx.host`.

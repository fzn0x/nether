---
title: Writing plugins
description: How a Nether plugin is made, a preview of the plugin API at version 0.1. A plugin's folder, its manifest, its code, the commands, code blocks, blocks and panels it adds, its settings, and the sandbox it runs in.
---

:::caution[A preview]
Plugins from a vault's folder run in a sandbox, apart from the app, once
you approve them, and may use all this page describes. Nether's own
built-in plugins use the same API. The API is at version 0.1, and may
change before 1.0.
:::

## A plugin's folder

A plugin is a folder in the vault, `.nether/plugins/<id>/`, named for its
ID:

| File            | What it holds                                                |
| --------------- | ------------------------------------------------------------ |
| `manifest.json` | Who the plugin is, the API versions it needs, what it adds and what it asks for |
| `main.js`       | Its code: one ES module, with what it imports bundled in, whose default export is the plugin |

Plugins never sync with a workspace. Like everything in `.nether`, they
stay on the device they were installed on, so nobody else's plugin can
reach your computer.

## The manifest

```json
{
  "id": "word-count",
  "name": { "en": "Word count", "fr": "Nombre de mots" },
  "version": "1.0.0",
  "api": "^0.1",
  "description": "Counts the words of the open note.",
  "author": "Ada",
  "authorUrl": "https://example.org",
  "permissions": [],
  "contributes": {
    "commands": [
      {
        "id": "count",
        "name": { "en": "Count words", "fr": "Compter les mots" },
        "menu": "note",
        "keys": ["Mod+Shift+K"]
      }
    ]
  }
}
```

| Field | What it says |
| --- | --- |
| `id` | Lowercase words joined by hyphens, unique among plugins |
| `name` | Its name: one string, or strings by language tag |
| `version` | Its own version, as `1.0.0` |
| `api` | The versions of the plugin API it works with, as `^0.1` |
| `description` | What it does, optional, a string or strings by language |
| `author`, `authorUrl` | Who made it, optional |
| `permissions` | What it asks for beyond running, optional: any of `network`, `vault:read` and `vault:write` ([the sandbox](#the-sandbox)) |
| `contributes` | What it adds: `commands`, `codeBlocks`, `blocks`, `panels`, `views`, `layouts`, `propertyTypes` and `settings` |

The app reads the manifest before the plugin's code runs. Its commands
show in the menus and the palette at once, and its slash menu entries in
the slash menu, and its panels' tabs and headings. Its code loads only
when it is first needed: a command chosen, or a code block, a block or a
panel or a view of its own shown.

A name by language picks the app's language, then its main language
(`pt` for `pt-BR`), then English, then the first one there is.

## The code

```js
import { definePlugin } from "@nether/plugin-api";

export default definePlugin({
  async activate(context) {
    await context.commands.register("count", async () => {
      // What the command does.
    });
  },
});
```

`activate` is given a context:

| Part | What it is |
| --- | --- |
| `context.id` | The plugin's ID |
| `context.api` | The version of the API the app speaks |
| `context.language` | The app's language, as `en`, for the plugin's own strings |
| `context.direction` | `ltr` or `rtl`, the way the app's text runs |
| `context.commands` | `register(id, run)`, which attaches a command the manifest declares |
| `context.codeBlocks` | `register(language, render)`, which draws code blocks in a language the manifest declares |
| `context.blocks` | `register(type, view)`, which shows blocks of a type the manifest declares |
| `context.panels` | `register(id, view)`, which fills a panel the manifest declares |
| `context.views` | `register(id, view)`, which draws a view the manifest declares, and `open(id)`, which opens a view of its own |
| `context.layouts` | `register(id, view)`, which shows a database's rows in a layout the manifest declares |
| `context.propertyTypes` | `register(id, view)`, which shows values of a property type the manifest declares |
| `context.settings` | `values()`, the plugin's settings, and `onChange(listener)` |
| `context.vault` | The vault's notes and files, as far as the manifest asks: see [The vault](#the-vault) |

Every call to the app is async, and takes and returns plain JSON values,
since a plugin runs apart from the app and reaches it only by messages.
Each `register` returns something whose `dispose()` takes what it
attached away again. When a plugin is turned off, the app takes away everything it
added.

## Commands

The app knows a plugin's command as `plugin-id:command`, as
`word-count:count`.

- **`menu`** is where it sits: `file`, `note`, `view`, `sync` or
  `settings`, after that menu's own commands. Without one, it sits in a
  **Plugins** menu at the end of the menu bar.
- **`keys`** are its shortcuts until you choose others under **Settings >
  Shortcuts**. Keys that another command has already stay that command's,
  so a plugin cannot take the app's own.
- A command its manifest does not declare cannot be registered.

## Code blocks

A plugin can draw the code blocks of a language, as Nether's Mermaid
diagrams are drawn. The manifest declares each language, in lowercase:

```json
"contributes": {
  "codeBlocks": [{ "language": "abc" }]
}
```

and the plugin's code draws it:

```js
await context.codeBlocks.register("abc", async (source, block) => {
  if (source.trim() === "") return null;
  return { html: drawTune(source, block.theme) };
});
```

- **`source`** is the block's text, as written.
- **`block`** says its `language`; its `info`, the whole line after the
  backticks, as `abc title="Tune"`; the `theme` of the page it shows on,
  `light` or `dark`; and the `target`: `editor` in a note open in Nether,
  or `html` in an exported page.
- It returns `{ html }`, `{ error }` to say what is wrong, or `null` for
  nothing.

In a note, what a plugin draws shows below the block's code, which stays
as it is written, and is drawn again once typing pauses. An error shows
there instead. In an exported page, the drawing takes the code's place,
and an error or `null` leaves the code. A fence matches whatever its case,
so a block fenced as `ABC` is drawn too. Each language is drawn by one
plugin: a plugin that declares a language another has is not added.

Draw with plain HTML and SVG: the app may take scripts and event handlers
out of what a plugin draws.

A language can have an entry in the slash menu too, which inserts a block
in it, holding `text`:

```json
{ "language": "abc", "name": "Tune", "keywords": "music notation", "text": "X:1" }
```

`name` and `keywords` are strings, or strings by language. Without a
`name`, the language has no entry.

Mermaid diagrams and query blocks are built-in plugins, and the slash
menu's Diagram and Query are their entries. Mermaid's uses only this API.
A query block's notes are a live view, which only built-in plugins can
show; an exported page shows a query block's code.

## Blocks

A plugin can add blocks of its own. A note's file writes one as a code
block named `plugin-id/type`, holding what the block holds as JSON, so
the file stays readable without the plugin:

```json
"contributes": {
  "blocks": [
    { "type": "tally", "name": "Tally", "keywords": "count", "attrs": { "count": 0 } }
  ]
}
```

- **`type`** is a lowercase letter, then letters, digits and hyphens. In
  a note, the block is `word-count/tally`. A plugin that adds blocks needs
  an ID that starts with a letter.
- **`name`** and **`keywords`** are its entry in the slash menu.
- **`attrs`** is what a new block holds, a JSON object.

The plugin's code shows the block with a view:

```js
await context.blocks.register("tally", {
  mount(element, props, block) {
    let current = props;
    const button = document.createElement("button");
    const show = () => {
      button.textContent = String(current.attrs.count ?? 0);
      button.disabled = !current.editable;
    };
    button.onclick = () => block.setAttrs({ count: (current.attrs.count ?? 0) + 1 });
    element.append(button);
    show();
    return {
      update(next) {
        current = next;
        show();
      },
      unmount() {
        button.remove();
      },
    };
  },
});
```

- **`element`** is the view's own. Draw into it with any framework, or
  none.
- **`props`** holds `attrs`, what the block holds; `editable`, false in a
  note that cannot be changed here; and the page's `theme`.
- **`block.setAttrs(attrs)`** changes what the block holds, as an edit of
  the note that can be undone. The app then calls `update` with the new
  props.
- **`unmount`** is called when the block leaves the page.

A view mounts when its block shows. A view shows and changes only
`attrs`; a block's text and the blocks inside it, if it has any, stay as
they are. A block from a plugin the app does not have shows its type,
and its note keeps it as it was.

## Panels

A plugin can add panels: tabs in the sidebar, after the app's own, and
sections beside the note open, after its comments.

```json
"contributes": {
  "panels": [
    { "id": "words", "name": "Words", "place": "note", "folded": true }
  ]
}
```

- **`id`** is unique in the plugin, and the app knows the panel as
  `plugin-id:id`.
- **`name`** is its tab's name in the sidebar, or its heading beside a
  note.
- **`place`** is `sidebar` or `note`.
- **`folded`**, beside a note, makes its heading a button that opens it.
  The panel mounts only when it is open, so it costs nothing until then.

The app gives each panel its name and landmark; the plugin's view fills
it, as a block's view fills a block:

```js
await context.panels.register("words", {
  mount(element, props) {
    element.textContent = props.note?.title ?? "";
    return {
      update(next) {
        element.textContent = next.note?.title ?? "";
      },
    };
  },
});
```

`props` holds the page's `theme` and, beside a note, the `note` open, as
its `id`, `title` and `path`. The app calls `update` when another note
opens beside the panel.

The sidebar's Tags and Assigned, and the Outline, Linked from and
Unlinked mentions beside a note, are built-in plugins' panels.

## Views

A plugin can add views that fill a pane: of files with an extension of
theirs, which open in a tab as notes do, or of their own, which a command
opens.

```json
"contributes": {
  "views": [
    { "id": "sheet", "name": "Sheet", "extensions": ["csv", "tsv"] },
    { "id": "stats", "name": "Statistics" }
  ]
}
```

- **`extensions`** are lowercase, without the dot. `md` is the app's own,
  for notes. Each extension is opened by one plugin: a plugin that
  declares one another has is not added.
- A view with no extensions is a view of its own. The plugin opens it
  with `context.views.open(id)`, from one of its commands.

The plugin's view fills the pane, as a panel's fills a panel:

```js
await context.views.register("sheet", {
  mount(element, props) {
    element.textContent = props.file?.path ?? "";
    return {
      update(next) {
        element.textContent = next.file?.path ?? "";
      },
    };
  },
});
```

`props` holds the page's `theme` and, for a view of files, the `file`
open, by its `path`. A file whose extension no plugin opens says so in
its tab.

The canvas, the view of `.canvas` files, and the graph, a view of its
own, are built-in plugins' views. With the canvas plugin off, New canvas
waits for it.

## Database layouts

A plugin can add layouts of a database's rows, beside the app's table,
board, gallery, list, calendar and timeline. A view in one names it
`plugin-id/id` in the database's schema, and the Obsidian base beside the
database shows it as a table, so Obsidian still shows its rows.

```json
"contributes": {
  "layouts": [{ "id": "pins", "name": "Map" }]
}
```

The plugin's view shows the rows the view's filter finds:

```js
await context.layouts.register("pins", {
  mount(element, props, database) {
    for (const row of props.rows) {
      const pin = document.createElement("button");
      pin.textContent = row.title;
      pin.onclick = () => database.openRow(row.id);
      element.append(pin);
    }
  },
});
```

- **`props`** holds the `view`'s name and its `options`, the `rows`, each
  with its `id`, `title` and the `values` of the properties the view
  shows, the `groups` when the view groups its rows, the `properties`
  shown with their types, whether the database is `editable` here, and
  the page's `theme`.
- **`database.openRow(id)`** opens a row's note,
  **`database.setValue(row, key, value)`** sets one of its properties, and
  **`database.setOptions(options)`** keeps the layout's own settings in the
  view, in the database's schema.

A view of a layout no plugin here shows keeps it, and its options, and
shows its rows as a table until its plugin is on.

## Property types

A plugin can add property types. Each stores as one of the app's types:
text, number, checkbox, date, URL or multi-select, which is what a note's
frontmatter holds, so Obsidian and other tools read its values as they
are.

```json
"contributes": {
  "propertyTypes": [{ "id": "rating", "name": "Rating", "stores": "number" }]
}
```

The type menus list it beside the app's types, and the vault writes it as
`word-count/rating` with what it stores as: in `.nether/properties.json`
as `{ "type": "word-count/rating", "stores": "number" }`, and in a
database's schema as `type` and `stores`. Its plugin's view shows a value,
in a note's properties and in a database's table:

```js
await context.propertyTypes.register("rating", {
  mount(element, props, property) {
    const stars = document.createElement("button");
    const show = (value) => {
      stars.textContent = "*".repeat(typeof value === "number" ? value : 0);
    };
    show(props.value);
    stars.onclick = () => property.setValue(((props.value ?? 0) % 5) + 1);
    element.append(stars);
    return { update: (next) => show(next.value) };
  },
});
```

`props` holds the property's `key`, its `value`, whether it is `editable`
here, and the page's `theme`. `property.setValue(value)` sets it; the app
checks the value as the type it stores as before writing it. Without the
plugin, a property of its type shows and edits as what it stores as, and
keeps its type
([ADR 0057](https://github.com/fzn0x/nether/blob/main/docs/adr/0057-a-plugins-property-type-stores-as-one-of-the-apps-which-shows-without-it.md)).

## Settings

A plugin's settings are fields its manifest declares. The app draws them
in the plugin's own tab of the vault's settings, as it draws its own:

```json
"contributes": {
  "settings": [
    { "id": "goal", "name": "Daily goal", "type": "number", "default": 500 },
    {
      "id": "unit",
      "name": "Count",
      "type": "choice",
      "choices": [
        { "value": "words", "name": "Words" },
        { "value": "chars", "name": "Characters" }
      ]
    }
  ]
}
```

- **`type`** is `text`, `number`, `toggle` or `choice`, drawn as a text
  field, a number field, a check box or a list.
- **`default`** is its value until it is changed: a string, a number,
  true or false, or one of the choices' values. Without it, a field
  starts empty, at 0, off, or at its first choice.
- **`name`** and **`description`**, which shows under the field, are
  strings or strings by language.

The plugin reads them as they are now, and hears when they change:

```js
let { goal } = context.settings.values();
context.settings.onChange((values) => {
  goal = values.goal;
});
```

Each value is one its field takes: a value stored that does not suit
its field reads as the field's default. The vault keeps a plugin's
settings in `.nether/plugins/<id>/data.json`.

## Turning plugins on and off

The **Plugins** tab of the vault's settings lists the plugins that come
with Nether, each with what it does, and turns each on or off. A plugin
turned off takes away what it adds, in that vault, until it is turned on
again. The vault keeps which are on in `.nether/plugins.json`, which maps
a plugin's ID to whether it is on; a built-in plugin it does not name is
on. Neither file syncs.

Below them, **From this vault** lists the plugins in the vault's
`.nether/plugins` folder, each with its version and what it asks for. One
that cannot run says why, as a manifest that does not read, a folder not
named for its ID, or no `main.js`. Turning one on approves it on this
device; a plugin from a vault is off until it is turned on.

The Backlinks plugin has a setting of its own, whether each note that
links here shows the text around its links.

## The sandbox

A plugin from a vault's folder runs apart from the app. Its code runs in
a worker of its own, inside a hidden frame of the app's own page that has
no origin of its own. It has no page to reach: not the app's, nor its
storage, nor the server's cookie, nor the vault's files. It reaches the
app only through the API.

What it draws as HTML is cleaned before the app shows it, in a note and
in an exported page: no scripts, event handlers, styles, forms or frames,
and no address outside the page, which would carry what it knows out.
Fragments, as `#part`, and images as `data:` stay; with the `network`
permission, `https:` addresses stay too.

### Views from a vault

A plugin from a vault draws its blocks, panels, views, layouts and
property types in its worker, in a DOM of the worker's own: `document`,
elements, text, attributes, `innerHTML` and events, as on a page, with
`value`, `checked`, `style`, `focus()` and `blur()`. A framework that
renders to the DOM works there. The app copies what it draws into the
view's box, in a shadow root, so the plugin's styles stay in it, and the
app's theme reaches in through its CSS custom properties.

```js
await context.panels.register("count", {
  mount(element) {
    const button = document.createElement("button");
    let clicks = 0;
    button.textContent = "Clicked 0";
    button.addEventListener("click", () => {
      clicks++;
      button.textContent = `Clicked ${clicks}`;
    });
    element.append(button);
  },
});
```

The app shows only what it allows, and nothing for the rest:

- **Elements**: text, lists, tables, form controls without a form,
  `details`, images, SVG shapes and `style`. Never scripts, frames,
  forms, `dialog`, or SVG's `use`, animations and `foreignObject`.
- **Attributes**: the usual ones of those elements, `aria-*` and
  `data-*`. Never an `on…` handler, `autofocus`, `contenteditable`,
  `accesskey` or `popover`. A link has no address. An image's `src` is a
  `data:` image, or an `https:` address with the network.
- **Styles**: a `style` element keeps its style, `@media`, `@supports`,
  `@container` and `@keyframes` rules. A rule, or a `style` attribute,
  that would load from an address is left out whole; with the network,
  `url(https:…)` stays.
- **Size**: at most 10,000 nodes in a view.

The plugin hears the events it listens for: clicks, keys, pointer and
mouse events, `input` and `change`, focus, `wheel`, `scroll` and
`toggle`. Moves, wheels and scrolls come at most once a frame. An input's
value and a box's checked state come with its events. The event has
already happened in the app, so `preventDefault()` changes nothing; text
boxes and checkboxes behave as they always do.

The worker cannot measure what it draws. A view that listens for
`resize` on the element it mounts in is told its width and height, as
the event's `width` and `height`, and as the element's `clientWidth` and
`clientHeight`. A `canvas` does not draw yet.

A plugin asks for what it needs in its manifest's `permissions`:

| Permission | What it lets the plugin do |
| --- | --- |
| `network` | Connect to `https:` and `wss:` addresses, and keep `https:` addresses in what it draws. Without it, every request it makes fails |
| `vault:read` | List and read the vault's notes and files, and hear of the notes that change |
| `vault:write` | Write notes, and move them to the trash |

**Approval is this device's.** Turning a plugin on in the Plugins tab
approves it as it is now: its code, by the hash of its `main.js`, its
version and what it asks for. The device keeps that approval, never the
vault, so a vault copied from elsewhere brings no approval with it. When
a plugin's code, version or permissions change, it stops, and the tab
says the vault has it on but this device has not approved it; turning it
on again approves the new code. A plugin runs with all it asks for, or
not at all.

In the web app, a plugin from a vault starts while the server answers:
the browser loads its frame from the server. Once started, it keeps
running offline. The desktop app starts them offline too.

## The vault

`context.vault` reads and changes the vault's notes, through the app,
for a plugin whose manifest asks for it. A call the manifest did not ask
for fails.

| Call | Asks for | What it does |
| --- | --- | --- |
| `notes()` | `vault:read` | The notes, each with its `id`, `path` and `title` |
| `read(path)` | `vault:read` | A note's Markdown, frontmatter and all, as it is now |
| `files()` | `vault:read` | The paths of the files that are not notes, as images and PDFs |
| `readFile(path)` | `vault:read` | A file's bytes, as a `Uint8Array`, up to 20 MB |
| `onChange(listener)` | `vault:read` | Calls `listener` with the paths of notes as they change |
| `write(path, text)` | `vault:write` | Makes a note with that Markdown, or changes one to it |
| `remove(path)` | `vault:write` | Moves a note to the vault's trash |

```js
const notes = await context.vault.notes();
await context.vault.write(
  "Index.md",
  notes.map((note) => `- [[${note.title}]]`).join("\n") + "\n",
);
```

A path is a note's or a file's path in the vault, with `/` between
folders, as `Projects/Plan.md`; a note's ends in `.md`. No path reaches
a hidden folder, one whose name starts with a dot, as `.nether`, where
the app keeps its own files, or `.obsidian`.

A note a plugin writes changes as if typed in source mode: an editor
showing it shows the change, sync sends it, and its history keeps what
was there before. A note a plugin moves to the trash closes its tabs, and
a notice says which plugin moved it there, with Restore.

## Versions

The plugin API has its own version, apart from the app's. The app speaks
API 0.1.0. A manifest's `api` is a range: `^0.1` takes any 0.1 version.
Before 1.0, a new minor version may break plugins, so `^0.1` does not
take 0.2. From 1.0, `^1.2` takes any 1.x from 1.2 on.

## From Obsidian

A plugin made for Obsidian does not run in Nether unchanged: Obsidian's
API, its CodeMirror editor and Node are not there. Porting one is meant to
be easy, though. The manifest uses Obsidian's field names, `api` taking
the place of `minAppVersion`, and command IDs are `plugin-id:command` as
in Obsidian.

## The license

The plugin API, `@nether/plugin-api`, is under the MIT license, so a
plugin may use any license. Nether itself is AGPL-3.0-or-later. The API is
not on npm yet.

---
title: Writing plugins
description: How a Nether plugin is made, a preview of the plugin API at version 0.1. A plugin's folder, its manifest, its code and the commands it adds.
---

:::caution[A preview]
Plugins from a vault's folder do not run yet. They will once the sandbox,
the next part of Phase 4, runs each one apart from the app, with the
permissions you approve. Until then only Nether's own built-in plugins
run, through the API this page describes. The API is at version 0.1, and
may change before 1.0.
:::

## A plugin's folder

A plugin is a folder in the vault, `.nether/plugins/<id>/`:

| File            | What it holds                                                |
| --------------- | ------------------------------------------------------------ |
| `manifest.json` | Who the plugin is, the API versions it needs, and what it adds |
| `main.js`       | Its code: an ES module whose default export is the plugin    |
| `styles.css`    | Its styles, if it has any                                    |

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
| `contributes` | What it adds: for now, `commands` |

The app reads the manifest before the plugin's code runs. Its commands
show in the menus and the palette at once, and its code loads only when
one of them is first chosen.

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

Every call to the app is async, and takes and returns plain JSON values,
since a plugin will run apart from the app and reach it only by messages.
Each `register` returns something whose `dispose()` takes the command
away again. When a plugin is turned off, the app takes away everything it
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

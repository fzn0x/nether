---
title: Buttons
description: How a button in a note runs commands, makes notes from templates, sets properties and opens links, written as Obsidian's Meta Bind plugin writes one.
---

A button in a note does something when you click it: it marks a task done,
starts a meeting's notes from a template, or opens today's note. It is a
code block in the language `meta-bind-button`, written as the Meta Bind
plugin for Obsidian writes a button, so the same button works in Obsidian
with Meta Bind. Below its code, Nether shows the button.

````markdown
```meta-bind-button
label: Mark done
style: primary
actions:
  - type: updateMetadata
    bindTarget: status
    evaluate: false
    value: Done
  - type: command
    command: dayNote
```
````

To make one, type `/button` and press Enter: the block it makes sets the
note's `status` to `Done`, and you change its code from there.

## How it looks

| Key | What it does |
| --- | --- |
| `label` | The button's text. A button needs one. |
| `style` | `default`, `primary`, `destructive` or `plain` |
| `tooltip` | What shows when the pointer rests on it |
| `hidden` | `true` shows no button |
| `id` | Kept for Meta Bind's inline buttons, which Nether does not show yet |

Meta Bind's `class`, `cssStyle` and `backgroundImage` are kept in the
block and not used: styles from a note do not reach the app's page.

## What it does

A button has one `action`, or a list of `actions` that run one after
another. When one fails, the rest do not run, and the button says why below
it.

### Run a command

```yaml
action:
  type: command
  command: dayNote
```

`command` is the command's ID. A plugin's command is `plugin-id:command`,
as its manifest declares it. Some of the app's own:

| ID | Command |
| --- | --- |
| `newNote` | New note |
| `newDatabase` | New database |
| `newCanvas` | New canvas |
| `dayNote`, `weekNote`, `monthNote` | Open today's, this week's or this month's note |
| `toggleSource` | Show the note as Markdown or as blocks |
| `bookmark` | Bookmark the note |
| `history` | Show the note's history |
| `splitRight` | Open the note to the right |
| `switcher`, `search` | Open a note by its name, search the vault |
| `openGraph` | Open the graph |
| `sync` | Sync this vault |

Obsidian's own commands, as `editor:toggle-bold`, are not Nether's: a
button that names one says Nether has no such command.

A button that runs commands asks first, since anyone who may edit the note
wrote it: "This button runs: Open today's note. Run it?" It names each
command as the command palette does. **Cancel** runs none of the button's
actions. After **Run**, this device runs that button without asking again,
until its block changes. A command that a plugin from the vault's folder
adds is asked about each time, since the plugin's code can change. The
other actions run without asking.

### Make a note

```yaml
action:
  type: createNote
  folderPath: Meetings
  fileName: Weekly sync
  openNote: true
```

`fileName` is the new note's name, and `folderPath` its folder, the top of
the vault when there is none. When a note has that name already, the new
one is numbered after it, `Weekly sync 2`, unless `openIfAlreadyExists:
true` opens the one there. `openNote: true` opens the new note.

To start it from a template, write `templaterCreateNote`, with the
template's path as `templateFile`:

```yaml
action:
  type: templaterCreateNote
  templateFile: Templates/Meeting.md
  folderPath: Meetings
  fileName: Weekly sync
  openNote: true
```

The template's variables are filled as a new note's are, `{{title}}` and
`{{date}}` among them (see [Templates](../templates/)). Templater's own
`<% %>` commands are left in the note as text. Without `fileName`, the note
is named `Untitled`.

### Set a property

```yaml
action:
  type: updateMetadata
  bindTarget: status
  evaluate: false
  value: Done
```

`bindTarget` names the property: `status` for the note the button is in,
or `Projects/Alpha#status` for another note, found as a link finds it. The
value is read as Meta Bind reads one: `true`, `false`, `null` and numbers
as themselves, anything else as text. A list or a number written as YAML
stays one.

Nested properties, as `task.done`, and Meta Bind's `memory^` targets are
not read.

### Open a link

```yaml
action:
  type: open
  link: "[[Weekly sync#Agenda]]"
```

A `[[link]]` opens its note, heading or block, as a link in the note does;
a web address opens in the browser.

### Wait

```yaml
action:
  type: sleep
  ms: 500
```

Waits before the next action, for at most ten seconds.

## What Nether does not run

A button with an action that runs JavaScript (`js`, `inlineJS`, or
`updateMetadata` with `evaluate: true`), asks for `input`, runs a Templater
file, or changes the note's text (`replaceInNote`, `replaceSelf`,
`regexpReplaceInNote`, `insertIntoNote`) says so, and runs none of its
actions. Code in a note never runs outside the
[plugin sandbox](../plugins/#the-sandbox).

## Turning buttons off

Buttons are the built-in Buttons plugin's. With it off, in the settings'
Plugins tab, a button shows as its code.

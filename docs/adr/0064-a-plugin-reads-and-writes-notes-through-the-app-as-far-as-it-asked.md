# 0064. A plugin reads and writes notes through the app, as far as it asked

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md)
lets a manifest ask for `vault:read`, to list and read the vault's notes
and files, and `vault:write`, to change them "each note through its
document, as an edit the app makes". It left the calls to the sandbox's
last part. A plugin from a vault reaches nothing but its connection to the
app, so whatever it reads or changes, the app does for it.

A note open in the editor is a Yjs document whose file is written after a
pause in typing ([ADR 0003](0003-sync-yjs-hocuspocus.md)). Its file can be behind
the document, and a change written straight to the file would come back
to the document as another app's edit. Source mode already hands the app
a note's whole Markdown, which the app merges into the document block by
block.

A vault also holds what is not the user's notes: `.nether` keeps the
app's own files, plugins' code among them, and other tools keep theirs in
folders such as `.obsidian` and `.git`. A plugin that could write there
could change another plugin's code, or give Obsidian a plugin that runs
with no sandbox at all.

## Decision

**The SDK gets `context.vault`**, whose calls the app answers only for a
plugin whose manifest asks for the permission each needs. A plugin from a
vault runs with all it asks for once this device approves it; a built-in
plugin asks in its manifest like any other.

| Call | Permission | What it does |
| --- | --- | --- |
| `notes()` | `vault:read` | Lists the notes: each one's ID, path and title |
| `read(path)` | `vault:read` | A note's Markdown, frontmatter and all, as it is now, edits not yet saved included |
| `files()` | `vault:read` | The paths of the files that are not notes, as images and PDFs |
| `readFile(path)` | `vault:read` | A file's bytes, up to 20 MB |
| `onChange(listener)` | `vault:read` | Tells the plugin the paths of notes that change |
| `write(path, text)` | `vault:write` | Makes a note with that Markdown, or changes one to it |
| `remove(path)` | `vault:write` | Moves a note to the vault's trash |

**A write is an edit the app makes.** The app opens the note's document,
as the editor does, and merges the new Markdown into it as it merges
source mode's text: an editor showing the note shows the change, sync
sends it, and the note's history keeps what was there before. A note not
there yet is made at that path.

**A removal is the app's own.** The note goes to the trash, its tabs
close, and a notice says which plugin moved it there, with Restore.

**Paths are a note's or a file's path in the vault**, with `/` between
folders. The app refuses an absolute path, a backslash, an empty part,
`.` or `..`, and any part that starts with a dot, so a plugin reaches no
hidden folder: not `.nether`, nor another tool's. A note's path ends in
`.md`.

**Bytes cross as Base64**, since the connection carries JSON; the SDK
gives the plugin a `Uint8Array`.

## Alternatives

- **Writing a note's file.** The editor would take the change as another
  app's edit, after its watcher found it, and would show it late or merge
  it against edits not yet saved.
- **Opening a note as a Yjs document for the plugin.** A plugin would need
  Yjs and the editor's schema to change one, and could leave a document
  the editor cannot show.
- **Writing files that are not notes.** Nothing needs it yet; it can come
  with a call of its own.
- **Hidden folders when asked for.** Each would need a permission of its
  own, and none is needed yet.
- **Asking again before each removal.** A plugin made to tidy notes would
  ask for each; the notice and the trash undo it instead.

## Consequences

- With `vault:read`, a plugin can read every note and file outside hidden
  folders; with the network too, it can send them away. The Plugins tab
  says what each asks for before it is approved.
- A plugin's writes show in the note's history and sync like the user's
  own. A plugin that writes in a loop could fill the history; that is
  the plugin's fault, and turning it off stops it.
- Moving and renaming notes, and writing other files, are left for calls
  of their own.

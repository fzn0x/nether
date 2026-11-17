# 0072. Buttons are Meta Bind's button blocks, and triggers are rules in a database's schema, run where the change is made

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#databases-and-structure) ask, in
Phase 4, for "Buttons that create notes, set properties or run plugin
actions; database triggers ('when status = Done, set Completed date')".

How buttons are written in Obsidian, by the two community plugins that
make them:

- **Buttons** writes a `button` code block of `key value` lines: `name`,
  then `type` (`command`, `link`, `calculate`, templates and text put
  into a note, `swap`, `chain`) and `action`. None of its types sets a
  property.
- **Meta Bind** writes a `meta-bind-button` code block of YAML, which its
  docs and its typed source describe: `label`, `style` (`default`,
  `primary`, `destructive` or `plain`), `tooltip`, `id`, `hidden`, and
  `action` or `actions`. Among its actions:
  - `command`, with the `command` to run, by its ID;
  - `createNote`, with `fileName`, and `folderPath`, `openNote` and
    `openIfAlreadyExists`; a taken name gets a number, "Note 1";
  - `templaterCreateNote`, the same with a `templateFile`, filled by the
    Templater plugin;
  - `updateMetadata`, with a `bindTarget`, `evaluate` and a `value`. A
    bind target is `property` for the note the button is in, or
    `Note#property` for another, with `frontmatter^` before it when its
    storage is named. Without `evaluate`, the value is read as Meta Bind
    reads a literal: `null`, `true`, `false`, a number, or else text;
  - `open`, with a `link` to a note or a web address;
  - and others that run JavaScript, ask for input, wait, or change the
    note's text.

Neither Obsidian nor its bases have triggers.

What any design must live with:

- **A note stays readable Markdown** ([ADR 0006](0006-markdown-file-format.md)),
  and what Obsidian reads must mean the same there.
- **Code from a vault runs only in the plugin sandbox**
  ([ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md)).
- **Commands are in one registry**, the app's and its plugins', a plugin's
  named `plugin-id:command`, as Obsidian names them
  ([ADR 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)).
- **A database is a note whose frontmatter holds its schema**, with an
  Obsidian base beside it, whose keys mean what Obsidian says
  ([ADR 0018](0018-a-database-is-a-note-with-an-obsidian-base-beside-it.md),
  [ADR 0056](0056-a-plugins-database-layout-is-named-for-it-and-a-base-shows-it-as-a-table.md)).
- **A note changes in many places**: in the app on this device, on other
  devices whose changes arrive by sync, in other apps that edit its file,
  and through the server's REST API.
- **A note's text comes from whoever may edit it**: a member with edit
  access, a guest, and anyone holding an edit link, with no account. A
  button's label is theirs too. Meta Bind's vaults are one person's;
  Nether's sync.

## Decision

**A button is a `meta-bind-button` code block, in Meta Bind's own syntax.**
In Obsidian with Meta Bind it is the same button; without it, readable
YAML. Nether reads and runs a part of that syntax:

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

- `label`, `style`, `tooltip` and `hidden` draw the button. `id` is kept;
  inline buttons that use it, `` `BUTTON[id]` ``, are not read yet. Its
  other fields are kept and not drawn: styles from a note do not reach the
  app's page.
- **`command`** runs a command of the registry by its ID: the app's own,
  as `dayNote`, or a plugin's, `plugin-id:command`. An Obsidian command
  Nether does not have is named as missing. The button asks first, as
  below.
- **`createNote`** makes a note at `folderPath`/`fileName`, the first free
  name after it, or opens it with `openIfAlreadyExists`; `openNote` opens
  it.
- **`templaterCreateNote`** does the same from `templateFile`, filled as
  Nether fills a template ([ADR 0011](0011-templates-and-periodic-notes.md)):
  Obsidian's own variables, and Templater's `<% %>` left as text.
- **`updateMetadata`** sets a property, with `evaluate: false`: of the note
  the button is in, or of `Note#property`, found as a link finds it. The
  value is read as Meta Bind reads a literal; a YAML number or true stays
  one. Nested properties and Meta Bind's memory are not read.
- **`open`** opens a `[[link]]` in the app, or a web address in the
  browser.
- **`sleep`** waits its `ms`, up to ten seconds.
- **Actions run in order.** One that fails stops the rest and says why.
- **What Nether does not run**, JavaScript (`js`, `inlineJS`, `evaluate:
  true`), `input`, `runTemplaterFile` and the actions that change the
  note's text, makes the button say so and run none of its actions. Code
  in a note never runs outside the sandbox.

**A button that runs commands asks first.** A button labelled "Open the
plan" could run `trashNote`, or a plugin's command, on the owner's device
at one click, written by anyone who may edit the note. So:

- **The first time a button runs a `command` on this device**, before any
  of its actions, the app asks, naming each command it has by its title as
  the palette shows it: "This button runs: Move to trash. Run it?", with
  Run and Cancel. Cancel runs none of the button's actions.
- **Run is remembered on this device** for that note and the button's
  text, as the SHA-256 of its block, in the vault's index settings beside
  this device's other choices, not in the vault's folder. Any edit to the
  button asks again. The newest fifty of a note's buttons are kept.
- **A command a plugin from the vault adds asks every time**, since its
  code can change.
- **The other actions run without asking**: `updateMetadata`,
  `createNote`, `templaterCreateNote`, `open` and `sleep` do what editing
  the note or following a link already does. `open` opens only `http`,
  `https` and `mailto` addresses in the browser.

**Buttons are a built-in plugin's**, `automations`, on the plugin API: it
adds the `meta-bind-button` language and a Button entry to the slash menu.
Its view gets from the host what a button does: the note it is in, the
command registry, making a note from a template, and setting a property.
Turned off, a button shows as its code.

**A trigger is a rule in its database's schema**, under `triggers` in the
database note's frontmatter, beside its properties and views:

```yaml
database:
  properties: …
  triggers:
    - when: status
      is: Done
      set:
        completed: "{{date}}"
```

- `when` names a property and `is` a value. The rule fires when a row's
  property becomes that value, from another; not on every write while it
  stays.
- `set` gives properties and their values. `{{date}}` and `{{time}}`, with
  a format after a colon, are filled as templates fill them; `null` clears
  a property.
- It is Nether's own: no other app has triggers. Obsidian shows the
  database note's `database` property as it does now, and the base beside
  it does not change.

**A trigger runs on the device that made the change, once.** It runs right
after the app makes a change on this device: in a database's cell, board,
calendar or timeline, in a row's properties, or by a button. It does not
run for a change that arrives by sync, from another app's edit of the file,
or through the REST API. A synced change ran its triggers where it was
made, and its trigger's writes sync with it, so no device runs a rule a
second time.

**No trigger fires itself.** A trigger's own writes run no triggers, so no
rule fires another, nor itself. A rule fires on the change into its value,
not while it stays.

**The `automations` plugin runs triggers too**, through a hook the host
gives built-in plugins: a property the app changed, before and after.
Turned off, no trigger runs.

**It comes in two parts**, a pull request each:

1. Buttons, as above.
2. Triggers, with their editor in the database's settings.

## Alternatives

- **The Buttons plugin's `button` blocks.** None of its types sets a
  property; adding one would be a syntax that only looks like Buttons'.
- **A `button` language of Nether's own.** No other app would run it, and
  the Buttons plugin, whose language that is, would read it wrong.
- **Running Meta Bind's JavaScript actions.** Only the sandbox runs code
  from a vault, and these have no permissions to ask for.
- **Running commands without asking, as Meta Bind does.** Meta Bind's
  vault is its owner's alone. A synced note's buttons are written by
  others, and one click would run what they chose.
- **Asking about every action.** Setting a property, making a note and
  opening a link do no more than editing the note or clicking a link;
  asking each time would teach clicking Run without reading.
- **Remembering a run in the vault's folder.** It would sync, so one
  person's Run would let a button run on every device unasked.
- **Triggers in the base.** Its keys are Obsidian's, and a base Obsidian
  rewrites would drop them.
- **Triggers in a file beside the database.** A second file to keep in
  step, and to move and rename with it.
- **Triggers run on every device as a change syncs.** Each device would
  write the same change, as conflicts.
- **Triggers run on the server.** Vaults with no server would have none,
  and an encrypted workspace's server cannot read the rows.

## Consequences

- A Meta Bind button that sets a property, makes a note, runs a command
  Nether has, or opens a link works in both apps.
- A change made through the REST API, or in another app, runs no trigger.
  A later item could run triggers on the server for the API's changes,
  where it can read them.
- Each command, core or a plugin's, can be a button's action, as the
  command palette lists them. A button that runs one asks once on each
  device, and again after each edit; one that runs a vault plugin's
  command asks each time.

## Amended 2026-11-17: triggers, as part 2 builds them

- **What a rule may name.** `when` and every key of `set` name properties
  of the database that are written, not a formula or a rollup, which are
  worked out. `set` names one property at least. A schema without rules
  writes no `triggers`.
- **A stale rule never hides its database.** A rule is an add-on to a
  database. One that names a property the database no longer has, or one
  worked out, after a hand edit or another app's, or one that cannot be
  read, is left out and does not run, and the schema reads as before. The
  rule is kept in the file as it was written, after the rules that run, so
  nothing is lost. The Triggers panel lists it as not running, says why, as
  `set.Completed names no property of the database`, and offers Remove.
  This is for rules only: a view that names a missing property still makes
  the schema unreadable, as before.
- **Rules follow a property renamed or deleted.** Renaming a property
  renames it in every rule that names it, kept ones too. Deleting one drops
  the `set` entries that name it, a rule whose `when` names it, and a rule
  left with nothing to set. The app has no command yet that renames or
  deletes a database's property, only a hand edit does; the schema's own
  helpers, `renameInTriggers` and `deleteFromTriggers`, do this for the
  item that adds them, and a hand edit leaves a stale rule, as above.
- **What "becomes" means.** A property holds a rule's value when it is the
  same, or a list that has it, as a multi-select with `Done` among its
  tags; `is: null` holds for no value, an empty one or an empty list. A
  rule fires when its property holds the value after the change and did
  not before. A row made with a value, in a board's column or on a
  calendar's day, changes from none into it.
- **Several rules.** Every rule a change fires sets its values, in the
  order of the schema; for a property two set, the later one's value wins.
- **What fills a value.** Text, and text in a list, is filled as a
  template is, with `{{title}}` the row's name and the date and time of the
  change. Without a format, `{{date}}` is `YYYY-MM-DD`, as a date property
  stores it, and `{{time}}` is `HH:mm`, whatever the vault's template
  settings say.
- **Where the app tells of a change**, once it is written: a database's
  cells, a board's moves and a calendar's or timeline's, a row made in a
  column or on a day, the properties above a note, and a button's
  `updateMetadata`. The host keeps a registry of what watches them, which
  only built-in plugins can join, by saying so beside their manifest; the
  `automations` plugin starts at the first change. A trigger reads its
  database's schema from the database note's document, as the editor has
  it, and writes the row through its document, all its values at once.
- **Its plugin's name** is now Buttons and triggers.
- **The editor** is the database's Triggers panel, beside Filter and
  Properties. Each rule shows as a sentence, "When status becomes Done, set
  completed to {{date}}", with Remove. Its form adds a rule; one with the
  property and value of a rule there sets its property beside the others.
  A value is read by its property's type: `true` or `false` for a
  checkbox, a number for a number, and nothing as none; a date property's
  value starts as `{{date}}`. With the plugin off, the panel says the rules
  do not run.

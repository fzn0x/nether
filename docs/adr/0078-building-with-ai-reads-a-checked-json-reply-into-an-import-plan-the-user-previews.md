# 0078. Building with AI reads a checked JSON reply into an import plan the user previews

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#ai-bring-your-own) ask for "Build
with AI: Generate a database schema, template or project plan from a
description; the user previews before anything is created".
[ADR 0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)
made it part 4 of the AI item, made as an import plan
([ADR 0027](0027-imports-are-plans-made-from-sources-read-only.md)) that the
user previews before anything is made. The providers, the off switch and
the privacy rules are 0068's; the web app sends through its server's relay
([ADR 0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md)).

What the design must live with:

- **A database is a note with a schema** in its frontmatter, its rows the
  notes in the folder beside it
  ([ADR 0018](0018-a-database-is-a-note-with-an-obsidian-base-beside-it.md)).
  Core and `@nether/database` check a schema: each property's key and type,
  a select's options, a board's grouping, a calendar's date, and each row's
  values against their types.
- **A relation or a rollup points at another database**, which a
  description of one thing does not make.
- **An import is a plan first**: the notes to make, at paths in the vault,
  under names it does not have yet, numbered as `Name 2`; nothing in the
  vault is changed.
- **A model's reply is text**, which may not be JSON, may not be the shape
  asked for, and may hold a schema core refuses.

## Decision

### What can be built

- **A database**: its properties and views, and three to five sample rows
  only when the user asks for them. Rows the reply has when none were
  asked for are left out, and said so.
- **A template**: a note in the vault's templates folder, which may use
  `{{title}}`, `{{date}}`, `{{time}}` and `{{cursor}}`.
- **A project plan**: a folder of notes, the first its outline, and a
  database of its tasks, each task a row, when the plan has tasks.

### How the model answers

The prompt asks for one JSON object and nothing else, and spells out its
shape: a property's key, its type, a select's options, a formula's
expression; a view's name, layout, visible keys, a board's grouping, a
calendar's date; a row's title, values as each type takes them, and text.
The description goes after it, between `<description>` tags, as words to
build from and never instructions.

The reply is read, and refused when it does not read, with the reason:

- the JSON object is found in the reply, in a code fence or prose around it
  if the model added one; none, or JSON that does not parse, is refused;
- a reply of another kind than the one asked for is refused;
- a property's type must be one of text, number, select, multi-select,
  date, checkbox, URL, person, file or formula; a relation or a rollup is
  refused, to add once the database is made; a formula must parse;
- the schema is then read as a database's note is read
  (`readDatabase`), so core's own checks apply and its message says why:
  "database.views[0].groupBy is needed by a board.";
- each row's values are checked against the schema (`checkRow`);
- what the dialog does not know of a property or a view is left out, a
  select's options given as names become options, a view that names no
  keys shows every property, and a database with no views gets a table;
- more than 30 properties, 10 views, 50 rows or 30 notes, or a note's text
  over 20,000 characters, is cut, and said so.

### The plan and its preview

What reads becomes an import plan:

- a database at the vault's top, its note's frontmatter the schema as
  `writeDatabase` writes it and its description its text, its rows in the
  folder beside it;
- a template at a free name in the templates folder;
- a plan in a folder of its own, its tasks a database in it.

Every name is one the vault does not have, numbered as imports number
them, and names within the plan are numbered too.

The dialog shows every note the plan would make, at its path: what it is,
a database's properties and views, a template's or a note's first lines.
The name can change, which plans the paths again, and rows and plan notes
can be left out; a row goes only with its database. Nothing is written
until **Make it**; **Cancel** makes nothing; **Change the description**
goes back. Made, the dialog opens the database, the template or the plan's
first note.

### Where it is offered

**Build with AI**, in the File menu and the palette, shows only while the
vault has a provider. The dialog chooses a database, a template or a plan,
so the separate New note and New database commands stay as they are.

### Where it runs

As writing assist: to the vault's provider in the desktop app, through
the server's relay in the web app, and for an end-to-end encrypted
workspace in the desktop app alone, with a provider chosen for it. The
dialog says where the description goes before anything is sent, and the
workspace's switch is asked first.

### Loading

The command's entry is in the app's main code while a provider is set
up; the dialog, the reading and the providers' code load the first time
it opens.

## Alternatives

- **The providers' structured outputs**, a JSON schema the API enforces.
  OpenAI-compatible endpoints and Anthropic each have their own, and many
  local servers have none; a prompt and the app's own checks work with
  every provider, and the checks are needed either way.
- **Fixing a reply that does not read**, as by dropping the view at fault.
  The user would get less than the reply showed without knowing which part
  went; refusing with the reason, and trying again, is plainer.
- **Relations between databases a plan makes.** A plan's notes and its one
  database cover the requirement; relations are added in the database once
  it is made.
- **Writing first and undoing after.** The requirement asks for a preview
  before anything is created.
- **Editing each property in the preview.** The database view edits a
  schema once it is made; the preview's name and its notes kept or left
  out are what is decided before.

## Consequences

- A model that cannot keep to JSON fails to build, with the reason, and
  the user tries again or another model.
- A built database is a database like any other: its base file is written
  when it first opens, and its schema changes in its view.
- The prompt's property types are the app's; a type added later is added
  to the prompt and to the types a build takes.
- With this part, the AI item's parts are all in place once asking your
  notes ([ADR 0075](0075-asking-your-notes-answers-from-passages-the-vaults-search-finds-each-citation-checked.md))
  and search by meaning (ADR 0074) are on `main`.

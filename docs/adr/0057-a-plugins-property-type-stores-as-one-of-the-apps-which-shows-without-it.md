# 0057. A plugin's property type stores as one of the app's, which shows without it

- Status: Accepted
- Date: 2026-11-16

## Context

[ADR 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)
builds the plugin API in steps. Its last adds property types from plugins,
and says that "a `plugin-id/type` written into a vault's properties needs a
record of its own too, saying what shows when the plugin is missing". This
is that record.

A property's type is written in two places:

- **`.nether/properties.json`** holds the vault's choice of type for each
  property key, as `{ "due": "date" }`, for notes outside databases. A key
  it does not name takes the type its value looks like, as Obsidian does.
- **A database's schema**, in its note's frontmatter, gives each of its
  properties a type ([ADR 0018](0018-a-database-is-a-note-with-an-obsidian-base-beside-it.md)).

Both read a type from a closed list in `packages/core`: text, number,
select, multi-select, date, checkbox, URL, person, relation, file, rollup
and formula. `properties.json` drops what is not one of them; a schema with
another type does not read.

The values themselves are YAML in each note's frontmatter, as every
Markdown tool reads them: strings, numbers, true and false, lists. A
plugin's type, such as a rating or a color, still holds one of those.

What any design must live with:

- **Values must stay readable without the plugin**, by Obsidian, by other
  tools and by Nether on a device that lacks the plugin.
- **A property of a missing plugin's type must still show and edit**,
  without its value being changed or dropped.
- **Obsidian keeps its own types** in `.obsidian/types.json`, which Nether
  reads but does not write.

## Decision

**A plugin's property type is named `plugin-id/type`**, as its blocks and
layouts are ([ADR 0006](0006-markdown-file-format.md),
[ADR 0056](0056-a-plugins-database-layout-is-named-for-it-and-a-base-shows-it-as-a-table.md)).

**It stores as one of the app's types**, which its manifest declares: text,
number, checkbox, date, URL or multi-select. A rating stores as a number, a
color as text. A value is checked as its stored type is, so a note's
frontmatter holds what that type holds.

**Where the type is written, its stored type is written with it**, so the
vault says what shows without the plugin:

- in `.nether/properties.json`, as `{ "rating": { "type": "stars/rating", "stores": "number" } }`, while
  the app's own types stay strings;
- in a database's schema, as `type: stars/rating` and `stores: number`.

**Without its plugin, a property shows and edits as its stored type**, and
its type stays as written: a rating is a number field until the plugin is
on again. Choosing another type is what changes it.

**The plugin's view draws the value**, in a note's properties and in a
database's table cells, mounted as block views are. It is given the value,
the property's key and whether it can change it, and sets a new value
through the app, which checks it as the stored type before writing it.

## Alternatives

- **Values of the plugin's own shape**, such as an object for a color.
  YAML can hold one, but Obsidian shows it as raw text, and other tools
  break on it.
- **The stored type only in the plugin's manifest.** Without the plugin
  the app would not know what the value is, and would guess from its look.
- **Unknown types read as text.** A number, a list or a checkbox would
  change type, and editing it would write text in its place.
- **Write the plugin's type to Obsidian's `types.json`.** It is Obsidian's,
  and Obsidian would treat a type it lacks as text.

## Consequences

- `packages/core` reads a property type as one of the app's or a
  `plugin-id/type` with its stored type, and checks values by the stored
  type. A database with a property of a plugin's type does not open in
  Nether 0.1.0, which knew only the app's types.
- `.nether/properties.json` keeps plugin types, as objects. Nether 0.1.0
  drops them on read, and its next write of the file loses them.
- The type menus list the types of the plugins on. A property of a type no
  plugin here has names its type beside the stored type's field.
- The plugin API grows `propertyTypes`, with a view drawn like a block's.

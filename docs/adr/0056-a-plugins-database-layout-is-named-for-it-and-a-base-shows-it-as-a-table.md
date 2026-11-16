# 0056. A plugin's database layout is named for it, and a base shows it as a table

- Status: Accepted
- Date: 2026-11-16

## Context

[ADR 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)
builds the plugin API in steps. Its sixth moves the six database layouts
onto it, and says that layouts from plugins "change what a database's base
file says, so they need a record of their own". This is that record.

A database is a note whose frontmatter holds its schema, with an Obsidian
base beside it ([ADR 0018](0018-a-database-is-a-note-with-an-obsidian-base-beside-it.md)).
A view's `layout` is one of a closed list in `packages/core`: table,
board, calendar, timeline, gallery and list. The base writes a board as
`kanban` and a gallery as `cards`, and a calendar and a timeline, which
Obsidian has not, as a `table` of their dates; read back, a table stays a
calendar or a timeline when the schema says it is one. A view's other
fields are fixed: the properties it shows, its filter, sorts and grouping,
a calendar's and a timeline's dates, a gallery's cover.

What any design must live with:

- **A database must open without the plugin that drew one of its views.**
  The plugin may be off, missing on another device, or not yet installed
  after the vault was copied.
- **Obsidian must still show the database's rows**, as ADR 0018 promises.
- **A plugin's view of the rows is its own**, and so are its settings:
  a map layout has a location property and a zoom, a chart has axes.
- **The table is where every view falls back**, and its cells are edited in
  place by the app, with what the rows' properties hold.

## Decision

**A layout from a plugin is named `plugin-id/layout`**, as a plugin's block
type is ([ADR 0006](0006-markdown-file-format.md)). A view's `layout` in the
schema may be any such name, for any plugin, present or not, as well as one
of the built-in layouts. The plugin's manifest declares the layout, with its
name, and its code attaches a view of it.

**A plugin layout's settings are the view's `options`**, a JSON object the
schema keeps as the plugin wrote it. Only views of a plugin's layout have
options; the built-in layouts keep their fields.

**In the base, a view of a plugin's layout is a `table`**, as a calendar's
and a timeline's are. Obsidian shows its rows, in the order and with the
filters the view has; read back, the table keeps the plugin's layout from
the schema, as a calendar keeps its own. What Obsidian changes in the
table's order, grouping and filters comes back to the view.

**Without its plugin, a view says which layout it is and shows its rows as
a table**, and writes nothing: its layout and options stay as they were.
Choosing another layout for the view is what changes them.

**The table stays the app's own; the other five built-in layouts move to a
built-in plugin**, `layouts`, which keeps their names unprefixed: a board
is still `board` in the schema and `kanban` in the base. The table is what
every view falls back to, so it cannot be turned off. Turned off, the
`layouts` plugin's views show as tables until it is on again.

**A plugin's view of a layout is given the rows, not the database.** Its
props are the view's name and options, the rows with their titles and the
values of the properties the view shows, the groups when it is grouped, the
properties' names and types, and whether the database can be changed here.
It can open a row, set a row's property, and change the view's options,
each through the app, which writes the row's note or the schema.

## Alternatives

- **Write the plugin's name as the base's `type`.** Obsidian would show a
  view it cannot read, with none of the database's rows, which ADR 0018
  promises it shows.
- **A layout's options in the base.** The base is Obsidian's, and
  Obsidian's keys there mean what Obsidian says; options are the plugin's.
- **Drop a view whose plugin is missing**, or turn it into a table. A
  vault opened on a device without the plugin would lose the view on the
  first save.
- **All six built-in layouts to plugins**, as ADR 0055 says. The table is
  the fallback for the others and for every plugin's layout, so it stays
  the app's.
- **Give a layout the database.** A plugin running apart cannot hold the
  app's database or its notes; rows as JSON cross as messages.

## Consequences

- `packages/core` reads a view's `layout` as a built-in layout or a
  `plugin-id/layout` name, and its `options`. A vault whose database has a
  view of a plugin's layout does not open that database in Nether 0.1.0,
  whose schema reader knew only the six.
- The database's layout picker lists the built-in layouts and the layouts
  of the plugins on, and a view of a layout no plugin here shows names it.
- The plugin API grows a kind of contribution, `layouts`, with the props and
  calls above.
- Step 7, plugins' property types, needs its own record too.

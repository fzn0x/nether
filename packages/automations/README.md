# @nether/automations

Buttons and database triggers
([ADR 0072](../../docs/adr/0072-buttons-are-meta-bind-button-blocks-and-triggers-are-schema-rules-run-where-the-change-is-made.md)):
what a block or a rule says, read and checked, for the app to run. It
runs nothing itself.

- `readButton(source)` reads a `meta-bind-button` code block, in Meta
  Bind's syntax, into a button's label, style and actions, naming what
  Nether does not run.
- `readBindTarget` and `readLiteral` read a property to set and its value
  as Meta Bind reads them.

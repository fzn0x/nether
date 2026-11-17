# @nether/plugin-api

What Nether's plugins import
([ADR 0055](../../docs/adr/0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)):
the manifest's schema, `definePlugin`, and the plugin's side of the
messages it exchanges with the app. Nether's own features use it too,
wherever they can.

- `readManifest(value)` reads a parsed `manifest.json`, or lists what is
  wrong with it. `localize(text, language)` picks a name's text for a
  language.
- `definePlugin({ activate(context) })` is a plugin module's default
  export. `activate` attaches the commands its manifest declares, with
  `context.commands.register(id, run)`.
- `startPlugin(plugin, transport)` runs a plugin at its end of a
  connection. `Endpoint` is either end. `pagePair()` connects two ends
  within the page, and `portTransport(port)` one end of a `MessagePort`.
- `context.connections`, `context.http` and `context.store` (API 0.1.1,
  [ADR 0090](../../docs/adr/0090-integrations-are-built-in-plugins-that-run-apart-and-reach-each-service-through-a-connection-the-app-keeps.md))
  list the person's connections to a service, send requests through the
  app with a connection's credential, and keep a cache on the device. A
  manifest asks for them with `connection:<service>` permissions, which
  only Nether's own plugins may use for now.
- `apiVersion` is this SDK's version, apart from the app's, and
  `satisfies(version, range)` reads a manifest's `api` range. Additions
  before 1.0 raise its patch: a plugin that uses one asks for `^0.1.1`.

This package alone is under the [MIT license](LICENSE), so a plugin may
use any license. It depends on nothing else in the repository. The app,
which runs plugins, stays AGPL-3.0-or-later.

# @nether/clipper

The Nether web clipper: a Manifest V3 extension for Chrome and Firefox that
saves a page or a selection as Markdown to a note or a database on the
person's own Nether server
([ADR 0066](../../docs/adr/0066-the-web-clipper-is-a-manifest-v3-extension-that-sends-clips-to-the-users-own-server-alone.md)).

- **The popup** (`src/popup.ts`) is the whole extension: no background
  script. Its first view takes the server's address and a write token,
  asks the browser for that one origin, and checks the token with
  `GET /api/v1/me`. Both stay in `storage.local`, which neither browser
  syncs.
- **Reading a tab** (`src/page.ts`, injected as `content.js`) happens
  when the button is pressed, through `activeTab` and `scripting`: the
  selection as it is, or the whole page through Mozilla's Readability, on
  a copy of the page. Links and images keep absolute addresses.
- **The Markdown** comes from `@nether/markdown/html-import`, as an
  imported page's does (`src/clip.ts`), and shows in the popup to edit.
- **Saving** goes through the server's REST API (`src/api.ts`): a new note
  with `source`, `clipped` and `author` frontmatter, a section added to a
  note with `If-Match` and up to three tries, or a database row.

Nothing goes to any host but the person's server.

## Build

```sh
pnpm --filter @nether/clipper build
```

It writes `dist/chrome/` and `dist/firefox/`, each a folder to load
unpacked, and `dist/nether-clipper-chrome-<version>.zip` and
`dist/nether-clipper-firefox-<version>.zip` for the stores. To try it:

- **Chrome**: `chrome://extensions`, turn on Developer mode, then **Load
  unpacked** and choose `dist/chrome`.
- **Firefox** 140 or later: `about:debugging#/runtime/this-firefox`, then
  **Load Temporary Add-on** and choose `dist/firefox/manifest.json`.

The icons in `icons/` are the desktop app's, rendered by
`pnpm --filter @nether/clipper icons`.

## Tests

- `pnpm --filter @nether/clipper test`: reading pages in jsdom, the Markdown
  a clip saves, the API calls against a fetch that answers as the server
  does, and the stores' ZIPs.
- `pnpm --filter @nether/clipper test:e2e`: the test build, `dist/test`,
  which may read every page and has a key so its ID is known, loaded in
  Playwright's Chromium against the web app's end-to-end server. It sets
  up a server and a token, and clips a page as a note, a selection into a
  note, and a page as a database row.

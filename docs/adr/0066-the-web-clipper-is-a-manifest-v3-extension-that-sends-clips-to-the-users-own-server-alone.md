# 0066. The web clipper is a Manifest V3 extension that sends clips to the user's own server alone

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#extensibility) ask for a "browser
extension (Chrome, Firefox) that saves a page or selection as Markdown to a
chosen note or database". The REST API
([ADR 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md))
now makes notes, replaces their Markdown with `If-Match`, and adds database
rows, for a write token that the app's Servers dialog makes.

What shapes the extension:

- **Two browsers, one extension.** Chrome takes Manifest V3 only. Firefox
  takes it too, with optional host permissions since Firefox 128, and asks
  every new add-on to declare what data it sends, since Firefox 140
  (`data_collection_permissions`).
- **A page is not an article.** A whole page carries menus, footers and
  advertising around its text. A selection is what the person chose.
- **Pages are HTML.** Nether already turns HTML into Markdown for its
  importer ([ADR 0030](0030-web-pages-import-through-the-syntax-tree-tools.md)),
  so an imported page and a clipped one should read alike.
- **The server has no CORS**, so a page of another origin cannot call it.
  An extension with host permission for an origin can.
- **Privacy.** A clipper sees every page a person clips. Nether sends no
  telemetry, and has no server of its own.

## Decision

**The clipper is `apps/clipper`**, a Manifest V3 extension built by Vite,
as the apps are, in TypeScript without a UI framework. It has a popup
alone: no background script, which Chrome runs as a service worker and
Firefox as a page. It runs nothing until its button is pressed.

**One build per browser.** `pnpm --filter @nether/clipper build` writes
`dist/chrome/` and `dist/firefox/`, the same code with each browser's
manifest, and a ZIP of each for its store. Firefox's adds
`browser_specific_settings.gecko`: the ID `nether-clipper@fzn0x.github.io`,
Firefox 140 or later, and `data_collection_permissions` requiring
`websiteContent`, since a clip is a page's content sent to a server, the
person's own.

**Permissions are the fewest that work:**

- `activeTab` and `scripting`: pressing the button lets the popup read the
  tab it was pressed on, once, and nothing else;
- `storage`: the server's address and the token, in `storage.local`, which
  neither browser syncs;
- `optional_host_permissions` of `https://*/*` and `http://*/*`, of which
  setup asks for the one server's origin alone. With it, the popup reaches
  the server without CORS.

**A page becomes Markdown as an imported one does.** The popup injects a
script into the tab that reads it there:

- **A selection** is cloned as it is, its links' and images' addresses
  made absolute against the page.
- **A whole page** is read by Mozilla's Readability, the library of
  Firefox's Reader View (Apache-2.0, no dependencies), on a copy of the
  page, so menus and footers stay behind. It also gives the byline. A page
  it finds no article in is clipped whole.

The popup turns the HTML into Markdown with `@nether/markdown/html-import`,
the importer's own `htmlToMarkdown`, and shows the result to edit before
it is sent.

**What a clip is:**

- **A new note** at a folder and a title, `Clips/` and the page's title
  unless changed, with frontmatter of its `source` address, the `clipped`
  date and its `author` when the page names one. `POST .../notes`.
- **Added to a note** found by search: a `## ` heading of the page's title
  linking to it, then the Markdown, after the note's text. The popup reads
  the note, then `PUT`s it with `If-Match`. On 412, someone changed it
  meanwhile, and the popup reads it again and tries again, three times at
  most.
- **A database row**, from the databases of the workspace, titled as a
  note would be, with the same properties. `POST .../rows`.

The popup offers the workspaces the token reaches, leaving out encrypted
ones, whose notes the server cannot take, and remembers the last choices.

**Signing in is a write token**, which Nether's app makes in Servers and
signing in. Setup takes the server's address and the token. It asks the
browser for that origin, checks the token with `GET /api/v1/me`, and keeps
both. **Disconnect** forgets them and gives the origin back.

**Nothing leaves the browser but for the person's own server.** No
telemetry, no other host, no remote code: the extension's pages load only
its own scripts.

**Publishing to the Chrome Web Store and Firefox Add-ons** takes the
maintainer's own accounts. It is a follow-up issue, not a part of the
build.

## Alternatives

- **Without Readability, the whole page or its `<main>`.** No dependency,
  but many pages have no `<main>`, and a clip full of menus is edited by
  hand every time. Readability is the reader views' own, about 35 kB
  minified, and runs only in the clipped tab.
- **A content script on every page**, for a button inside it or a context
  menu. It would run on every page visited; `activeTab` runs it only on
  the one clipped.
- **A background script for the requests.** It would let a clip finish
  after the popup closes, but Chrome and Firefox run backgrounds
  differently in Manifest V3, and a clip takes a moment.
- **Signing in with a password, for a session.** A session ends after 30
  days unused; a token is made for this and can be revoked on its own.
- **Converting on the server**, by sending HTML. The API takes Markdown,
  and the popup's preview would differ from what is saved.
- **`@types/chrome` or WebExtension polyfills.** The popup uses a dozen
  calls, typed in a file of its own, through Firefox's `browser`, or
  Chrome's `chrome`, which gives promises in Manifest V3.

## Consequences

- The extension is a new app: built in `pnpm build`, unit-tested in
  `pnpm test`, and its end-to-end test loads the unpacked Chrome build in
  Playwright's Chromium against the web app's test server.
- A clip's popup must stay open until it is saved.
- Nether's API tokens get a second kind of user; a token for the clipper
  should be a write token of one workspace.
- Revisit a background script and a context menu, to clip without the
  popup, when people ask; and a Safari build, which needs Xcode.

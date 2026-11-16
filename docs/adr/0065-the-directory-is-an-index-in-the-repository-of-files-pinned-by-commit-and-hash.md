# 0065. The directory is an index in the repository, of files pinned by commit and hash

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#extensibility) ask for "a community
registry (GitHub-backed index file) browsable in the app" of plugins and
themes. A plugin from a vault already runs in a sandbox, approved on each
device for its code as it is
([ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md)).
A theme is a CSS file in `.nether/themes`
([ADR 0026](0026-themes-and-snippets-are-css-files-of-the-vault.md)); it
styles the app's own page, outside any sandbox, and CSS can load from an
address.

GitHub serves a repository's files at `raw.githubusercontent.com`, by
branch or by commit, to any page: its answers allow every origin. The web
app's policy lets it connect only to its own server.

## Decision

**The index is a JSON file in Nether's repository**, `registry/index.json`,
which the app reads from
`https://raw.githubusercontent.com/fzn0x/nether/main/registry/index.json`.
An author adds or updates an entry by pull request, which a maintainer
reviews. Each entry names its repository on GitHub, a commit, and each
file it installs with that file's SHA-256:

```json
{
  "version": 1,
  "plugins": [{
    "id": "word-goal", "name": "Word goal", "description": "…",
    "author": "someone", "repo": "someone/nether-word-goal",
    "commit": "<40 hex>", "version": "1.0.0",
    "files": { "manifest.json": "<sha256>", "main.js": "<sha256>" }
  }],
  "themes": [{
    "id": "dusk", "name": "Dusk", "description": "…",
    "author": "someone", "repo": "someone/nether-dusk",
    "commit": "<40 hex>", "files": { "dusk.css": "<sha256>" }
  }]
}
```

**Installing fetches each file at its commit**, from
`raw.githubusercontent.com/<repo>/<commit>/<file>`, and checks its hash
before writing anything. A plugin's files go to `.nether/plugins/<id>/`,
a theme's to `.nether/themes/<id>.css`. A plugin's manifest must read,
and have the entry's ID and version; a file that is not UTF-8 text is not
installed.

**Installing is not approving.** A plugin installed from the directory
is off, as one copied into the folder is, until this device turns it on
in the Plugins tab, which shows what it asks for there. Updating replaces
its files, so it is off again until approved again. An entry shows as
installed when the vault has a plugin of its ID at its version, or a
theme of its ID with its hash, and as one to update when the vault has
another.

**A theme from the directory loads nothing from an address.** Its CSS,
as the browser writes it out, may hold `url()` only for `data:` URLs, so
fonts and images come inside it; one that loads anything else is not
installed. A theme put in the folder by hand is the user's own, and is
not checked.

**The app reads the index only when asked**: Browse the directory, in the
Plugins tab or the Appearance tab, fetches it, and nothing else does, so
a vault that never asks makes no request. What was read is shown again
for five minutes. Offline, the directory says it cannot be reached. Its
requests send no cookie and follow no redirect.

**The web app's policy adds `https://raw.githubusercontent.com` to
`connect-src`.** The desktop page has no policy.

## Alternatives

- **A repository of its own for the index.** Cleaner history, but one
  more repository to create and keep; the index can move there later,
  as the app reads it from one address.
- **Files by branch or by tag.** A branch moves and a tag can be moved;
  a commit and a hash cannot, so what was reviewed is what installs.
- **The server fetching for the web app.** It would fetch addresses the
  index names, and the desktop app does not need it.
- **Installing as approving.** One click would both write the code and
  run it; the Plugins tab already approves, and shows the permissions as
  it does.
- **Themes that load fonts from the web.** Each would tell an address
  when the app opens, and CSS with selectors on attributes could carry
  more; a font fits in a `data:` URL.

## Consequences

- An entry is reviewed once, at its commit; an author's later commits
  reach no one until a new entry is merged.
- A self-hosted install without the internet has no directory; plugins
  and themes still install by copying their files into the vault.
- The index's address is fixed in the app for now; pointing it elsewhere
  would be a setting of its own.

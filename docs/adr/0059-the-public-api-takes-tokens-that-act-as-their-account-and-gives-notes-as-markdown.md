# 0059. The public API takes tokens that act as their account, and gives notes as Markdown

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#extensibility) ask for a "token-authenticated
API for notes, databases and search; webhooks on create/update/delete".
This record decides the API and its tokens.
[ADR 0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md)
decides the webhooks.

What the server has already:

- **Sessions** are bearer tokens kept as hashes
  ([ADR 0032](0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md)).
  One ends after 30 days unused. A script would have to keep a password to
  sign in again.
- **Permissions are sync units**
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)).
  An account opens each unit's notes at view, comment, edit or full
  access. Sync, search
  ([ADR 0050](0050-the-server-searches-what-it-can-read-indexed-as-notes-are-stored.md))
  and history all ask `accessible` which units an account opens.
- **A note on the server is a Yjs document**, not a file
  ([ADR 0035](0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md)).
  The desktop app writes a note that came from the server as Markdown,
  through the editor's schema and `@nether/markdown`
  ([ADR 0006](0006-markdown-file-format.md)). The server reads only the
  words of a note, for search, without the editor.
- **A database is a note** whose frontmatter holds its schema. Its rows
  are the notes in the folder beside it
  ([ADR 0018](0018-a-database-is-a-note-with-an-obsidian-base-beside-it.md)).
- **Hocuspocus holds a copy of each open document**
  ([ADR 0043](0043-a-note-open-in-the-editor-syncs-live-with-awareness-for-carets.md)).
  It stores that copy over the one in PostgreSQL every few seconds while
  people edit. The server already changes vault documents through it, by
  a direct connection, so the apps syncing them hear at once.
- **An end-to-end encrypted workspace** reaches the server only as
  ciphertext
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).

## Decision

### Tokens

**A personal access token belongs to an account, and acts as it,
narrowed.**

- A person makes one with a session: in the app, or by `POST /api/tokens`.
  It has a name, an access, read or write, and, if chosen, one workspace
  and an expiry of 1 to 366 days.
- Making one takes the account's password, or, for an account without one,
  a sign-in within the last ten minutes, as ending sessions does. A stolen
  session cannot quietly make itself a key that outlives it.
- The token is `nether_` and 32 random bytes in base64url. The prefix lets
  secret scanners find tokens left in code, and the server tell a token
  from a session. It is shown once.
- The server keeps its SHA-256, as it does a session's, and its last four
  characters, so a person can tell their tokens apart.
- `GET /api/tokens` lists an account's tokens: name, access, workspace,
  expiry, when it was made and when it was last used, marked at most every
  five minutes. `DELETE /api/tokens/:id` revokes one at once. An account
  has at most 100.
- Signing out, ending other sessions or changing the password leaves
  tokens as they are. They are listed and revoked on their own.

**A token works only on the public API, under `/api/v1`.** It does not
sync, and it does not manage sessions, tokens, members, units or a
password. Those take a session.

**What a token reaches is what its account reaches now.** Each request
checks the account's memberships and units, as sync does, then narrows
them by the token: a token of one workspace reaches no other, and a read
token changes nothing. An account removed from a workspace, or from a
page, takes its tokens out with it. A deleted account takes its tokens.

**The public API also takes a session**, with write access to every
workspace of its account. The app, and a person trying the API in a
terminal, need no token. A session in a cookie needs its CSRF value on
writes, as everywhere
([ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)).

### The API

- **JSON under `/api/v1`**, errors in Fastify's shape, as the rest of the
  server's. A change that breaks clients comes as `/api/v2`, with `v1`
  kept beside it for at least one release.
- **A note is named by its ID** in every address. Paths change; IDs do
  not.
- **Lists come in pages** of 100, or up to 1,000 by `limit`, with an
  opaque `next` to send back as `after`.
- **No CORS.** The API is for scripts, servers and integrations. A page of
  another site cannot call it from a browser, so no token needs to live in
  one.
- **Limits.** 300 requests a minute for each account, its tokens and
  sessions together, and 120 searches a minute. Each answers 429 with
  `Retry-After`.

| Endpoint | Gives |
| --- | --- |
| `GET /api/v1/me` | the account, and the token the request came with |
| `GET /api/v1/workspaces` | the workspaces the token reaches, with the account's role and the encryption |
| `GET /api/v1/workspaces/:workspace/notes` | the notes the account opens, by path: ID, path, title, tags and when last stored; `folder` narrows to one folder |
| `GET /api/v1/workspaces/:workspace/notes/:note` | the note, with its properties and its Markdown; with `Accept: text/markdown`, the Markdown alone |
| `GET /api/v1/workspaces/:workspace/databases` | the databases: notes with a schema, and the schema as their frontmatter has it |
| `GET /api/v1/workspaces/:workspace/databases/:note` | one database |
| `GET /api/v1/workspaces/:workspace/databases/:note/rows` | its rows, with their properties |
| `GET /api/v1/search?q=` | search, as ADR 0050 has it; `workspace` narrows to one |

**By the permissions sync uses.** Every route over notes asks
`accessible` for the units the account opens. A note in a unit it does
not open is answered 404, as one that is not there. So is a note no vault
document lists, as one in the trash. Lists come from the search index's
paths and properties (ADR 0050), filtered the same way.

**Notes are Markdown, as a vault on disk has them.** The server reads a
note's document with the editor's schema, and writes it with
`@nether/markdown`, as the desktop app writes a note that came from the
server: Obsidian-flavored Markdown with YAML frontmatter (ADR 0006).

- The server so depends on the editor's document module,
  `@nether/editor/document`, and with it on TipTap and ProseMirror, which
  ADR 0050 kept out for search. It loads them when the API first reads a
  note.
- A note open in an editor is read from Hocuspocus's copy, with the edits
  not stored yet. Another is read as last stored.

**Databases are as their files have them.** A database's schema is the
`database` value of its note's frontmatter, and its rows' values are their
frontmatter (ADR 0018). The API does not run a view's filters and sorts:
a client gets every row, and the views, to apply as it likes.

**Encrypted workspaces are listed, and their notes are not served.** The
server cannot read them (ADR 0038). Every route over their notes and
databases answers 409 and says so. Search names them as not searched, as
it does already.

### Writing

- Writing takes a write token, and edit access to the note's unit, as
  sync's writes do.
- `POST /api/v1/workspaces/:workspace/notes`, with a `path` and its
  `markdown`, makes a note. Its unit is the one the path falls in, by the
  sync engine's rule. The server makes the note's document from the
  Markdown, records its unit, then lists it in that unit's vault document.
  The apps hear of it, and fetch it as a note made elsewhere
  ([ADR 0037](0037-a-vault-syncs-through-a-document-of-its-paths-and-its-notes-documents.md)).
- `PUT .../notes/:note`, with `markdown`, replaces a note's text and
  properties. The new blocks are aligned with the document's, as a file
  edited on disk is: unchanged blocks keep their IDs, and with them their
  links and comments, and the document changes by the fewest edits.
- `DELETE .../notes/:note` takes the note off its unit's list. Each device
  sends it to its trash, where it can be restored (ADR 0037).
- `POST .../databases/:note/rows` makes a row: a note in the database's
  folder, with the properties given.
- **Every write goes through Hocuspocus**, by a direct connection to the
  document. Editors with the note open see the change as it is made, and
  it is stored as their edits are. A write to PostgreSQL alone would be
  lost when Hocuspocus next stores its copy.
- Moving and renaming notes, which on the desktop rewrites the links to
  them, comes later.

What the second part decided, building it:

- **A path is one every device can make.** Folders and a name ending in
  `.md`, each without `/ \ : * ? " < > |`, not hidden by a starting dot,
  not ending with a dot or a space, and not a name Windows keeps for
  devices, as the sync engine takes paths from the server. A path the
  workspace lists already, in any unit and in any case, answers 409.
- **A new note's unit is found among every unit of the workspace**, not
  only those the account opens. A path in a teamspace's folder the account
  cannot edit is refused with 403, never put in General, where the
  teamspace's members' apps would move it into the teamspace.
  `Private/` is the account's own private space; without one, the path
  answers 409, until the app makes it.
- **One make at a time per workspace on a node.** The check that a path is
  free and the listing follow each other in turn, and the vault document
  has the last word: if an app listed the path in between, the make
  answers 409.
- **Markdown comes as JSON or as itself.** `PUT` takes `{ "markdown": … }`
  or a `text/markdown` body, as a file is sent; a note is at most 5 MB of
  it. Frontmatter that does not read as YAML answers 400, where the
  desktop app would keep the properties it has: a script should hear it.
- **Changes can wait on what was read.** Reading a note gives an `ETag`,
  part of the SHA-256 of its Markdown. `PUT` and `DELETE` with `If-Match`
  answer 412 when the note changed since; for `PUT`, the check and the
  change are one transaction of the document. Without it, the text sent
  wins over what others typed since it was read.
- **A row's title is its file's name**, under the same rules, and its
  properties are set over those of the Markdown sent with it. The
  database's schema does not refuse values, as a file's frontmatter would
  not.
- **Answers.** Making answers 201, with the note as reading gives it, its
  `Location` and its `ETag`; replacing answers 200 with the note; deleting
  answers 204. A deleted note's document stays on the server, for a
  device's trash to restore.
- **Limits.** 120 writes a minute for each account, beside the 300
  requests.

### In the app

- **API tokens** are in the Servers and signing in dialog, under each
  account: name, workspace, access and expiry, 90 days unless changed. A
  new token shows once, with a button to copy it. The list shows when
  each was last used, and revokes.
- **Webhooks** (ADR 0060) are in a dialog of their own for the workspace a
  vault syncs with, for its owners and admins.
- **The guide** has an API reference page, updated with each part.

### Parts

The work comes in four pull requests:

1. Tokens and reading: this record, ADR 0060, tokens on the server, the
   reading routes, and the API reference.
2. Writing notes and rows, through their documents.
3. Webhooks, as ADR 0060 has them.
4. Tokens and webhooks in the app.

## Alternatives

- **OAuth 2.0 apps with scopes.** Right for services that act for many
  people. A self-hosted server's integrations are mostly its people's own
  scripts. OAuth can come beside tokens, with the integrations of Phase 5.
- **Finer scopes**, as `notes:read` or `search`. Read and write, by
  workspace, cover what a script needs, and units already narrow by page.
  Finer scopes can come later without breaking tokens.
- **Sessions alone.** A script would hold a password, and sign in again
  each month.
- **Signed tokens (JWTs).** Revoking one needs a list of revoked ones,
  which is a table of tokens again (ADR 0032).
- **Notes as the editor's JSON, or the core model's blocks.** Exact, but a
  format of Nether's own that changes with the editor. Markdown is the
  format people already own, as the first principle promises.
- **A Markdown writer of the server's own**, reading the Yjs document
  without ProseMirror. Lighter, but a second reader of the editor's
  document that can drift from the app's. Writing needs the schema anyway,
  to change a document by the fewest edits.
- **Writing the stored state in PostgreSQL.** Hocuspocus's copy of an
  open note would overwrite it.
- **GraphQL.** Another language for a few resources, and harder to limit
  by cost.

## Consequences

- The server's image carries the editor's dependencies, TipTap,
  ProseMirror, highlight.js and KaTeX among them: its installed
  dependencies take 91 MB where they took 35. A package of the editor's
  document code alone would take most of that back, if the size matters.
- The server's build only emits, with `noCheck`. Seen through pnpm's links,
  as the build sees workspace packages, their own dependencies do not
  resolve for the type checker. The typecheck script checks the whole
  program.
- The API's Markdown is what the desktop app writes for a note that came
  from the server. A file someone edited by hand may differ in style, as
  its list markers, but not in text, links or frontmatter.
- A note not open anywhere is read as last stored, two to ten seconds
  after its last edit.
- Data policies, in Phase 5, restrict export per workspace; they cover the
  API too.
- Revisit tokens' lifetime if admins ask to cap it, with a setting for the
  longest expiry.

# @nether/server

The Nether server: the API and the Yjs sync server (Hocuspocus) in one Node
service on [Fastify](https://fastify.dev), backed by PostgreSQL, Redis or
Valkey, and local or S3-compatible file storage. Clients talk to it only to
sync and share. See [ADR 0005](../../docs/adr/0005-server-on-fastify.md).

So far it answers `GET /health`, brings its PostgreSQL database to its
schema as it starts, makes the first account through first-run setup, signs
people in, invites others into workspaces, syncs their notes' Yjs
documents, and holds the extension point through which the free
[enterprise features](../../enterprise/) plug in.
Sync, sharing and the rest arrive in Phase 3. See ADRs
[0031](../../docs/adr/0031-the-server-keeps-its-data-in-postgresql-and-is-set-up-with-a-code-from-its-log.md),
[0032](../../docs/adr/0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md),
[0033](../../docs/adr/0033-sign-in-by-email-with-a-code-and-the-link-with-the-web-app.md)
[0034](../../docs/adr/0034-sign-in-with-openid-connect-through-the-server-and-back-to-the-app.md)
[0035](../../docs/adr/0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md)
and [0038](../../docs/adr/0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md).

## Run it

`docker compose up` in [`deploy/docker`](../../deploy/docker/) starts it
with PostgreSQL, Valkey and a volume for its files; the
[self-hosting guide](https://fzn0x.github.io/nether/self-hosting/) goes on
from there. To run it from the repository instead, it needs PostgreSQL 16
or newer, and a database for Nether on it.

```sh
pnpm --filter @nether/server build
NETHER_DATABASE_URL=postgres://nether:secret@localhost:5432/nether \
  pnpm --filter @nether/server start    # node dist/main.js
curl http://127.0.0.1:3000/health
```

## First-run setup

A server with no account yet writes a setup code to its log each time it
starts:

```text
The server has no account yet. Set it up from the app with this code: ABCDE-FGHJK-LMNPQ-RSTUV
```

`POST /api/setup` with that code makes the admin account and its first
workspace, once, and signs the admin in; `GET /api/setup` says whether the
server still waits for it. The desktop app's **Servers and signing in**,
and the web app's **Sign in**, ask for the code when the server waits, and
set it up. Only someone who can read the server's log can set it up, so a new
server reachable from the internet cannot be claimed by whoever finds it
first.

```sh
curl -X POST http://127.0.0.1:3000/api/setup -H 'content-type: application/json' \
  -d '{"code":"ABCDE-FGHJK-LMNPQ-RSTUV","name":"Ada","email":"ada@example.org",
       "password":"at least twelve characters","workspace":"Team"}'
```

Passwords are kept as argon2id hashes, with OWASP's parameters: 19 MiB of
memory, two passes, one lane.

## API

Requests and answers are JSON. A signed-in request sends its session's
token as `Authorization: Bearer <token>`. Every error is
`{ "statusCode", "error", "message" }`.

| Route | Signed in | |
| --- | --- | --- |
| `GET /health` | | The server's version, and which enterprise features are on |
| `GET /api/instance/features` | instance admin | Each enterprise feature: `on`, `pinned` (`on` or `off` when its variable sets it, else `null`) and `available` (this build has its module) (ADR 0079) |
| `PUT /api/instance/features/:feature` | instance admin | Turns a feature `on` or off, at once; 409 when its variable pins it, or the build has no module for it |
| `GET /api/instance/nodes` | instance admin | The server's nodes seen in the last two minutes, each with its `name`, `version`, `startedAt`, `seenAt`, and `current` for the one answering (ADR 0082) |
| `GET /api/admin/usage` | instance admin | With the `admin` feature on: accounts, those signed in in the last 30 days, workspaces and the encrypted ones, notes the server can read, attachments and their bytes, and the version |
| `GET /api/admin/workspaces` | instance admin | With the `admin` feature on: 50 workspaces by name after the `after` cursor, found by `search` in their names or their members' names and emails; each with its owners, members by role, notes the server can read (`null` when encrypted), bytes of documents, history and attachments, and last change; and `next`, the cursor of the page after, or `null` (ADR 0083) |
| `GET /api/admin/workspaces/:id` | instance admin | One workspace as the list has it, with its `members`: name, email, role and when each joined |
| `PATCH /api/admin/workspaces/:id/members/:user` | instance admin | Sets a member's `role`, any of the four, keeping at least one owner (409 otherwise); closes the member's sync connections |
| `GET /api/admin/security` | instance admin | With the `admin` feature on: each security setting's `name`, `value`, `pinnedBy` (its variable, or `null`) and, for a number, `min` and `max` (ADR 0084) |
| `PUT /api/admin/security` | instance admin | Sets settings by name, all or none: 400 for one unknown or out of range, 409 for one its variable pins; gives the settings as they are then |
| `GET /api/admin/ai-endpoints` | instance admin | With the `policies` feature on: the approved AI `endpoints`, and `pinnedBy`, `NETHER_AI_ENDPOINTS` or `null` (ADR 0086) |
| `PUT /api/admin/ai-endpoints` | instance admin | Sets the approved `endpoints`, 20 at most, each an http or https address; an empty list locks nothing; 400 for one that is not an address, 409 while the variable pins them |
| `GET /api/admin/data-policies` | instance admin | With the `policies` feature on: the policy for `every` workspace, each workspace set `apart` with its `name` and `policy`, and the `others` (ADR 0088). A policy is `shareLinks` (`on`, `view` or `off`), `sites` and `export` |
| `PUT /api/admin/data-policies` | instance admin | Sets every workspace's policy, all three settings; closes the visits of the links it narrows |
| `PUT /api/admin/data-policies/workspaces/:id` | instance admin | Sets a workspace apart with its own policy; 404 for no such workspace |
| `DELETE /api/admin/data-policies/workspaces/:id` | instance admin | Puts a workspace back under every workspace's policy; 404 when it was not apart |
| `GET /api/setup`, `POST /api/setup` | | First-run setup, above |
| `GET /api/sign-in-methods` | | Which ways to sign in this server offers: `password`, `emailCode` when it can send email, and `oidc` with the provider's name |
| `POST /api/sessions` | | Signs in with `email` and `password`; gives `token` and `expiresAt` |
| `POST /api/sign-in-codes` | | Emails a code to sign in to `email`, if it has an account; answers 202 either way |
| `POST /api/sign-in-codes/redeem` | | Signs in with `email` and its `code`, as signing in with a password does |
| `POST /api/oidc/flows` | | Starts signing in with the OIDC provider: the app's `redirect` and PKCE `challenge`, and an `invitation` if any; gives the provider's `url` to open |
| `GET /api/oidc/callback` | | Where the provider sends the browser; sends it on to the app's `redirect` with a `code` or an `error` |
| `POST /api/oidc/redeem` | | Signs in with that `code` and the app's PKCE `verifier` |
| `GET /api/sessions` | yes | The account's sessions, the current one marked |
| `DELETE /api/sessions/current` | yes | Signs out |
| `POST /api/sessions/revoke` | yes | Ends the session `session`, or every other one, with `password` |
| `GET /api/me` | yes | The account, the workspaces it is in with its role in each and the `policies` its apps keep to, `{ "export": false }` or `null` (ADR 0088), and `aiEndpoints`: the only addresses its apps may send AI requests to, or `null` when nothing is locked (ADR 0086) |
| `PUT /api/me/password` | yes | Changes the password from `current`; ends every other session |
| `POST /api/workspaces/:id/invitations` | owner, admin; full on the page | Invites someone as `admin` or `member`, for one `email` or anyone; or as a `guest` to one shared page (`unit`) at a `level`; gives `token` |
| `GET /api/workspaces/:id/invitations` | owner, admin | The invitations not yet accepted |
| `DELETE /api/workspaces/:id/invitations/:invitation` | owner, admin | Withdraws one |
| `GET /api/workspaces/:id/members` | member | The members, with their `role`; guests are refused |
| `PATCH /api/workspaces/:id/members/:user` | owner, admin | Sets a member's `role`: owners set any, admins move members and guests; a workspace keeps an owner |
| `DELETE /api/workspaces/:id/members/:user` | owner, admin, self | Removes a member, or leaves; owners remove anyone, admins members and guests |
| `GET /api/workspaces/:id/units` | member | The units the account opens: `general`, teamspaces and its private space, each with its `level` and vault `document` |
| `POST /api/workspaces/:id/teamspaces` | member | Makes a teamspace named `name`, its maker at full access |
| `PATCH /api/workspaces/:id/teamspaces/:unit` | full | Renames it |
| `DELETE /api/workspaces/:id/teamspaces/:unit` | full | Deletes it, once no note is in it |
| `PUT /api/workspaces/:id/units/:unit/grants/:user` | full | Gives a member a `level`: `full`, `edit`, `comment` or `view` |
| `DELETE /api/workspaces/:id/units/:unit/grants/:user` | full | Takes it back; a teamspace keeps someone at full access |
| `PUT /api/workspaces/:id/private` | member | The account's private space, made the first time |
| `GET /api/workspaces/:id/units/:unit/grants` | in the unit | Who opens it by a grant of their own, at which `level`; for full access, its invitations waiting |
| `POST /api/workspaces/:id/pages` | full where it is | Shares a page on its own: the `note` and its subtree become a unit, `restricted` to its grants or keeping its parent's people |
| `PATCH /api/workspaces/:id/pages/:unit` | full | Restricts it, or not |
| `DELETE /api/workspaces/:id/pages/:unit` | full, and edit where it sits | Shares it no longer on its own: its notes and inner pages go back where it sits |
| `PUT /api/workspaces/:id/notes/:note/unit` | edit in both | Moves a note into `unit`, or `general` |
| `GET /api/workspaces/:id/sites` | member | The workspace's published sites the account may change, whether `publishing` is on, and whether it `manages` the switch |
| `POST /api/workspaces/:id/sites` | full where it is | Publishes a `note` with its subpages, or a `folder`, as a site at `/p/<name>/`, with a `title`; gives its `url` |
| `PATCH /api/workspaces/:id/sites/:site` | full where it is; owner, admin | Renames it, which moves its address, changes its `title`, or whether search engines may index it, `indexed` |
| `DELETE /api/workspaces/:id/sites/:site` | full where it is; owner, admin | Unpublishes it |
| `PUT /api/workspaces/:id/sites/:site/domain` | full where it is; owner, admin | Claims a custom `domain`; gives the TXT `record` that proves it |
| `POST /api/workspaces/:id/sites/:site/domain/check` | full where it is; owner, admin | Looks the record up; found, the site holds the domain, taking it from any other site |
| `DELETE /api/workspaces/:id/sites/:site/domain` | full where it is; owner, admin | Gives the domain up |
| `GET /api/sites/domain` | | 200 when a published site holds `domain`, 404 otherwise, for a proxy's on-demand TLS |
| `PUT /api/workspaces/:id/publishing` | owner, admin | Turns publishing on or off for the workspace, with `enabled` |
| `POST /api/workspaces` | yes | Makes a workspace the account owns, with `name`; `encryption: "end-to-end"` and the maker's `sealedKey` make it encrypted |
| `PUT /api/me/keys`, `GET /api/me/keys` | yes | The account's `publicKey`, and its private key in a `recoveryBox` only its recovery phrase opens; kept once |
| `GET /api/workspaces/:id/key` | member | The account's own sealed copy of an encrypted workspace's key, at its latest `version` |
| `GET /api/workspaces/:id/keyless` | member | The members with keys and no copy of the latest version, for one who has it to seal |
| `PUT /api/workspaces/:id/keys/:user` | keyholder | Seals the key for a member waiting; a copy kept is never replaced |
| `PUT /api/workspaces/:id/attachments/:hash` | member | Keeps a file's bytes, sent as `application/octet-stream`, if they hash to `hash` (SHA-256); `x-content-type` names its media type |
| `HEAD /api/workspaces/:id/attachments/:hash` | member | Whether the workspace has the file, before sending it |
| `GET /api/workspaces/:id/attachments/:hash` | member | The file, served so it runs and loads nothing |
| `GET /api/workspaces/:id/documents/:note/versions` | member | The note's versions, the latest 200 first: `{ versions: [{ id, time }] }` |
| `GET /api/workspaces/:id/documents/:note/versions/:version` | member | A version, as the Yjs state the note had |
| `POST /api/workspaces/:id/notifications` | comment on the note | Tells the `people` a comment on `note` mentions, in `thread`, those who may open the note; `title` and `excerpt` only outside encrypted workspaces; gives who was `notified` |
| `GET /api/notifications` | yes | The account's latest 50 notifications, or the `unread` ones, with the `unread` count |
| `POST /api/notifications/read` | yes | Marks the notifications `ids`, or `all`, read |
| `GET /api/me/notification-settings`, `PUT /api/me/notification-settings` | yes | Whether the account is emailed when mentioned, `email` |
| `GET /api/search` | yes | Searches `q` in every workspace the account is in that the server can read, in the units it opens (ADR 0050): words, the last one a prefix, `"phrases"`, `-exclusions`, `tag:`, `path:` and `prop:` filters; gives up to `limit` (50) `results`, each with `workspace`, `note`, `title`, `path`, a `snippet` and its `matches` as offsets, and the `encrypted` workspaces not searched |
| `GET /api/relay` | per message | The WebSocket encrypted workspaces sync over, below |
| `GET /api/workspaces/:id/documents` | member | The documents stored since `since`, a number, in order, a thousand at a time with `more` |
| `GET /api/sync` | per document | The WebSocket that Hocuspocus providers sync documents over, below |
| `POST /api/invitations/lookup` | | The workspace and role a `token` invites to |
| `POST /api/invitations/accept` | either | Accepts a `token`: signed in, into that account; or with `name`, `email` and `password`, as a new account, signed in |

**Sessions in a browser** ([ADR 0053](../../docs/adr/0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)):
a page signs in with the header `X-Nether-Session: cookie`, on any of the
routes that sign in. The answer then sets the session's token in the
`HttpOnly`, `SameSite=Strict` cookie `nether_session` and leaves it out of
its body, and sets `nether_csrf`, which the page reads and sends back as
`X-Nether-CSRF` on every request but `GET`, `HEAD` and `OPTIONS`; without
it such a request is refused with 403. The sync and relay sockets take the
cookie only when their `Origin` is the server's own. `DELETE
/api/sessions/current` takes the cookies off. With `NETHER_PUBLIC_URL`
set, the email with a sign-in code also links to
`<address>/sign-in#email=…&code=…`.

A session ends when its client signs out, after 30 days unused, or 90
days after it began. Invitations last seven days and are accepted once.
A code emailed to sign in works once, within 15 minutes, and five wrong
tries spend it. Only the SHA-256 of a session's or an invitation's token,
or of a code, is kept.

Signing in is limited to 30 tries in five minutes from one address, and 10
in 15 minutes for one account from anywhere. One email address gets at
most three codes in 15 minutes. One account mentions people 60 times in
10 minutes, and searches 120 times a minute. Setup, invitations, ending sessions and changing passwords
have limits of their own. Each answers `429` with `Retry-After`.

Each node counts these tries in its memory, unless `NETHER_REDIS_URL`
names a Redis or Valkey server: then they count there, so a restart forgets
none and several nodes count together
([ADR 0054](../../docs/adr/0054-docker-compose-starts-the-server-with-postgresql-valkey-and-volumes.md)).
The server checks that it answers as it starts; while it cannot reach it,
the routes with a limit answer `503` with `Retry-After: 60` rather than go
unlimited, and the log says when it is lost and when back.

## Notifications

Someone mentioned in a comment is told in the app, and by email
([ADR 0045](../../docs/adr/0045-mentions-are-named-by-the-commenting-client-and-the-server-tells-those-who-may-open-the-note.md)).
The app that sends the comment names the people it mentions; the server
checks that the sender may comment on the note, and tells only those who
may open it. In an encrypted workspace, a notification says who mentioned
whom in which note, and nothing of the note or the comment. The server
keeps notifications for 90 days, and deletes older ones once an hour, in a
job one node runs (ADR 0082).

## Members

A change to someone's role, or their removal, closes their open sync and
relay connections. Their apps connect again, and every document is checked
anew: a removed member syncs nothing more, and one made a guest only reads.
Someone removed from an encrypted workspace loses their copy of its key on
the server; what their devices decrypted before stays with them.

An invitation's link is the server's address, `/invite`, and the token
after a `#`, as `https://nether.example.org/invite#…`: browsers never send
what follows the `#`, so no log keeps the token. The desktop app makes these
links and joins with them; the web app will open them.

## Units

A workspace's notes are divided into sync units
([ADR 0042](../../docs/adr/0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)): General, which every member but guests
opens, teamspaces, which their members open, each member's private space,
and pages shared on their own. Each has a vault document of its own,
`<workspace>/vault` for General and `<workspace>/vault.<unit>` for the
others, and a note's document opens at its unit's level, read-only below
edit. Which unit a note is in is the server's record: one it does not name
is in General.

A shared page keeps the levels of the unit it sits in, raised by its own
grants, unless it is restricted, when only its grants count; a page inside
it sits in its unit, so levels follow the page tree. Guests open only the
pages shared with them, invited to each at a level. An encrypted workspace
has General alone, for now.

## Sync

Clients sync Yjs documents with Hocuspocus over one WebSocket at
`/api/sync`, on the API's own port, so a reverse proxy needs only to pass
WebSocket upgrades through. A document is named `<workspace id>/vault`, the
vault's list of notes, or `<workspace id>/<note id>`. A provider signs each
one in with its session's token as Hocuspocus's `token`: a workspace's
members read and write its documents, and its guests only read them.

```ts
new HocuspocusProvider({
  url: "wss://nether.example.org/api/sync",
  name: `${workspaceId}/${noteId}`,
  token: session.token,
});
```

The server stores a document two seconds after it stops changing, and at
least every ten seconds, as its merged state numbered from one sequence. A
workspace's stores draw their numbers in the order they commit, under a
lock for the workspace held to the commit (ADR 0082), so a listing that
shows a number shows every smaller one. A node keeps the number it read
or stored each open document at; when another node or process stored it
since, its store merges with what is stored rather than replacing it,
and its open document gets what it lacked. A store of a document no one else
changed reads nothing more than it did. A client back from being away asks
`GET /api/workspaces/:id/documents?since=<the last number it saw>` and
syncs only those. A client syncing the vault document hears of every note
as it is stored, as the stateless message
`{ "type": "stored", "document": "<note id>", "seq": 42 }`.

## Encrypted workspaces

A workspace made with `encryption: "end-to-end"` is encrypted by its
members' apps, and the server never sees its keys or its notes (ADR 0038).
Each account has a key pair whose private key the server keeps only in a
box its recovery phrase opens; each member has the workspace's key, sealed
to their public key by a member who had it.

Hocuspocus refuses these workspaces' documents. They sync through
`/api/relay`, which keeps each encrypted update in order, numbered from the
same sequence, and sends it on. Each node reads a workspace's updates in
the order they are numbered, after the last it read, and sends them to its
own subscribers: when it stores one, when the bus says another node did,
and every five seconds. It tells a pusher its number once it has read past
it. A socket sends `{"type":"auth","token"}`, then:

| Message | Answer |
| --- | --- |
| `{"type":"subscribe","name","after"}` | `updates` of `{seq, data}` stored since `after`, then `subscribed` with the last number, then each update pushed |
| `{"type":"push","id","name","data"}` | `pushed` with the update's `seq`; the vault document's subscribers hear `stored` |
| `{"type":"compact","id","name","through","data"}` | `compacted`: the snapshot replaces the updates up to `through` |
| `{"type":"unsubscribe","name"}` | none |

Data is base64. Guests may subscribe, not push or compact.

## Attachments

Files notes embed are kept by the SHA-256 of their bytes, once per
workspace ([ADR 0039](../../docs/adr/0039-attachments-are-kept-by-their-hash-on-disk-or-in-an-s3-bucket.md)). By default they are files
under `NETHER_STORAGE_PATH`; with `NETHER_STORAGE=s3` they are objects in an
S3-compatible bucket, such as MinIO, Garage, Cloudflare R2 or Amazon S3:

```sh
NETHER_STORAGE=s3
NETHER_S3_ENDPOINT=http://minio:9000
NETHER_S3_BUCKET=nether
NETHER_S3_ACCESS_KEY=…
NETHER_S3_SECRET_KEY=…
```

Objects are addressed by path, as `<endpoint>/<bucket>/<workspace>/<hash>`.

## History

When sync stores a note whose last version is ten minutes old, the server
keeps the state the store replaces as a version, so a note's history has
it as it was before each spell of editing
([ADR 0041](../../docs/adr/0041-a-notes-history-is-its-earlier-texts-kept-before-each-spell-of-editing.md)). It keeps versions for
`NETHER_HISTORY_DAYS`, 30 days unless set, and deletes older ones once
an hour, in a job one node runs (ADR 0082). An encrypted workspace has no
versions here: its devices keep their own.

## Email

Set `NETHER_SMTP_URL` and `NETHER_MAIL_FROM` for the server to send email:
the codes that sign in by email, and notifications of mentions to those
who have not turned them off. Without them it sends none, and the app
offers only passwords.

```sh
NETHER_SMTP_URL=smtp://nether:secret@mail.example.org:587
NETHER_MAIL_FROM='Nether <nether@example.org>'
```

`smtp://` uses STARTTLS when the mail server offers it; `smtps://` (port
465) uses TLS from the start. A message that cannot be sent is written to
the server's log.

## Signing in with OpenID Connect

People can sign in with the team's OpenID Connect provider, such as
Keycloak, Authentik, Okta, Microsoft Entra ID or Google. Register Nether
with it as a confidential client whose redirect address is
`NETHER_PUBLIC_URL/api/oidc/callback`, then set:

```sh
NETHER_PUBLIC_URL=https://nether.example.org
NETHER_OIDC_ISSUER=https://login.example.org/realms/team
NETHER_OIDC_CLIENT_ID=nether
NETHER_OIDC_CLIENT_SECRET=…
NETHER_OIDC_NAME=Keycloak
```

The provider's identity signs in to the account whose address the provider
has verified, and stays linked to it. A person without an account signs in
only with an invitation, unless `NETHER_OIDC_SIGN_UP=on` lets everyone the
provider signs in have one. A provider named with `http://` is used, with a
warning in the log: do that only on a private network.

The app opens the provider in the browser and listens on a loopback
address, by IP, for the browser to come back with a code, which it redeems
with its PKCE verifier (RFC 8252). The web app comes back to the server's
own address.

## Database

The schema is a list of numbered migrations in
[`src/migrations.ts`](src/migrations.ts). Each start applies the ones the
database lacks, in one transaction under a lock, so several nodes starting
at once apply each once and a failed migration changes nothing. A server
refuses to start on a database a newer server has migrated. Any number of
versions may be skipped: a server applies every one in between, in order.

## Backups and restoring

A backup is one file, `nether-backup-<time>.ndjson.gz`, holding the
database and every attachment, made in one consistent snapshot while the
server runs ([ADR 0052](../../docs/adr/0052-backups-are-the-server-s-own-files-restored-at-their-schema-then-migrated.md)).
No `pg_dump` is needed.

**Scheduled backups**: set `NETHER_BACKUP` to `disk` (into
`NETHER_BACKUP_PATH`) or `s3` (into `NETHER_BACKUP_S3_BUCKET`, with the
`NETHER_S3_*` endpoint and keys). The server makes one every
`NETHER_BACKUP_HOURS` and keeps the newest `NETHER_BACKUP_KEEP`; of
several nodes, one makes each. Its log says when it made one, and why it
could not.

**By hand**, with the server's environment set:

```sh
node dist/admin.js backup                       # now, where NETHER_BACKUP keeps them
node dist/admin.js backup ~/nether.ndjson.gz    # now, into a file
node dist/admin.js backups                      # those kept
```

**Restoring**, into a new, empty database:

1. Stop the server.
2. Make an empty database, as `createdb nether_restored`, and point
   `NETHER_DATABASE_URL` at it. Point `NETHER_STORAGE` and its settings at
   where the attachments should go.
3. Restore a backup kept, by its name, or a file:

   ```sh
   node dist/admin.js restore nether-backup-2026-11-01T03-00-00Z.ndjson.gz
   node dist/admin.js restore ~/nether.ndjson.gz
   ```

4. Start the server on the restored database.

A restore refuses a database that has data, so a backup never overwrites
one. A backup made by an older server of the same major release restores
into a newer one, migrated as it is restored; one made by a newer server
is refused. CI runs these steps on every change, against PostgreSQL.

## Published sites

A page with its subpages, or a folder, of a workspace the server can read
is published as a site at `/p/<name>/`
([ADR 0076](../../docs/adr/0076-a-published-site-is-a-note-or-a-folder-drawn-by-the-server-as-it-is-now-linking-only-to-its-own-pages.md)),
for anyone, with no session. Each page is drawn when it is asked for,
from its note as stored, as HTML with no script: the notes under the root
its publisher has full access to then, without those whose frontmatter
says `publish: false`. A link leads to a page only of the same site; any
other is its text. A page's images and files are served by their hash at
`/p/<name>/.files/<hash>/<file name>`, only once one of its pages showed
them, as attachments are. What a site has is kept five seconds, and
forgotten when it changes. Pages share `/p/.nether/site.css`, and every
answer under `/p/` has a policy of its own: nothing runs, nothing is
framed or sent, and only images, media and that stylesheet load. A
publisher who leaves the workspace takes their sites; an owner or an
admin turns publishing off, and an encrypted workspace publishes nothing.
Each address may ask for 600 pages and files a minute.

**Custom domains** ([ADR 0077](../../docs/adr/0077-a-site-holds-a-custom-domain-its-dns-proves-and-tells-search-engines-what-each-page-is.md)):
a site claims a domain, and holds it once a TXT record at
`_nether-site.<domain>` has the value the claim was given, which the
server looks up with the system's resolver. One site holds a domain at a
time, the last to prove it. A request whose host, as the trusted proxy
gives it, is a domain a site holds is that site's on every path: `/`,
its pages, `/.files/...`, `/.nether/site.css`, `/sitemap.xml` and
`/robots.txt`, and nothing of the API or the web app. No site may hold
`NETHER_PUBLIC_URL`'s host, an address or a `localhost` name.
`GET /api/sites/domain?domain=` is what a proxy asks before it gets a
domain a certificate, as Caddy's on-demand TLS does.

**What search engines read**: each page's description, from its
`description` property or its first paragraph, its canonical address, on
its domain when it has one, and an Open Graph card with the `image`
property's image or its first. A site's `sitemap.xml` lists the pages
that may be indexed; `noindex: true` in a note, or a site's `indexed`
turned off, asks with `<meta name="robots">` and `X-Robots-Tag`.

## The web app

The server serves the web app at `/`
([ADR 0053](../../docs/adr/0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)):
by default the build in `apps/web/dist` beside it, when it was built, or
the folder `NETHER_WEB_APP` names; `NETHER_WEB_APP=off` serves only the
API.

```sh
pnpm --filter @nether/web build
pnpm --filter @nether/server start      # the app at http://127.0.0.1:3000/
```

Every path the API does not have, and that names no file, gets the app's
page, as `/invite` and `/sign-in` do; `/api/…` keeps its JSON answers.
Files under `/assets/` are named by their content and kept by browsers for
a year; the page, its manifest and its service worker are checked each
time. Each answer carries the app's content security policy: its own
scripts, workers and WebAssembly, connections to this server alone, images
and media from it and from `blob:` and `data:`, no frames, and no inline
scripts.

The service worker keeps all of the app's files, about 11 MB, once it is
opened, so it opens offline. Serve it over HTTPS: browsers keep the
session's cookies `Secure` and run service workers only there, or on this
machine.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `NETHER_HOST` | `127.0.0.1` | The address to listen on; the Docker image sets `0.0.0.0` |
| `NETHER_PORT` | `3000` | The port; `0` picks a free one |
| `NETHER_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `NETHER_DATABASE_URL` | none, required | The PostgreSQL database, as `postgres://user:password@host:5432/nether` |
| `NETHER_NODE_NAME` | the machine's name | This node's name among the server's nodes, as the console lists them (ADR 0082) |
| `NETHER_REDIS_URL` | none | The Redis or Valkey server the rate limits count in, as `redis://valkey:6379` or `rediss://` for TLS; without one, each node counts in its memory |
| `NETHER_SMTP_URL` | none | The SMTP server email goes through, as `smtp://user:password@host:587` or `smtps://user:password@host:465` |
| `NETHER_MAIL_FROM` | none, required with `NETHER_SMTP_URL` | The sender, as `Nether <nether@example.org>` |
| `NETHER_PUBLIC_URL` | none | The address people reach the server at, as `https://nether.example.org`; needed for OIDC |
| `NETHER_OIDC_ISSUER` | none | The OpenID Connect provider's issuer; sets up signing in with it |
| `NETHER_OIDC_CLIENT_ID` | none, required with the issuer | Nether's client ID at the provider |
| `NETHER_OIDC_CLIENT_SECRET` | none | Its secret; without one, a public client using PKCE alone |
| `NETHER_OIDC_NAME` | `single sign-on` | The provider's name on the app's button |
| `NETHER_OIDC_SIGN_UP` | `off` | Whether anyone the provider signs in gets an account, not only the invited |
| `NETHER_STORAGE` | `disk` | Where attachments are kept: `disk` or `s3` |
| `NETHER_STORAGE_PATH` | `data/attachments` | The folder for `disk`, relative to where the server runs |
| `NETHER_S3_ENDPOINT` | none, required for `s3` | The S3-compatible store's address |
| `NETHER_S3_BUCKET`, `NETHER_S3_ACCESS_KEY`, `NETHER_S3_SECRET_KEY` | none, required for `s3` | The bucket and the keys to it |
| `NETHER_S3_REGION` | `us-east-1` | The region requests are signed for |
| `NETHER_ATTACHMENT_LIMIT` | `100` | The largest attachment taken, in MiB |
| `NETHER_HISTORY_DAYS` | `30` | How many days notes' earlier versions are kept |
| `NETHER_BACKUP` | `off` | Scheduled backups: `off`, `disk` or `s3` |
| `NETHER_BACKUP_PATH` | `data/backups` | The folder for `disk` backups |
| `NETHER_BACKUP_S3_BUCKET` | none, required for `s3` | The bucket for `s3` backups, reached with the `NETHER_S3_*` endpoint, region and keys |
| `NETHER_BACKUP_S3_PREFIX` | `nether-backups/` | The folder of that bucket they go in |
| `NETHER_BACKUP_HOURS` | `24` | How many hours apart backups are made |
| `NETHER_BACKUP_KEEP` | `7` | How many backups are kept, the newest |
| `NETHER_WEB_APP` | `apps/web/dist`, when built | The web app's build to serve at `/`, or `off` |
| `NETHER_TRUST_PROXY` | `off` | Behind a reverse proxy, whose `X-Forwarded-For` to believe: `on` for any, or addresses and ranges such as `10.0.0.2, 172.16.0.0/12` or `uniquelocal` |
| `NETHER_WEBHOOK_PRIVATE` | `off` | Addresses that are not public which webhooks may reach, for services on your own network: `on` for any, or addresses and ranges such as `192.168.1.20, 10.0.0.0/8`; those may use `http://` |
| `NETHER_AI` | `on` | AI for the web app through this server (ADR 0070): `on` with each account's providers and the admin's, `admin` with the admin's alone, or `off` |
| `NETHER_AI_PRIVATE` | `off` | Addresses that are not public which the admin's AI providers may reach, as a model on your own network: `on` for any, or addresses and ranges such as `192.168.1.20, 10.0.0.0/8`; those may use `http://`. An account's own providers reach public addresses only |
| `NETHER_SECRET_KEY` | none | 32 random bytes in base64, as `openssl rand -base64 32` makes them, which seal AI providers' keys at rest; without it the server keeps no keys. Keep it with your backups' secrets: a restore needs the same key to open them |
| `NETHER_ENTERPRISE_SSO` | unset | Single sign-on |
| `NETHER_SSO_ENFORCE` | unset | `off` stops single sign-on requiring its providers, as the console sets it, until unset: the way back in when a provider breaks (ADR 0080) |
| `NETHER_ENTERPRISE_SCIM` | unset | Provisioning through SCIM and LDAP |
| `NETHER_ENTERPRISE_AUDIT` | unset | Audit logs |
| `NETHER_ENTERPRISE_POLICIES` | unset | Data policies and advanced permissions |
| `NETHER_ENTERPRISE_ADMIN` | unset | The admin console's usage, workspaces and security pages |
| `NETHER_ENTERPRISE_HA` | unset | High availability |
| `NETHER_SESSION_IDLE_DAYS` | unset, 30 | Days a session lasts unused, from 1 to 365 |
| `NETHER_SESSION_LIFETIME_DAYS` | unset, 90 | Days a session lasts however much it is used, from 1 to 3650 |
| `NETHER_SIGN_IN_TRIES_ACCOUNT` | unset, 10 | Sign-in tries per account in 15 minutes, from 3 to 100 |
| `NETHER_SIGN_IN_TRIES_ADDRESS` | unset, 30 | Sign-in tries, and email codes redeemed, per address in 5 minutes, from 5 to 1000 |
| `NETHER_SIGN_IN_EMAIL_CODES` | unset, on | Whether a code by email signs in, where the server can send email |
| `NETHER_AI_ENDPOINTS` | unset | The approved AI endpoints, comma-separated, 20 at most, as `https://llm.example.com/v1`; with the `policies` feature on, every app sends AI requests only to them or under them (ADR 0086) |

An enterprise feature is off until an instance admin turns it on in the
admin console (ADR 0079). Its variable, set to `on` or `off` (or `true`,
`false`, `yes`, `no`, `1`, `0`), pins it instead, and the console shows
it as set by the variable. A feature pinned on in a build without its
module stops the server at startup with a message that names the
variable. The image starts the server from `enterprise/server`, which
gives it every module; `node dist/main.js` starts it with none.

The five security settings, from `NETHER_SESSION_IDLE_DAYS` down, are the
admin console's Security page's (ADR 0084), the defaults until an instance
admin changes them. Set, a variable pins its setting, and the console
shows it as set by the variable; a value out of its range stops the
server at startup, naming the variable. A session lasts by the lengths as
they are now, so a shorter one ends sessions past it at their next
request.

`NETHER_AI_ENDPOINTS` pins the approved AI endpoints that the console's AI
endpoints section otherwise sets (ADR 0086). They lock AI only while the
`policies` feature is on: the relay then refuses, and does not keep, a
provider at any other address, and `/api/me` gives the list to the apps,
which keep to it.

The data policies (ADR 0088) hold only while the `policies` feature is on
too. A workspace's share links may only view, or open nothing, its sites
may not be served, and the public API may keep its notes' text, rows and
search passages, answering 403. `/api/me` gives each workspace's
`policies`, `{ "export": false }` for one, or `null` while the feature is
off. Each node reads them again within five seconds.

Set `NETHER_TRUST_PROXY` whenever the server is behind a proxy, or every
client shares the proxy's address and its limits on signing in. Use `on`
only when nothing but the proxy can reach the server.

## Tests

```sh
pnpm --filter @nether/server test     # Vitest, through Fastify's inject
pnpm --filter @nether/server smoke    # starts dist/main.js with every enterprise feature off
```

The tests run on [PGlite](https://pglite.dev), PostgreSQL in the test's own
process, so they need no server. With `NETHER_TEST_DATABASE_URL` set, as in
CI, they run on that PostgreSQL instead, each in a schema of its own that it
drops. With `NETHER_TEST_REDIS_URL` set, as in CI too, their rate limits
count in that Redis or Valkey, each server's under a prefix of its own,
and the test of two nodes sharing one runs. The smoke run needs
`NETHER_DATABASE_URL`.

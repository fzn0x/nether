---
title: REST API
description: Read and write a workspace's notes as Markdown, its databases and their rows, and search it, from scripts and other services, with a personal access token; and hear of its notes' changes by webhooks.
---

A Nether server has a REST API for scripts and other services. With a
personal access token, it reads and writes the notes of the workspaces you
belong to as Markdown, reads their databases and adds rows to them, and
searches them. Webhooks tell other services when notes are made, changed
or deleted. The app makes both, as below, and so does the API itself.

## Tokens

A personal access token acts as your account, narrowed. It is either
**read**, or **write**, which also reads, and reaches either every
workspace you belong to or one of them. It can expire after 1 to 366
days, or never.

A token reaches what your account can open when it is used: the
workspaces you are a member of, and in each, the spaces and pages you may
open. If you leave a workspace, or lose access to a page, your tokens lose
it too.

A token works only on the API under `/api/v1`. It cannot sync, sign in,
change your password, or make other tokens.

### Making one

**In the app**, open **Servers and signing in** and choose **API tokens on**
your server, under your account; or, in a vault that syncs, **API tokens**
in the **Sync** menu. Name the token, choose its access, its workspace and
when it expires, 90 days unless you change it, and type your password.
**Make the token** shows it once, with **Copy** beside it. The list above
shows each of your tokens, when it was last used, and **Revoke**.

**Through the API**, making a token takes a session and your password.
Sign in first:

```sh
curl https://nether.example.org/api/sessions -H 'content-type: application/json' \
  -d '{"email":"ada@example.org","password":"your password"}'
```

The answer's `token` is the session's. Then make the token with it:

```sh
curl https://nether.example.org/api/tokens \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"name":"Backups","access":"read","expiresInDays":90,"password":"your password"}'
```

| Field           | What it is                                                   |
| --------------- | ------------------------------------------------------------ |
| `name`          | What the token is for, to tell it from the others            |
| `access`        | `read` or `write`                                            |
| `workspace`     | The one workspace it reaches; without it, every one of yours |
| `expiresInDays` | Days it lasts, from 1 to 366; without it, it never expires   |
| `password`      | Your account's password                                      |

An account that signs in with single sign-on has no password: make the
token within ten minutes of signing in, and leave `password` out.

The answer has the token, which starts with `nether_`. It is shown once:
keep it somewhere safe, as a password manager or your CI's secrets. The
server keeps only its hash, and its last four characters, so you can tell
it from your others. An account has at most 100 tokens.

### Listing and revoking

With a session, `GET /api/tokens` lists your tokens, each with its name,
access, workspace, expiry, and when it was made and last used, but never
the token itself. `DELETE /api/tokens/<id>` revokes one at once.

Signing out, or changing your password, leaves your tokens as they are.
Revoke the ones you no longer use.

## Calling the API

Send the token in each request's `Authorization` header:

```sh
curl https://nether.example.org/api/v1/workspaces \
  -H "authorization: Bearer $NETHER_TOKEN"
```

- **JSON.** Answers are JSON, and so are errors:
  `{ "statusCode": 404, "error": "Not Found", "message": "…" }`, whose
  `message` says what went wrong.
- **IDs.** Workspaces and notes are named by IDs, lowercase UUIDs. A note
  keeps its ID when it is moved or renamed, so store IDs, not paths.
- **Pages.** Lists give 100 at a time, or up to 1,000 with `limit`. When
  there are more, `next` is set: send it back as `after` for the next
  page. When it is `null`, that was the last.
- **Limits.** Each account may make 300 requests a minute, its tokens and
  sessions together, 120 of them searches and 120 writes. Past that, the
  answer is 429, with `Retry-After` in seconds.
- **Not there.** A workspace your token does not reach, or a note you
  cannot open, answers 404, as one that does not exist. So does a note in
  the trash.
- **Encrypted workspaces.** They are listed, but the server cannot read
  their notes, so every request for them answers 409. Read them in the app.
- **Browsers.** The API sends no CORS headers: call it from a script or a
  server, not from a page on another site.

## Endpoints

### `GET /api/v1/me`

The account, and the token the request came with:

```json
{
  "user": { "id": "5f0c8a1e-…", "name": "Ada", "email": "ada@example.org" },
  "token": {
    "id": "a41b3f0d-…",
    "name": "Backups",
    "access": "read",
    "hint": "x9Qk",
    "workspace": null,
    "expiresAt": "2027-02-15T10:00:00.000Z",
    "createdAt": "2026-11-17T10:00:00.000Z",
    "usedAt": "2026-11-17T10:05:00.000Z"
  }
}
```

### `GET /api/v1/workspaces`

The workspaces the token reaches, with your role in each, and whether it
is end-to-end encrypted:

```json
{
  "workspaces": [{ "id": "8d0f5c3e-…", "name": "Team", "role": "member", "encryption": "none" }]
}
```

### `GET /api/v1/workspaces/{workspace}/notes`

The notes you can open, by path, with their titles, tags, and when the
server last stored them. `folder` lists only the notes under one folder,
as `?folder=Projects`.

```json
{
  "notes": [
    {
      "id": "3b9a7e21-…",
      "path": "Projects/Launch.md",
      "title": "Launch",
      "tags": ["plan", "release"],
      "updatedAt": "2026-11-17T09:58:12.000Z"
    }
  ],
  "next": null
}
```

### `GET /api/v1/workspaces/{workspace}/notes/{note}`

A note, with its properties and its text as Markdown with YAML
frontmatter, as a vault on disk has it:

```json
{
  "id": "3b9a7e21-…",
  "workspace": "8d0f5c3e-…",
  "path": "Projects/Launch.md",
  "title": "Launch",
  "tags": ["plan", "release"],
  "properties": { "status": "Doing", "tags": ["plan"] },
  "markdown": "---\nstatus: Doing\ntags:\n  - plan\n---\n# Launch\n\nShip it #release\n",
  "updatedAt": "2026-11-17T09:58:12.000Z"
}
```

With `Accept: text/markdown`, the answer is the Markdown alone, to save
as a file:

```sh
curl https://nether.example.org/api/v1/workspaces/$WORKSPACE/notes/$NOTE \
  -H "authorization: Bearer $NETHER_TOKEN" -H 'accept: text/markdown' > Launch.md
```

A note someone has open in the app is read with their latest edits. The
Markdown is what Nether writes for the note; a file someone edited by hand
elsewhere may differ in style, as its list markers, but not in its text,
links or frontmatter.

The answer's `ETag` header names the note as it was read. Send it back in
`If-Match` when you change the note, to change it only if no one else has
since.

### `GET /api/v1/workspaces/{workspace}/databases`

The [databases](../databases/): notes with a schema, each with the schema
as its frontmatter has it.

```json
{
  "databases": [
    {
      "id": "c2d4e6f8-…",
      "path": "Projects.md",
      "title": "Projects",
      "schema": {
        "properties": [{ "key": "status", "type": "select" }],
        "views": [{ "name": "All", "layout": "table" }]
      },
      "updatedAt": "2026-11-17T09:00:00.000Z"
    }
  ],
  "next": null
}
```

`GET /api/v1/workspaces/{workspace}/databases/{note}` gives one of them.

### `GET /api/v1/workspaces/{workspace}/databases/{note}/rows`

A database's rows: the notes in the folder beside it, not those in
folders below, each with its properties. The views' filters and sorts are
not applied; the schema has them, to apply as you like.

```json
{
  "rows": [
    {
      "id": "3b9a7e21-…",
      "path": "Projects/Launch.md",
      "title": "Launch",
      "properties": { "status": "Doing" },
      "updatedAt": "2026-11-17T09:58:12.000Z"
    }
  ],
  "next": null
}
```

### `GET /api/v1/search?q=`

[Search](../search/), as the server searches for the app: words, the
last one as a prefix, `"phrases"`, `-words`, and `tag:`, `path:` and `prop:`
filters. `workspace` searches one workspace; `limit` gives up to 50
results.

```json
{
  "results": [
    {
      "workspace": "8d0f5c3e-…",
      "workspaceName": "Team",
      "note": "3b9a7e21-…",
      "title": "Launch",
      "path": "Projects/Launch.md",
      "snippet": "Ship it #release",
      "matches": [[0, 4]]
    }
  ],
  "encrypted": []
}
```

`matches` are where the words matched in `snippet`, as start and end
offsets. `encrypted` names the workspaces the server could not search.

## Writing

Writing takes a **write** token, and edit access where the note is: in a
teamspace you edit, a page shared with you to edit, your private space, or
the workspace's General space as a member. Each change reaches the app as
it is made: someone with the note open sees it change, and every device
syncs it. The note's history keeps what it was, as for any edit.

### `POST /api/v1/workspaces/{workspace}/notes`

Makes a note at a path, from its Markdown:

```sh
curl https://nether.example.org/api/v1/workspaces/$WORKSPACE/notes \
  -H "authorization: Bearer $NETHER_TOKEN" -H 'content-type: application/json' \
  -d '{"path":"Inbox/Call Ada.md","markdown":"---\nstatus: Todo\n---\nAbout the launch.\n"}'
```

The answer, 201, is the note as reading gives it, with its new ID; its
`Location` header is its address.

- **Paths** are folders and a name ending in `.md`. A name cannot hold
  `/ \ : * ? " < > |`, start with a dot, or end with a dot or a space, so
  every device can make the file.
- **Where it goes** follows its path, as in the app: a teamspace's folder
  puts it in that teamspace, `Private/` in your private space, and the
  folder beside a shared page in that page. A path where you cannot write
  answers 403. `Private/` answers 409 until the app has made your private
  space, the first time you open it there.
- **A path the workspace has already**, in any case, answers 409.
- **Frontmatter** that does not read as YAML answers 400.

### `PUT /api/v1/workspaces/{workspace}/notes/{note}`

Replaces a note's Markdown, its frontmatter and its text. Send it as
JSON, `{ "markdown": "…" }`, or as the file itself:

```sh
curl -X PUT https://nether.example.org/api/v1/workspaces/$WORKSPACE/notes/$NOTE \
  -H "authorization: Bearer $NETHER_TOKEN" -H 'content-type: text/markdown' \
  -H "if-match: $ETAG" --data-binary @Launch.md
```

The note changes only where the Markdown differs: blocks that stay keep
their place, so links to them and comments on them stay too. The answer
is the note, with its new `ETag`.

With `If-Match`, a note that changed since you read it answers 412: read
it again, and make your change on what it is now. Without it, what you
send wins over what others typed since. A note is at most 5 MB of
Markdown.

### `DELETE /api/v1/workspaces/{workspace}/notes/{note}`

Deletes a note: every device sends it to its trash, where it can be
restored, as when it is deleted in the app. The answer is 204. `If-Match`
works as for `PUT`.

### `POST /api/v1/workspaces/{workspace}/databases/{note}/rows`

Adds a row to a database: a note in the folder beside it, named by its
title.

```json
{
  "title": "Site",
  "properties": { "status": "Doing", "due": "2026-12-01" },
  "markdown": "The new website.\n"
}
```

`properties` are set over any frontmatter `markdown` has. The answer, 201,
is the row's note, as for `POST .../notes`. A title is a file's name,
under the same rules as a path's, and one the database has already
answers 409.

Moving and renaming notes through the API comes later.

## Webhooks

A webhook tells another service when a note is made, changed or deleted,
so it need not ask the API every minute. A workspace's owners and admins
manage its webhooks; an end-to-end encrypted workspace has none, since
the server cannot tell its notes apart.

### Making one

**In the app**, in a vault that syncs with the workspace, choose
**Workspace webhooks** in the **Sync** menu. Type the address, choose
what to tell of, and **Add the webhook**: its secret shows once, with
**Copy** beside it, and an address the server will not reach says why.
Each webhook in the list shows whether it is on and why it fails, and
has **Edit**, **Turn off** or **Turn on**, **New secret**, **Send a
test**, **Recent events** and **Remove**.

**Through the API**:

```sh
curl https://nether.example.org/api/v1/workspaces/$WORKSPACE/webhooks \
  -H "authorization: Bearer $NETHER_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://hooks.example.org/nether","events":["note.created","note.deleted"]}'
```

`events` are any of `note.created`, `note.updated` and `note.deleted`; all
three without it. The answer, 201, has the webhook's `secret`, which
starts with `whsec_`. It is shown this once: keep it with the service
that receives the events, which checks each one with it. A workspace has
at most 20 webhooks.

| Route | Does |
| --- | --- |
| `GET .../webhooks` | Lists the workspace's webhooks, without their secrets |
| `POST .../webhooks` | Makes one, from `url` and `events` |
| `GET .../webhooks/{webhook}` | Gives one |
| `PATCH .../webhooks/{webhook}` | Changes its `url`, `events`, or `enabled` |
| `DELETE .../webhooks/{webhook}` | Removes it |
| `POST .../webhooks/{webhook}/secret` | Gives it a new secret, which replaces the old one at once |
| `POST .../webhooks/{webhook}/test` | Sends it a `webhook.test` event |
| `GET .../webhooks/{webhook}/deliveries` | Its last 50 events: each one's type, whether it was sent, how many tries, and the last answer or error |

Each route is under `/api/v1/workspaces/{workspace}`. A read token lists
webhooks and their deliveries; changing them takes a write token.

### Events

Each event is a `POST` of JSON to the webhook's address:

```json
{
  "type": "note.updated",
  "timestamp": "2026-11-17T10:00:00.000Z",
  "data": {
    "workspace": "8d0f5c3e-…",
    "note": "3b9a7e21-…",
    "path": "Projects/Launch.md",
    "title": "Launch"
  }
}
```

- **`note.created`** when a note is made, or restored from the trash.
- **`note.updated`** when its text or properties change, or it is moved
  or renamed.
- **`note.deleted`** when it is deleted; its `path` is where it was.

An event says which note and where, never what it says: read the note
through the API, with your own token, for that. Rows of a database are
notes, and their events are a note's. Comments send none.

**A burst of changes is one event.** An event waits until 30 seconds
after a note's last change, and at most five minutes after its first:
someone typing for an hour sends one every five minutes. A note made and
deleted within that time sends nothing.

**Each webhook acts as the one who made it.** It tells only of notes they
can open when the event is sent: a page restricted from them, or a
teamspace they are not in, sends nothing. When they leave the workspace,
their webhooks go too.

### Checking an event

Events follow the [Standard Webhooks](https://www.standardwebhooks.com/)
spec, whose libraries check them in many languages. Each comes with three
headers:

- `webhook-id`, the event's ID, the same each time it is tried, to drop
  one already seen;
- `webhook-timestamp`, when it was sent, in seconds, to refuse an old one
  sent again;
- `webhook-signature`, `v1,` and the base64 HMAC-SHA256 of
  `{webhook-id}.{webhook-timestamp}.{body}`, keyed by the bytes the
  base64 after `whsec_` in the secret gives.

In Node.js, without a library:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isFromNether(secret, headers, body) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return headers["webhook-signature"]
    .split(" ")
    .some((signature) => {
      const given = Buffer.from(signature.replace(/^v1,/, ""), "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

Check the body exactly as it arrived, before parsing it.

### Delivery

- **Answer with a 2xx status within 10 seconds.** Anything else, a
  redirect too, is a failure.
- **Failures are tried again** after a minute, 5 minutes, 30 minutes, 2
  hours, 6 hours, 12 hours and a day, a little early or late, then
  dropped.
- **One event at a time** goes to a webhook, the oldest due first, so
  events mostly arrive in order. Do not rely on it: read `timestamp`.
- **A webhook failing for three days**, with no success between, is
  turned off, and the one who made it is emailed if the server sends
  email. `PATCH` it with `"enabled": true` once its address answers; it
  starts afresh.

### Addresses

A webhook's address is `https://`, on the internet. The server refuses
addresses that are not public, such as `localhost`, `10.0.0.5` or a
cloud's `169.254.169.254`, when the webhook is saved and again each time
it sends, so a name cannot be pointed somewhere private later. To reach a
service on your own network, as a home server's n8n, the server's admin
allows its addresses with `NETHER_WEBHOOK_PRIVATE`; those may then use
`http://`.

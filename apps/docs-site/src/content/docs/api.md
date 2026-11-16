---
title: REST API
description: Read a workspace's notes as Markdown, its databases and their rows, and search it, from scripts and other services, with a personal access token.
---

A Nether server has a REST API for scripts and other services. With a
personal access token, it reads the notes of the workspaces you belong to
as Markdown, their databases and rows, and searches them. Writing notes,
webhooks, and making tokens in the app come next.

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

Making a token takes a session and your password. Sign in first:

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
  sessions together, and 120 searches. Past that, the answer is 429, with
  `Retry-After` in seconds.
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

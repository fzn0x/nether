# 0060. Webhooks tell of notes made, changed and removed, signed, and sent to public addresses

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#extensibility) ask for "webhooks on
create/update/delete" beside the public API. The API
([ADR 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md))
answers when asked. A webhook tells another service when a note changes,
so it need not ask every minute.

Several forces shape it:

- **Notes change by keystrokes.** Hocuspocus stores an open note two
  seconds after its last edit, and every ten while someone types
  ([ADR 0035](0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md)).
  An event for each store would be dozens a minute for one person writing.
- **Where changes are seen.** A note is made, moved and removed in its
  unit's vault document; its text and properties change in its own
  document. Both are stored by `storeDocument`, which already keeps the
  search index in the same transaction, comparing a vault document's paths
  with those it replaces
  ([ADR 0050](0050-the-server-searches-what-it-can-read-indexed-as-notes-are-stored.md)).
- **Permissions.** Units hide pages from some members
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)).
  An event must not tell anyone of a page they could not open.
- **Requests the server is told to make.** A webhook makes the server send
  a request wherever someone says, from inside its network: to its
  database, to Valkey, to a cloud's metadata at `169.254.169.254`, to the
  admin's other services. This is server-side request forgery.
- **Several nodes.** An event must be sent once, whichever node stored the
  change.
- **Encrypted workspaces.** The server sees which documents change there,
  but not which note is at which path, or what it says
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).

## Decision

### Who

**A workspace's owners and admins manage its webhooks**, through the API
(`/api/v1/workspaces/:workspace/webhooks`) with a session or a write
token, and in the app's Webhooks dialog. At most 20 a workspace.

**A webhook acts as the one who made it.** It tells only of notes its
maker may open when the event is sent, so it never tells more than its
maker could read through the API. A maker who leaves the workspace takes
their webhooks with them. Another owner or admin may change or remove any
of the workspace's webhooks.

**Encrypted workspaces have no webhooks.** The server cannot name their
notes.

### Events

| Event | When |
| --- | --- |
| `note.created` | a note is listed in the vault document of the unit the server's record puts it in, having had no path; a note restored from the trash is listed again, and so made again |
| `note.updated` | its text or properties are stored, or its path changes, as when it is moved or renamed |
| `note.deleted` | it leaves its unit's vault document without going to another, so devices send it to the trash |

- A note moving from one unit to another is updated, not deleted and
  made.
- A database's rows are notes, and their events are a note's.
- Comments send nothing.
- A webhook may listen to some of the three; all by default.

**An event says what changed and where, not what it says.** Its body
follows the [Standard Webhooks](https://www.standardwebhooks.com/) spec:

```json
{
  "type": "note.updated",
  "timestamp": "2026-11-17T10:00:00.000Z",
  "data": {
    "workspace": "8d0f5c3e-2b7a-4c1e-9f6d-0a1b2c3d4e5f",
    "note": "3b9a7e21-6c4d-4f0a-8b2e-5d6c7e8f9a0b",
    "path": "Projects/Launch.md",
    "title": "Launch"
  }
}
```

A service reads the note through the API, with its own token and its own
permissions. A deleted note's event carries its last path.

### Found as documents are stored

`storeDocument` already compares a vault document's paths with those it
replaces, and reads each stored note. When the workspace has a webhook
that is on, it also writes the note's change to an outbox,
`webhook_changes`, in the same transaction. A change is never told for a
store that rolled back, nor lost by a crash after one. A workspace with
no webhook pays one indexed query per store.

### A burst as one event

- A note's change waits until 30 seconds after its last store, and at
  most five minutes after its first. Someone typing for an hour sends an
  update every five minutes; someone fixing a typo sends one.
- Changes to one note fold into one: made then changed is made; changed
  then removed is removed; made then removed is nothing; removed then made,
  as a note restored, is changed.
- When it is due, the change becomes an event for each webhook that
  listens to it and whose maker opens the note's unit then. The path and
  title are read then too. The event's `timestamp` is its last store.

### Delivery

- **A signed POST.** Each event is a `POST` of its JSON to the webhook's
  `https://` address, with Standard Webhooks' headers:
  - `webhook-id`, the event's ID, the same on every retry, so a receiver
    can drop one it has seen;
  - `webhook-timestamp`, in seconds, for the receiver to refuse old ones
    sent again;
  - `webhook-signature`: `v1,` and the base64 HMAC-SHA256 of
    `<id>.<timestamp>.<body>` under the webhook's secret.

  Libraries in many languages check these headers.
- **The secret** is `whsec_` and 32 random bytes in base64. It is shown
  when the webhook is made, and again only as a new one replacing it. The
  server keeps it as it is, since it signs with it; a backup holds it, as
  it holds the rest of the database.
- **A 2xx answer within 10 seconds** is delivered. Redirects are not
  followed, and the answer's body is not read.
- **Retries back off**: after a minute, 5 minutes, 30 minutes, 2 hours, 6
  hours, 12 hours and 24 hours, each a little early or late at random, so
  failed events do not return together. After the eighth try, about two
  days, the event is dropped.
- **One request at a time to a webhook**, in the order events fell due.
  Events of different webhooks go in parallel. A receiver should still not
  rely on order, and read each event's `timestamp`.
- **A webhook failing for three days**, with no success between, is turned
  off, and its waiting events dropped. The app shows it off, with its last
  error, and its maker is emailed when the server sends email. Turning it
  on again starts afresh.
- **Each delivery is kept for seven days**, with its answer's status or
  error, for the app to show the last ones. A test event, `webhook.test`,
  can be sent from the app.
- **One node sends each.** Every node's worker claims due changes and
  deliveries with `FOR UPDATE SKIP LOCKED`.

### Public addresses only, unless the admin says

- **The address is `https://`**, without a user or password in it.
- **Checked when sent, not only when saved.** The server resolves the
  host each time it sends, and refuses every address that is not public:
  loopback, private (RFC 1918 and unique local), link-local (cloud
  metadata among them), shared (carrier-grade NAT), multicast, unspecified
  and reserved ranges, and IPv6 addresses that carry any of those.
- **It connects to the address it checked**, so a name cannot resolve to
  a public address when checked and to a private one when used.
- **`NETHER_WEBHOOK_PRIVATE`** lets an admin whose services are on their
  own network reach them: `on` allows every address, or a list of
  addresses and ranges allows those alone, as `NETHER_TRUST_PROXY` reads
  them. An allowed private address may use `http://`, as services inside
  a network often have no certificate. `off` is the default.

## Alternatives

- **An event for each store.** Dozens a minute while someone types.
- **The note's Markdown in the event.** Larger, and a note's text sent
  where it may be kept. A service that reads the note with its own token
  reads it by its own permissions, as they are then.
- **Webhooks per account, as tokens are.** Any member could send a
  workspace's changes elsewhere, unseen by its admins. Webhooks under a
  workspace's admins are what GitHub and Notion do.
- **A queue service, as Redis streams.** Another part to run. PostgreSQL
  holds the queue in the transaction that stores the change.
- **Finding changes later, from the documents changed since a number.**
  It would compare vault documents again, which storing them already does,
  and a crash between the two would lose the change.
- **Checking the address only when the webhook is saved.** The name may
  resolve elsewhere by the time an event is sent.
- **A filtering proxy only, as the spec suggests.** The server checks
  addresses itself, so a single server needs no proxy. An admin can still
  send through one.

## Consequences

- Storing a document of a workspace with webhooks writes one more row, in
  the same transaction.
- An event comes at least 30 seconds after its change. Webhooks are for
  integrations; live views come from sync.
- Webhooks come in the third part of ADR 0059's work, and their dialog in
  the fourth.
- Revisit fuller events if services ask for them, and events for
  comments and databases' schemas.

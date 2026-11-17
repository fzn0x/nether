# 0081. Audit events come from a hook the server emits, kept in a chained, append-only log, and sent to a SIEM

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for audit logs: "Every sign-in, permission change, share, export and
deletion logged; searchable; export to SIEM via syslog or webhook". It is an
enterprise feature: free, in every image, and off until an instance admin
turns it on
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).

What any design must live with:

- **Core never depends on `enterprise/`.** A module is `{ feature, plugin }`,
  a Fastify plugin given `{ db, isOn, whenOn }`; the image's entry,
  `enterprise/server`, passes the modules to the server. The routes that
  sign people in, change permissions, share, export and delete are the
  server's own. The audit module cannot reach into them, so the server must
  tell it.
- **Where things happen.** Signing in is the server's: a password
  (`/api/sessions`), a code by email, OpenID Connect, an invitation
  accepted, and the first account at setup. Permissions are workspace
  roles, a unit's grants, teamspaces, shared pages and guests
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)).
  Shares are share links
  ([ADR 0071](0071-a-share-link-opens-one-shared-page-to-anyone-with-it-through-the-web-app.md)),
  published sites
  ([ADR 0076](0076-a-published-site-is-a-note-or-a-folder-drawn-by-the-server-as-it-is-now-linking-only-to-its-own-pages.md))
  and invitations. A note is removed in its unit's vault document, which
  `storeDocument` already compares with the one it replaces, as webhooks'
  outbox does
  ([ADR 0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md)),
  or through the public API.
- **Exports mostly happen on the device.** The desktop and web apps make
  Markdown, HTML, PDF and CSV from the vault they hold; the server never
  sees them. What the server serves that amounts to an export is the
  public API's reads of notes and rows by a token, and its own backups.
- **What the server cannot read.** In an end-to-end encrypted workspace it
  sees which documents change, not which note is at which path, nor its
  title ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).
- **Several nodes** write the same database, and any may sign someone in.
- **No route deletes a workspace or an account yet.** The admin console's
  workspace management and data policies come later.
- **Syslog over TLS has no acknowledgements.** RFC 5425 says a sender
  "cannot always know what messages were successfully delivered" when a
  connection breaks (section 6.3).

## Decision

### The hook

**The server emits events; the audit module listens.** Core gains
`apps/server/src/events.ts`: a `ServerEvents` that routes `emit` to, and
that a module joins with `listen`. `EnterpriseContext` gains
`events: { listen }`. The events and their names are core's, a closed list
typed in `events.ts`, so a route cannot name one that does not exist, and
the audit module never imports a route.

- **An event is emitted inside the transaction of the change it tells of**,
  as its last statement, and the listener writes with that transaction. A
  change is never recorded without happening, nor kept without its record.
  A route that changes several rows does so in one transaction.
- **A listener that fails fails the request**, and its transaction rolls
  back: with the audit feature on, nothing changes unrecorded.
- **An attempt that changes nothing**, as a wrong password, emits with no
  transaction of its own. If that record fails, the request answers as it
  would have, and the server's log says the record is missing.
- **With no listener, or the feature off, `emit` does nothing.** A server
  without the audit module pays one empty call per event.
- **Requests the rate limiter refuses are not events.** The limiter stops
  them before the route runs, so one address can add only as many failures
  as its window allows.

### What is recorded

Every event says who, what, where, when and from which address:

| Field               | What it holds                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`               | Its place in the log, from 1, with no gaps                                                                                                                                                                                                          |
| `id`                | A random UUID, the same wherever the event is sent                                                                                                                                                                                                  |
| `at`                | When it happened, by the server's clock, to the millisecond, in UTC                                                                                                                                                                                 |
| `action`            | What happened, as `member.role_changed`                                                                                                                                                                                                             |
| `outcome`           | `success`, or `failure` for an attempt refused, with a short `reason`                                                                                                                                                                               |
| actor               | Who: an account (ID, name and email as they were), the API token it acted through (ID and name), a share link's visitor (the link's ID and the name they gave), someone not signed in (the email typed, for a failed sign-in), or the server itself |
| `workspace`         | Where: the workspace's ID and name, when it is in one                                                                                                                                                                                               |
| target              | What it acted on: its type, ID and name, as a member, a unit, a link, a site, a token or a note                                                                                                                                                     |
| `address`           | The request's address, as `request.ip` gives it through `NETHER_TRUST_PROXY`; for sync, the address its connection came from                                                                                                                        |
| `user_agent`        | Its first 200 characters                                                                                                                                                                                                                            |
| `details`           | What else tells the change: a role from and to, a level, a format. IDs, names and levels only, at most 4 KB                                                                                                                                         |
| `prev_hash`, `hash` | The chain, below                                                                                                                                                                                                                                    |

Names are kept as they were, so the log still reads after an account or a
workspace is renamed.

### The events

**Sign-ins and their failures**

| Action                     | When                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.signed_in` | A session starts, by the method in `details.method`; a failure says why, as no such account, a wrong password, or single sign-on required |
| `session.signed_out`       | A session ends from its own client                                                                                                                        |
| `session.revoked`          | An account ends its other sessions                                                                                                                        |
| `account.created`          | At setup, or by an invitation accepted                                                                                                                    |
| `account.password_changed` | An account changes its password                                                                                                                           |
| `share_link.opened`        | A visitor opens a share link; a failure for a wrong password or a link expired or revoked                                                                 |

- **A session's method is one core type**, `SessionMethod`, exported by
  the server: `password`, `code`, `oidc`, `invitation`, `setup`, and the
  single sign-on module's provider method
  ([ADR 0080](0080-single-sign-on-binds-saml-and-oidc-providers-to-email-domains-and-enforcement-refuses-other-ways-in.md)). `details.method` is the same value
  the session's own `method` column keeps, so the log and the session
  never name it differently. Whichever of the two items lands first
  defines it; the other uses it.
- **A refusal from a guard is a failure too.** Single sign-on's
  enforcement refuses a sign-in through a guard core's session start
  calls; core emits that refusal as a `session.signed_in` failure, with
  the guard's reason, as it does a wrong password.

**Permission changes**, as roles, grants and guests

| Action                                                        | When                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `member.joined`                                               | An invitation is accepted, with the role it gave                            |
| `member.role_changed`                                         | A member's role changes, from and to, guests included                       |
| `member.removed`, `member.left`                               | A member is removed, or leaves                                              |
| `member.key_granted`                                          | An encrypted workspace's key is sealed to a member, which lets them read it |
| `grant.set`, `grant.removed`                                  | A unit's grant to an account is set, from a level to another, or removed    |
| `teamspace.created`, `teamspace.changed`, `teamspace.deleted` | A teamspace is made, renamed or given another folder, or removed            |
| `page.shared`, `page.changed`, `page.unshared`                | A page is shared on its own, as a unit, or stops being one                  |
| `private_space.created`                                       | An account's private space is made                                          |
| `note.unit_changed`                                           | A note is moved into another unit, which changes who may open it            |
| `workspace.created`, `workspace.changed`                      | A workspace is made, or its name or its AI switch changes                   |
| `token.created`                                               | An API token is made, read or write, for one workspace or all               |
| `instance.feature_changed`                                    | An instance admin turns an enterprise feature on or off                     |

**Shares**, as share links, published sites and invitations

| Action                                                                            | When                                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `share_link.created`, `share_link.revoked`                                        | A page's share link is made, with its level and expiry, or revoked                  |
| `site.published`, `site.changed`, `site.unpublished`                              | A note or a folder is published as a site, its settings change, or it is taken down |
| `site.domain_set`, `site.domain_removed`                                          | A site's custom domain is set or removed                                            |
| `workspace.publishing_changed`                                                    | A workspace allows publishing, or stops                                             |
| `invitation.created`, `invitation.revoked`, `invitation.accepted`                 | An invitation is made, with its role, revoked, or accepted                          |
| `webhook.created`, `webhook.changed`, `webhook.deleted`, `webhook.secret_changed` | A workspace's webhook, which sends its changes elsewhere                            |

**Exports**

| Action | When |
| --- | --- |
| `note.read_by_api` | A request to the public API gives a note's Markdown |
| `database.read_by_api` | A request gives a database's schema or a page of its rows |
| `search.read_by_api` | A request gives search results, with their passages of text |
| `export.made` | The desktop or web app exports from a vault linked to a workspace: a note, a folder, the vault or a view, as Markdown, HTML, PDF or CSV, with how many notes; `details.reported` says the app told of it |
| `backup.made` | The server makes a backup, which holds every workspace |

- **One event per API request**, by a token or a session, for each that
  gives notes' text or rows: never one per note. It names what the request
  gave, up to 50 note IDs, and a count of the rest. A page of rows, 100 by
  default and up to 1,000, is one event. A search's words are never recorded, only the notes
  it gave.
- A request that lists notes by their names and paths alone gives no text,
  and is not an export.

**Deletions**

| Action                                 | When                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note.deleted`                         | A note leaves its unit's vault document without going to another, as webhooks' `note.deleted` has it, or is deleted through the API; `details.via` is `sync` or `api` |
| `workspace.deleted`, `account.deleted` | Named now, for the routes that will delete them                                                                                                                       |
| `token.revoked`                        | An API token is revoked                                                                                                                                               |

The removals above, of members, teamspaces, pages, links, sites,
invitations and webhooks, are deletions too, under their own names.

- **A note removed through sync** is told by the account whose device
  removed it: the one that changed the vault document since its last
  store, or, when several did, each of them, in `details.changedBy`.
  Hocuspocus's `onChange` says who changed a document; `onStoreDocument`
  only knows the last.
- **In an encrypted workspace**, the server names notes by their IDs only,
  and cannot see a note removed through sync. Its other events, sign-ins,
  members, grants, links and tokens, are recorded as in any workspace.

**The log's own settings are recorded**, as any permission change is:

| Action | When |
| --- | --- |
| `audit.destination_added`, `audit.destination_changed`, `audit.destination_removed` | An instance admin adds, changes or removes a SIEM destination; its kind and address, never its secret |
| `audit.retention_changed` | The days the log keeps its events change, from and to |
| `audit.checked` | Check the log runs, with its result: the rows checked, and the first that does not hold, if one does not |

Searching the log is not recorded. The log's own workings are, by the
server itself: `audit.purged`, `audit.checkpoint`, `audit.key_changed` and
`audit.export_gap`, below. Turning the audit feature
off is recorded, as the last event before it stops. Every action's name
fits syslog's `MSGID`, 32 characters at most.

### Storage

**A table in PostgreSQL, `audit_events`, made by the server's own
migrations**, as `instance_settings` and single sign-on's tables are. A backup holds it and a restore
brings it back
([ADR 0052](0052-backups-are-the-server-s-own-files-restored-at-their-schema-then-migrated.md)),
which tables a module made for itself would not. Only the audit module
writes and reads it; core's code never does. Indexes serve search: by
`seq`, by actor, by workspace, by action, and by time.

**Append-only from the app's side.** The module only inserts. A trigger on
the table refuses every `UPDATE` and `TRUNCATE`, and every `DELETE` but the
retention purge's: the purge sets `nether.audit_purge_through` for its
transaction, and the trigger lets it delete rows up to that `seq` alone. A
bug, or a query someone slips into a route, cannot change or remove what
is there.

**A tampered log shows.** Each row's `hash` is the HMAC-SHA256 of the row
before's `hash` and the row's own fields, in a fixed order, under a key
derived from `NETHER_SECRET_KEY` (HKDF, its own `info`). A changed,
removed or inserted row breaks the chain from there.

- **The key is never in the database**, so someone with the database alone
  cannot write a chain that checks. Without `NETHER_SECRET_KEY`, the chain
  is plain SHA-256: it still shows a row changed by mistake, and the
  console says it is not keyed.
- **One writer at a time.** The module takes a transaction-level advisory
  lock, reads the last row's `seq` and `hash`, and inserts the next. As
  events are emitted last in their transactions, the lock is held for the
  commit alone, whichever node writes.
- **Checking** walks the chain from the oldest row kept: each `seq` one
  more than the last, each `prev_hash` the last row's `hash`, each `hash`
  as computed again. The console's **Check the log** runs it and names
  the first row that does not hold. The check is itself an event,
  `audit.checked`, with that result.
- **Cutting off the newest rows** leaves a chain that checks. So every
  hour the module appends `audit.checkpoint`, with the `seq` and `hash`
  it reached, and writes the same line to the server's log. A SIEM that
  holds the events, or the server's logs, shows the rows that went.
- **A new `NETHER_SECRET_KEY`** starts a new segment: the module notes the
  key's fingerprint, and when it differs at startup appends
  `audit.key_changed`. Rows before it check only under the old key.

### Retention

**The log keeps its events 365 days**, which an instance admin changes in
the console from 30 days to ten years, unless `NETHER_AUDIT_RETENTION_DAYS`
pins it. It is the log's own setting, apart from data policies, a later
item, which may hold it longer for a legal hold.

- One node purges every hour, under its own lock, and appends
  `audit.purged` with how many rows went and the `hash` of the last one.
  The oldest row kept then checks against it, so the chain still runs
  from its first row.
- **A purge does not wait for a SIEM.** Events a destination never got are
  purged with the rest, and `audit.export_gap` records which.

### Search

**The console's Audit log page**, at `/admin`, for instance admins: the
newest events first, 50 a page, with **Older** for the next.

- **Filters**: an actor, chosen from the accounts by name or email, or a
  typed email, which finds failed sign-ins too; an action, or a group of
  them, as every sign-in or every share; a workspace; an outcome; and a
  time, from and to.
- **Paged by `seq`**: `GET /api/audit/events` takes the filters and
  `before`, and answers with the events and the `seq` to ask before next.
  A page reads the same however many events come in meanwhile.
- **An event opens** to all it holds: the actor, the target, the address,
  the user agent and its details.
- **Only instance admins read it**, as it spans every workspace. Searching
  is not an event.

### Export to a SIEM

**Destinations are the console's.** An instance admin adds up to five, each
syslog or a webhook. `NETHER_AUDIT_SYSLOG` and `NETHER_AUDIT_WEBHOOK` pin one
of each, shown in the console with no control, as a feature's switch is.

**Syslog** follows RFC 5424, over TLS as RFC 5425 has it:

- TLS 1.2 or later, to port 6514 unless another is given. The server's
  certificate is checked against the system's authorities, or one the
  admin gives, or a pinned SHA-256 fingerprint. A client certificate for
  mutual TLS comes from files `NETHER_AUDIT_SYSLOG_CERT` and
  `NETHER_AUDIT_SYSLOG_KEY` name, so its key is never in the database. No
  plain TCP, and no UDP.
- Each message is framed by its length in octets, `MSG-LEN SP SYSLOG-MSG`.
- Its facility is 13, log audit; its severity 5, notice, or 4, warning,
  for a failure. `TIMESTAMP` is the event's `at`, `HOSTNAME` the host of
  `NETHER_PUBLIC_URL`, or the machine's name without one, `APP-NAME` `nether`, and `MSGID` the action, which
  is never longer than RFC 5424's 32 characters.
- Its structured data is the registered `origin` element, `software` and
  `swVersion`. Nether has no IANA private enterprise number, so it sends
  no element of its own. `MSG` is the event as JSON, after the BOM RFC
  5424 asks of UTF-8.

**A webhook** is signed as ADR 0060's webhooks are:

- A `POST` to `https://`, of up to 100 events in order, as
  `{"type": "audit.events", "timestamp": …, "data": {"events": […]}}`.
- Standard Webhooks' headers: `webhook-id`, the destination and the
  batch's first and last `seq`, the same on every retry;
  `webhook-timestamp`; and `webhook-signature`, the HMAC-SHA256 of
  `<id>.<timestamp>.<body>` under its `whsec_` secret, shown once.
- A 2xx answer within 10 seconds is delivered. Redirects are not followed.
- A SIEM is the instance admin's own, often on the server's network, so
  private addresses are allowed, unlike a workspace's webhooks. Its name
  is still checked when it is sent, and the server connects to the
  address it checked. `http://` goes to private addresses alone.

**When the SIEM is down, nothing is lost but what retention purges.**

- Each destination keeps a cursor, the last `seq` it took. The log is the
  queue, so an event waits in it as long as it is kept, not two days as a
  workspace's webhook event does.
- One node sends to each destination at a time, in `seq` order, claiming it
  with `FOR UPDATE SKIP LOCKED`, as webhooks' worker does.
- A try that fails waits 30 seconds, then a minute, 2, 5, 10, and then
  every 15 minutes, for as long as it fails, and resumes from the cursor.
  A destination is never turned off on its own.
- **Syslog is at least once.** The cursor moves when a batch is written
  and the connection still stands. After a break, the batch it was in
  goes again in full, so a SIEM may see an event twice and drops it by its
  `id`. RFC 5425 has no acknowledgements, so bytes the network took before
  the receiver died may still be lost, and the hourly checkpoints show it.
- The console shows each destination's last delivery, its events waiting,
  and its last error. The server's log says so every hour while it fails.
- A new destination starts at the newest event, or, if the admin asks,
  from the oldest kept.

### Privacy

**No contents, only IDs and names.**

- Never a note's text, a comment, a search, an AI request or answer, a
  password or a code, a token, a link's or webhook's secret.
- Names are an account's name and email, a workspace's, a unit's, a
  link's, a site's and a token's, and a note's title and path where the
  server can read them; in an encrypted workspace a note is its ID alone.
- A failed sign-in keeps the email typed, as a SIEM needs it to see one
  address tried against many accounts, and never what was typed as the
  password.
- Addresses and user agents are personal data. Retention bounds how long
  they are kept, and only instance admins see them.

### It comes in two parts

1. **Recording and search:** the hook and every event the server emits,
   the log with its chain, its check and its retention, and the console's
   Audit log page.
2. **Export:** SIEM destinations over syslog and a webhook, with their
   worker and their state in the console, and the apps telling the server
   of their exports, `export.made`.

## Alternatives

- **The audit module wrapping the server's routes**, with `onResponse`
  hooks that read each request. It would see requests, not what changed,
  and would have to know every route's shape: core's routes would depend
  on it in all but name.
- **Events written after the change, outside its transaction.** A crash
  between the two would lose the record, and a failure to record would
  leave a change unseen.
- **An event bus, as Redis streams or Valkey.** Another part to keep; the
  transaction that makes the change holds its record too.
- **A table each module makes for itself.** Backups would not restore it,
  as a restore migrates to the server's schema first.
- **A chain computed by a database trigger.** The key would have to be in
  the database, where someone with the database alone could recompute the
  chain.
- **Sealing rows in batches later**, rather than chaining each as it is
  written. Rows committed late would land behind a seal, and an event
  could be changed before its batch is sealed.
- **Every read logged**, as each note a device syncs. A log of everything
  is one nobody reads; the API's reads are logged as the server's exports,
  and the apps' own syncing is how they work.
- **An event for each note an API request gives.** A script reading a
  50,000-note vault a day through its pages would add 18 million rows a
  year; one per request names the same notes in a few hundred.
- **A destination turned off when it fails**, as a workspace's webhook is.
  A SIEM that stops hearing is a gap an attacker would want; the console
  and the server's log say it fails instead.
- **Plain TCP or UDP syslog.** Events would cross the network readable and
  unsigned, and UDP drops them unseen.
- **A private structured-data element, as `nether@32473`.** 32473 is RFC
  5424's number for examples, and Nether has no number of its own.
- **Workspace owners reading their workspace's log.** It may come later;
  first the log is the instance admins', who answer for the server.

## Consequences

- Every route that signs in, changes permissions, shares or deletes does
  its change and its event in one transaction, so some routes gain one.
- With the audit feature on, a change fails rather than go unrecorded: the
  log's table being out of space stops changes, not reads.
- The chain serializes the log's writes across nodes. They are few per
  second, a sign-in or a share. A script that reads the API a page at a
  time writes a row a page; one that asks for each note on its own writes
  a row a request.
- Exports made in the apps are recorded because the apps tell of them. A
  changed app could stay silent: the server can vouch only for what it
  serves.
- Deleting a workspace or an account, when it comes, emits the events
  named here, and data policies decide what happens to its events.
- `EnterpriseContext` grows `events`, which ADR 0079's other modules may
  listen to as well.

## What building part 1 settled

- **The hook's names.** `SessionMethod` is exported from
  `apps/server/src/events.ts`, beside the events, for the sessions' own
  `method` to use. `EnterpriseServices` holds `events` whole, not only its
  `listen`: a module that changes what a route would tells of it too, as
  the console's Workspaces page does when an instance admin sets a role,
  through the members' one `setRole`, recorded with `as: instance-admin`.
- **A module reads its switch through the event's transaction**, so a
  listener never waits on a query outside the change it records.
- **Work done only to tell of something waits on `wanted`.** A listener
  says, through its switch, whether it wants events now, and a route asks
  before work it would do only for them. Storing a vault document finds
  the notes it no longer lists only while audit logs are on, from the
  paths search already parses: each side's once, for search, webhooks and
  audit logs alike, so a server with audit logs off parses no more than
  before.
- **Names are read when the event is recorded**, in its transaction: an
  account's name and email, a workspace's name, and a target's name when
  the route gave none, for an account or a note the server can read.
- **Failures and their reasons.** A sign-in by password fails as no such
  account, a wrong password, or an account with no password; by code, as
  a wrong code or none asked for; by OpenID Connect, as the provider's
  error; at setup, as a wrong code. A share link that asks for its
  password first is not refused yet: only a wrong one is.
- **Single sign-on's providers sign in as core's OpenID Connect does.**
  Their method is `sso`, one more `SessionMethod`, with the provider's ID
  as `details.provider`
  ([ADR 0080](0080-single-sign-on-binds-saml-and-oidc-providers-to-email-domains-and-enforcement-refuses-other-ways-in.md)).
  The module tells of the accounts it makes, its sign-ins and their
  failures, by the same names and reasons, through the `events` its
  context holds.
- **A webhook's address is recorded by its origin alone**, since its path
  or query may hold a secret of the service it sends to.
- **A new key is noticed at the first event after the server starts with
  it**, which `audit.key_changed` comes before.
- **Search in the console.** The email field offers the accounts whose
  name or email matches, and finds failed sign-ins by the email typed;
  **Only theirs** beside an event shows its actor's alone, by ID.
- **Upkeep** runs an hour after the server starts, then every hour.
- **The routes**, for instance admins while the feature is on:
  `GET /api/audit/events`, `/api/audit/actors` and `/api/audit/workspaces`
  for the filters, `GET` and `PUT /api/audit/settings`, and
  `POST /api/audit/check`.

## What building part 2 settled

- **Where the log goes is a table of core's migrations**,
  `audit_destinations`, as `audit_events` is, so a backup holds each
  destination's cursor with the log. Its state is there too: failures in
  a row, the last error, the next try, and a claim that lapses after two
  minutes, so a node that stops frees its destination.
- **A webhook's secret is sealed** with `NETHER_SECRET_KEY`, as single
  sign-on's secrets are, bound to its destination's ID: a box moved to
  another row does not open. The console adds no webhook without the key.
  Syslog keeps no secret in the database: a certificate authority and a
  fingerprint are public, and the client key stays in its file.
- **The environment's destinations.** `NETHER_AUDIT_SYSLOG` is trusted by
  `NETHER_AUDIT_SYSLOG_CA`, a file holding a certificate authority in PEM,
  or `NETHER_AUDIT_SYSLOG_FINGERPRINT`, or else the system's authorities.
  `NETHER_AUDIT_WEBHOOK` signs with `NETHER_AUDIT_WEBHOOK_SECRET`, a
  `whsec_` secret the admin makes, never kept in the database. Each is a
  row named by its variable, which keeps its cursor across restarts; it
  starts from the newest event, and goes when its variable does. One set
  wrong stops the server as it starts.
- **The worker runs on every node**, every two seconds while the feature
  is on. It claims a destination due with `FOR UPDATE SKIP LOCKED`, sends
  it the next 100 events, and moves its cursor in the statement that frees
  it, until every destination has caught up. A syslog connection stays
  open between batches and closes after a minute with nothing to send.
- **A webhook's events are as the console shows them**, with `prevHash`
  and `hash` beside, so a SIEM can check the chain. Syslog's `MSG` is the
  same JSON.
- **The gap is recorded in the purge's transaction.** For each destination
  whose cursor the purge passed, `audit.export_gap` names it, with
  `fromSeq`, `throughSeq` and `count`, as a failure, reason `purged before
  it was sent`, and the cursor moves past it.
- **Console changes the list lacked**, recorded as permission changes, as
  they decide who signs in how and where notes may go:
  `instance.security_changed`, the security settings changed, each from
  and to; `instance.ai_endpoints_changed`, the approved AI endpoints, from
  and to; `sso.provider_added`, `sso.provider_changed` and
  `sso.provider_removed`, a provider's kind, domains and settings, never
  its secrets, with `secretsChanged` when they change; and
  `sso.enforcement_changed`, whether single sign-on is required, from and
  to. Data policies were already recorded.
- **The apps tell of their exports** at `POST
  /api/workspaces/:id/exports`, for a member, with `scope`, `format` and
  `notes`. The server records it only while audit logs are on, and
  answers 204 either way. The apps tell once, as the file is saved: an
  export made offline, or one the server does not answer, goes untold.
- **The console names every action**, its code beside it. The names are
  the apps' messages, and a test checks each action has one; an action an
  older app does not know shows by its code alone.
- **Upkeep keeps its own hourly timer** on each node, an hour after it
  starts, not ADR 0082's jobs, whose first run comes within a minute. The
  purge takes a lock, so one node purges and records the gaps; each node
  writes its own checkpoint.
- **The routes**, for instance admins while the feature is on: `GET` and
  `POST /api/audit/destinations`, and `PATCH` and `DELETE
  /api/audit/destinations/:id`. A pinned destination answers 409 to a
  change.

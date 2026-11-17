# 0088. Data policies set a workspace's retention, legal hold, public sharing and export, over its owners

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for "Data policies | Retention rules, legal hold, restrict public
sharing and export per workspace". They are the `policies` enterprise
feature's, as the approved AI endpoints are
([ADR 0086](0086-ai-is-locked-to-the-endpoints-an-instance-admin-approves-in-the-apps-and-the-relay.md)):
free, open source, and off until an instance admin turns them on
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).

What there is today:

- **History.** The server keeps a note's earlier states for
  `NETHER_HISTORY_DAYS`, 30 unless set, the same for every workspace, and
  purges older ones every hour
  ([ADR 0041](0041-a-notes-history-is-its-earlier-texts-kept-before-each-spell-of-editing.md)).
- **Removed notes.** A note removed from its vault document keeps its
  document on the server; nothing deletes it.
- **Trash.** Each device keeps a vault's removed files in its `.trash`
  folder for the days its `.nether/trash.json` says, 30 unless changed,
  then deletes them.
- **Public sharing.** A share link opens a page to anyone with it, to
  view, comment or edit
  ([ADR 0071](0071-a-share-link-opens-one-shared-page-to-anyone-with-it-through-the-web-app.md)).
  A published site is a note or a folder anyone reads
  ([ADR 0076](0076-a-published-site-is-a-note-or-a-folder-drawn-by-the-server-as-it-is-now-linking-only-to-its-own-pages.md)),
  and a workspace's owners and admins turn publishing off for it.
- **Export.** The apps export a note, a folder, a vault or a view, as
  Markdown, HTML, PDF or CSV, from the vault they hold. The public API
  reads notes as Markdown, databases' rows and search results by a token
  ([ADR 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md)).
- **The audit log** keeps its events 365 days unless changed, purging a
  chain's oldest rows
  ([ADR 0081](0081-audit-events-come-from-a-hook-the-server-emits-kept-in-a-chained-append-only-log-and-sent-to-a-siem.md)).
- **The desktop app's vault is Markdown files on disk**, the person's own
  by principle 1.

## Decision

**An instance admin sets a policy for every workspace, and may set one
for a workspace in its place.** The console's **Data policies** page
holds them. They apply while the `policies` feature is on; turned off,
they are kept and do nothing, as any feature off does nothing.

| Setting | What it does | Unset |
| --- | --- | --- |
| History days | How long the server keeps the workspace's notes' earlier states, 1 to 3650 | `NETHER_HISTORY_DAYS` |
| Trash days | How long its members' apps keep its vaults' trash, 1 to 3650 | each vault's own |
| Legal hold | Nothing of it is deleted for good while it is on | off |
| Share links | `on`, `view` only, or `off` | `on` |
| Published sites | `on` or `off`, over the owners' switch | `on` |
| Export | `on` or `off` | `on` |

- **Where they are kept.** A row in a new table, `workspace_policies`,
  for each workspace an admin sets apart, and the policy for every
  workspace in `instance_settings`. A workspace's policy is its row where
  it has one, else every workspace's. Both are in core's migrations, so a
  restore keeps them.
- **Who sets them.** Instance admins alone, in the console. A
  workspace's owners see the policies that hold for it, and why a control
  is gone, but cannot change them. The owners' own switches stay, and a
  policy only narrows them.

### Retention

- **History days** replace `NETHER_HISTORY_DAYS` for the workspace's
  notes, shorter or longer. The hourly purge keeps each workspace's
  versions for its own days.
- **Trash days** reach the apps in `/api/me`, with the workspace. A vault
  linked to it keeps its trash that many days, whatever its own
  `trash.json` says, and its trash panel says the server sets it.
- **Removed notes' documents** stay on the server, as today. Purging them
  after a time is not part of this: it needs the server to know when a
  note left every vault document, which a later item can record.

### Legal hold

While a workspace is on hold, nothing of it is deleted for good:

- **the server keeps every version** of its notes, whatever its history
  days;
- **its members' apps keep its vaults' trash**, deleting nothing on its
  days, and refuse **Delete forever** and **Empty trash**, saying why;
- **the audit log purges nothing** while any workspace is on hold. Its
  purge cuts the chain's oldest rows, and the held workspace's events are
  among them;
- **a later route that deletes** a workspace, or an account that is a
  member of a held one, refuses while the hold is on.

Putting a workspace on hold, and taking it off, is recorded in the audit
log. A hold changes nothing anyone sees in the workspace: people keep
writing, moving and deleting notes, and only the deleting for good waits.

### Public sharing

- **Share links `view`**: a new link may only view. An existing link that
  comments or edits opens to view only, and its visitors' open
  connections close, so they connect again at that level.
- **Share links `off`**: no new link, and every link of the workspace
  answers as a link turned off, telling its visitor the server's policy
  stops it. Its visitors' connections close. The links are kept, and open
  again when the policy allows them.
- **Published sites `off`**: no site of the workspace is served, on the
  server's address or its own domain, and publishing is refused. The
  sites are kept, and serve again when the policy allows them. It is
  checked where the owners' switch is.
- Making a link or publishing is refused with 403, naming the policy.
- **The apps are told why.** A page's list of links gives the policy's
  `shareLinks`, and a workspace's list of sites gives its `policy`, `on` or
  `off`, so the Share dialog can say why a control is gone.
- **A change closes what it stops.** The node that changes a policy closes
  the open connections of the visits of every link it holds for, as
  revoking a link does, and they connect again at the level it allows, or
  not at all. Other nodes see the change within five seconds. Turning the
  `policies` feature on or off counts as a change for every workspace.

### Export

**Export `off`**:

- **the public API** refuses, with 403, every read that gives the
  workspace's text or rows: notes as Markdown, a database's rows, and
  search results with their passages. A search across workspaces leaves
  such a workspace out. Lists of names and paths, and writes, go on, and a
  write is answered with where its note is and when it changed, not what
  it now says;
- **the apps** offer no export for its vaults: no Markdown, HTML, PDF or
  CSV, no print, and no **Copy as Markdown**. They read the policy in
  `/api/me`, with the workspace, as they read its AI switch, and keep the
  last answer for when the server cannot be reached;
- **the web app** has no other way out of the browser. **The desktop
  app's vault is files on disk**: the policy removes Nether's export, not
  the person's files. The admin guide says so, beside device management.

Syncing a workspace to its members' devices is not export, nor are the
server's own backups.

### What the apps are told

`/api/me` gives, with each workspace, the policies its apps keep:
`{ "export": true }` from part 1, with `trashDays` and `legalHold` added in
part 3 and kept to by the apps from part 4, or `null` while the feature is
off. An app reads a setting it
lacks as narrowing nothing. The server enforces everything it serves; the
apps keep the rest, as they keep the AI switch.

### The console

The **Data policies** section, beside the AI endpoints while the
feature is on, shows the policy for every workspace, then each workspace
set apart, each a form saved on its own. **Set apart** picks a workspace
from a list of the others and starts it from every workspace's policy;
**Use every workspace's** puts it back. The section is the `policies`
module's own, so it does not need the `admin` feature's Workspaces page.

### Where it lives

- **Core** keeps the table, reads a workspace's policy where the server
  acts, and gives `/api/me` the apps' part, asking the `policies` switch.
- **`enterprise/policies`** adds the console's routes and page.
- **Audit** records `policy.changed`, with the setting, the workspace and
  the values before and after, and `policy.hold_set` and
  `policy.hold_removed`.

### Parts

1. **Sharing and export on the server**: the table, the policy for every
   workspace, the console's section, share links and sites, the API's
   reads, and `/api/me`'s `export`.
2. **The apps' part of sharing and export**: no export where the policy
   keeps it, the last answer kept, and the Share dialog saying why a link
   level or publishing is gone.
3. **Retention and legal hold on the server**: history days in the
   purge, the audit log's purge held, the console's fields, `/api/me`'s
   `trashDays` and `legalHold`, and the audit events, which came after
   audit logs.
4. **The apps' trash**: a vault linked to a workspace keeps its trash for
   the policy's days, and deletes nothing for good while the workspace is
   on hold.

## Alternatives

- **Policies as the owners' settings.** An organization sets them so that
  a workspace's owners cannot undo them; the owners' switches already do
  the rest.
- **Columns on `workspaces`.** They would mix the owners' settings with
  the instance admin's, and every workspace would carry them unset.
- **Deleting old notes as a retention rule.** Nether's notes are a
  knowledge base, not a chat, and deleting a note people still link to
  breaks the vault. History and trash are what an organization usually
  bounds.
- **Holding only the held workspace's audit events.** The log is one
  chain, purged from its start; holding part of it would split the chain.
- **Stopping the desktop app from reading its own vault's files.** The
  files are the person's, by principle 1. Device management is the tool
  for keeping files on a device.

## Consequences

- An instance admin sets retention, legal hold, public sharing and export
  for every workspace, or for one, in one place, and the server enforces
  what it serves.
- People see which policy holds and why a control is gone.
- Older apps do not know the apps' part, as with the AI lock; the server's
  part holds for them too.
- An e-discovery export of a held workspace, with its removed notes and
  history, is a follow-up: today an instance admin has the server's
  backups.

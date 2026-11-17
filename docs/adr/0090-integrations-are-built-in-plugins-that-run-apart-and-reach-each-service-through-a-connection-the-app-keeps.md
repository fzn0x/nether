# 0090. Integrations are built-in plugins that run apart, and reach each service through a connection the app keeps

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#extensibility) ask, in Phase 5, for
"Integrations | GitHub, Slack, Google Drive and Calendar (CalDAV/ICS
first) as plugins; admins supply their own OAuth app credentials". The
roadmap's line is "Integrations as plugins: GitHub, Slack, and Google
Drive and Calendar through CalDAV and ICS first, with the admin's own
OAuth credentials". It is a Community feature: no module in
`enterprise/`, nothing behind a switch of ADR 0079.

What it builds on:

- **The plugin API.** A manifest declares commands, code blocks, block
  types, panels, views, layouts, property types and settings fields, and
  `activate(ctx)` attaches them. Every call crosses as a JSON message
  ([ADR 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)).
  The API is `0.1.0`, and a manifest's `^0.1` takes only `0.1.x`.
- **The sandbox.** A plugin from a vault runs in a worker inside a hidden
  `sandbox="allow-scripts"` frame, its origin `null`, with
  `connect-src 'none'` unless approved for `network`, which then allows
  any `https:` address
  ([ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md)).
  What it draws is cleaned before the page shows it, links that go
  anywhere included
  ([ADR 0063](0063-a-vault-plugins-views-draw-in-its-worker-and-the-page-shows-them-cleaned.md)).
  It reads and writes notes through the app, outside hidden folders
  ([ADR 0064](0064-a-plugin-reads-and-writes-notes-through-the-app-as-far-as-it-asked.md)).
- **Built-in plugins run in the page**, with `ctx.host`, and their HTML
  shows as it is. A built-in plugin the vault's `.nether/plugins.json`
  does not name is on.
- **The directory** installs plugins pinned by commit and hash from
  `registry/index.json`, which is empty today
  ([ADR 0065](0065-the-directory-is-an-index-in-the-repository-of-files-pinned-by-commit-and-hash.md)).
- **Link previews.** A web link alone on its line shows as a card. Its
  title, description and site are fetched through Go when the user asks,
  and kept in the vault's `.nether/previews.json`.
- **The REST API and webhooks.** Webhooks tell of notes made, changed and
  deleted, from an outbox written in the store's transaction, signed,
  retried, and sent only to public addresses unless
  `NETHER_WEBHOOK_PRIVATE` allows others
  ([ADRs 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md)
  and [0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md)).
  Encrypted workspaces have none.
- **Buttons run commands**, the app's and its plugins', asking first
  ([ADR 0072](0072-buttons-are-meta-bind-button-blocks-and-triggers-are-schema-rules-run-where-the-change-is-made.md)).
- **Secrets the apps keep.** The desktop app keeps server tokens and AI
  keys in the system's keychain through `mygo.Secrets`, and sends
  requests through Go's fetch, outside the page's CORS
  ([ADRs 0036](0036-the-desktop-app-reaches-servers-through-go-and-keeps-tokens-in-the-keychain.md)
  and [0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)).
  Go's fetch takes `redirect: "manual"`. `Servers.Listen` waits on a
  loopback address for a provider's sign-in, as RFC 8252 asks. The web
  app's AI goes through its server, which seals keys with
  `NETHER_SECRET_KEY`, checks every address through `outbound.ts`, and
  reaches the admin's network only where `NETHER_AI_PRIVATE` allows
  ([ADR 0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md)).
- **The console.** Its Features page is in every build; its other pages
  come with the features that add them
  ([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).
- **The mobile apps** run built-in plugins only, and hide AI until it has
  a part of its own
  ([ADR 0087](0087-the-mobile-apps-run-the-shared-page-in-capacitor-with-each-vaults-files-and-index-on-the-phone.md)).
- **Startup and memory.** Phase 5's first item is headroom in opening the
  app, and the desktop app idles near its 300 MB budget.

**What the services offer**, from their documentation:

| | A person's own credential | An admin's app | Notes |
| --- | --- | --- | --- |
| ICS feed | The feed's address, often secret, as Google Calendar's "secret address in iCal format" | None | Read only |
| CalDAV | A user name and an app password, by Basic authentication | None | `PROPFIND` and `REPORT`; most servers send no CORS headers |
| GitHub | A personal access token | An OAuth App or a GitHub App: client ID and secret | Web flow with PKCE (`S256`); a loopback redirect may use any port; device flow needs no secret but must be turned on in the app |
| Google Calendar | None: OAuth only, Basic answers 401 | An OAuth client | CalDAV at `https://apidata.googleusercontent.com/caldav/v2/<calendar>/user` and `/events`; `sync-collection` expected after the first sync |
| Google Drive | None: OAuth only | An OAuth client | Docs export as `text/markdown`; Sheets as CSV, first sheet only |
| Slack | The user token of a Slack app of one's own | A Slack app, OAuth v2 | Redirect addresses must be `https://`, so no loopback |

More of what shapes the design:

- **GitHub.** An OAuth App's only scope that reads private repositories
  is `repo`, which also writes to them. A GitHub App has fine-grained
  permissions, as Issues and Pull requests read only. An OAuth App's
  tokens do not expire unless it opts in; expiring ones last eight hours,
  their refresh tokens six months. The code exchange needs the client
  secret.
- **Google.** A desktop client may redirect to a loopback address on a
  random port, should use PKCE, and need not send its secret. An app left
  in **Testing** gets refresh tokens that expire in 7 days. `drive.file`
  is non-sensitive but reaches only files picked through Google's Picker,
  a script of Google's in a frame; `drive.readonly` is restricted, which
  needs verification for a public app. An app used only inside its
  Google Workspace organization, or for personal use by fewer than 100
  users, needs none. The CalDAV guide names no scope; other CalDAV clients
  ask for the full `https://www.googleapis.com/auth/calendar`.
- **Slack.** `conversations.replies` needs `channels:history`,
  `groups:history`, `im:history` and `mpim:history`, for a user token as
  for a bot's. Since 2025-05-29, an app distributed outside the Slack
  Marketplace reads at most 15 messages a request, one request a minute;
  an organization's own app in its own workspace is not limited so. An
  install with the `incoming-webhook` scope lets the installer pick a
  channel and gives that channel's webhook address. A webhook takes JSON
  whose `text` is required.

## Decision

### Integrations are built-in plugins that run apart

**Each integration is a built-in plugin written only against the public
SDK**: it imports `@nether/plugin-api` and its own libraries, never
`ctx.host` nor the app's code. A lint rule keeps it so. The plugins:

| Plugin | Services | What it adds |
| --- | --- | --- |
| `calendar` | `ics`, `caldav`, `google-calendar` | A `calendar` code block, an Events panel beside a note |
| `github` | `github` | Previews of issue and pull request links, a `github` code block |
| `google-drive` | `google-drive` | Previews of Drive links, copying a file into the vault |
| `slack` | `slack` | Previews of message links, clipping a message or a thread into a note |

**They run in the sandbox**, as a plugin from a vault does: a frame and a
worker each, with no `network`, their HTML and views cleaned. Their code
is the app's own, built into one module each and handed to the frame as
a vault plugin's `main.js` is. They are the first built-in plugins that
run apart:

- **What they read is anyone's.** A calendar invitation, an issue and a
  message are written by people the user does not choose. Parsed and
  drawn in the worker, a mistake in the plugin cannot reach the page's
  bridge, its tokens or its vaults.
- **They prove the API whole**, the sandbox included. A plugin from the
  directory can do what they do, by the same calls.

**They are off until turned on**, in the Plugins tab, under
**Integrations**, which lists what each asks for, as a vault plugin's
approval does. The app's code needs no approval by hash. A built-in
plugin gains two flags: it runs apart, and it starts off.

### What the plugin API gains

| Addition | What it does | Part |
| --- | --- | --- |
| `connection:<service>` permissions | Asks to use the person's connections to a service | 1 |
| `context.connections` | `list()`, `add(service)`, `onChange(listener)`; `allow(connection, origin)` from part 2 | 1 |
| `context.http.fetch(request)` | A request the app sends with a connection's credential | 1 |
| `context.store` | `get`, `set`, `delete` and `keys` of JSON values, kept on this device | 1 |
| A note's context | `CodeBlockContext.note`, and `day` beside a panel's `note` for a daily note | 1 |
| `linkPreviews` | A contribution: hosts whose links the plugin previews, with actions | 4 |
| `context.vault.writeFile(path, bytes)` | Writes a file that is not a note, with `vault:write` | 5 |

**Not added**, by decision:

- **No secrets for plugins.** No call gives a token, a password or a
  feed's secret address. The app adds the credential to a request and
  never hands it over.
- **No OAuth flows in plugins.** Connecting is the app's dialog. A plugin
  asks for it with `connections.add(service)`.
- **No background jobs.** Nothing runs while nothing shows. A calendar
  refreshes when a calendar block or the Events panel shows and its data
  is older than the plugin's period, and when the person asks. Jobs on
  devices would start a frame and a worker at idle, add to the start,
  and repeat the same work on every member's device. Revisit them for
  reminders, or for imports kept in step.

**Versions.** Each part's additions are additive, so the API becomes
`0.1.1`, then `0.1.2` and on, and a plugin that uses one asks for
`^0.1.1` or later. Moving to `0.2` would stop every plugin that asks for
`^0.1`, as `satisfies` reads a caret before 1.0. `1.0` waits until the
SDK stops gaining surface, though ADR 0055 first tied it to the
directory.

### Connections

**A connection is the person's access to one account at one service.**
The app keeps it; a plugin sees it without its secret:

| Field | What it is |
| --- | --- |
| `id` | The connection's ID |
| `service` | `ics`, `caldav`, `google-calendar`, `google-drive`, `github` or `slack` |
| `name` | What the person calls it, as "Work calendar" |
| `account` | Who it acts as there, as `octocat` or `ada@example.org`, when the service says |
| `address` | The base address requests go under, without its secret: an ICS feed's host alone |
| `web` | The service's web host, for link previews: `github.com`, a GitHub Enterprise Server's host, `acme.slack.com` |
| `where` | `device` or `server` |

**Services are the app's, a closed list**, in a package of their own,
`@nether/integrations` (AGPL), shared by the desktop page and the
server: each one's ways to authenticate, its origins, its OAuth
endpoints and scopes, and the request that checks a new connection and
names its account:

| Service | Credential | Origins | Check |
| --- | --- | --- | --- |
| `ics` | The address, kept as a secret; optional Basic | The feed's | `GET` gives text that starts `BEGIN:VCALENDAR` |
| `caldav` | Basic: user name and app password | The address's, and those the person allows | `PROPFIND` of `current-user-principal`, answered 207 |
| `google-calendar` | OAuth | `https://apidata.googleusercontent.com` | The token's `email` |
| `google-drive` | OAuth | `https://www.googleapis.com` | `GET /drive/v3/about?fields=user` |
| `github` | A token, or OAuth | `https://api.github.com`, or the Enterprise Server's address | `GET /user` |
| `slack` | A user token, or OAuth | `https://slack.com` | `auth.test`, which gives the team's address |

**Only built-in plugins may use connections, in this item.** The SDK's
types are public and `connection:<service>` is a defined permission, but
the host refuses it to a plugin from a vault or the directory, which is
listed as one that cannot run: "It asks for connection:github, which only
Nether's own plugins may use for now." A connection's credential acts as
the person at the service, so an approved plugin with `vault:read` could
copy the vault out through it: into a gist, a Drive file or a Slack
message.

**Where a connection is kept**:

- **On this device**, in the desktop app: a Go service, `Connections`,
  keeps each one's fields in `connections.json` beside `servers.json`, and
  its secret in the keychain under `connection <id>`, through
  `mygo.Secrets`, as AI keys are. Every vault on the device can use it;
  each vault turns the plugins on for itself.
- **On the account's server**, sealed with `NETHER_SECRET_KEY` as AI keys
  are, in `integration_connections`. The web app has only these. The
  desktop app lists them too, for a vault of a workspace on that server,
  with **On nether.example.org** beside each, and reaches them through
  the server's relay, below.

**The app's Connections tab**, in the settings beside the AI tab, lists
them by service, adds, renames, checks and removes them. Adding one is a
form the app draws for each service: an address, a user name and a
password, a token, or **Connect with GitHub**, which runs OAuth. A
plugin never sees the form. Removing a connection made by OAuth also
revokes its token at the service where the service offers it.

### Requests through the app

`context.http.fetch({ connection, url, method, headers, body, as })`:

- **`url` is resolved against the connection's address**: `""` is the
  address itself, as an ICS feed, and a path goes under it. A full
  address must be at one of the connection's origins.
- **Addresses** are `https:`, with `webcal:` read as `https:`. `http:`
  is for a private address alone: on the desktop, any the person types,
  as a CalDAV server on their network; on the server, those
  `NETHER_INTEGRATIONS_PRIVATE` allows.
- **Methods**: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`,
  `PROPFIND` and `REPORT`.
- **Headers** are the plugin's, but for `Authorization`, `Cookie`,
  `Host` and `Proxy-*`, which are refused. The app adds the credential:
  Basic, or `Authorization: Bearer`.
- **Redirects** are followed by the app, up to five, `redirect: "manual"`
  in Go's fetch: each hop must be at one of the connection's origins, or,
  for an ICS feed, any `https:` address. The credential goes only to the
  connection's own origins.
- **The answer**: its status, the headers a plugin needs
  (`content-type`, `etag`, `last-modified`, `location`, `link`,
  `retry-after`, `dav`, `x-ratelimit-*`), and its body as text or bytes,
  up to 20 MB. A request body is 1 MB at most. A request takes a minute
  at most.
- **An expired OAuth token is refreshed** by the app before the request,
  or once after a 401, and kept.
- **Where it goes**: on the desktop, through Go's fetch for a connection
  kept on the device; through the server's relay for one kept there, and
  in the web app.
- **`connections.allow(connection, origin)`** asks the person, in the
  app's words, whether a CalDAV connection may reach another origin its
  server named, as iCloud's `caldav.icloud.com` names a
  `pNN-caldav.icloud.com`. Allowed, the origin is kept with the
  connection.

**The relay**: `POST /api/integrations/connections/:id/fetch`, with a
session or a bearer token, as the AI relay takes:

- the connection must be the account's;
- addresses are checked through `outbound.ts` as each request is sent:
  public ones, or those `NETHER_INTEGRATIONS_PRIVATE` allows, with the
  syntax of `NETHER_WEBHOOK_PRIVATE`, as a Nextcloud or a GitHub
  Enterprise Server inside the admin's network. It is its own setting:
  what the relay reaches, it reads back to a member;
- 120 requests a minute an account;
- it logs nothing of what is sent or answered.

**`NETHER_INTEGRATIONS`** is `on` by default; `off` keeps no connection
on the server, relays nothing and offers no OAuth. Without
`NETHER_SECRET_KEY`, the server keeps no connection, since even a feed's
address is a secret, and the web app's Connections tab says so.

### OAuth with the admin's own apps

**An instance admin registers the organization's own apps** at GitHub,
Google and Slack, and gives Nether their client IDs and secrets. Nether
has no app of its own: no project-owned client, nothing that passes
through anyone else.

- **In the console's Integrations page**, which is in every build, as the
  Features page is, since integrations are not an enterprise feature. A
  row for each service: the client ID, the secret (written, never shown
  again, sealed with `NETHER_SECRET_KEY`), GitHub's address
  (`https://github.com` or an Enterprise Server's), and the redirect
  address to register, `<NETHER_PUBLIC_URL>/api/integrations/<service>/callback`,
  to copy.
- **Or by the environment**, which pins a row: `NETHER_GITHUB_CLIENT_ID`,
  `NETHER_GITHUB_CLIENT_SECRET` and `NETHER_GITHUB_URL`;
  `NETHER_GOOGLE_CLIENT_ID` and `NETHER_GOOGLE_CLIENT_SECRET`;
  `NETHER_SLACK_CLIENT_ID` and `NETHER_SLACK_CLIENT_SECRET`. A pinned row
  shows as set by its variables, with no control.
- **Kept** in `integration_apps`, in core's migrations.

**Scopes the server asks for**:

- GitHub: `repo` for an OAuth App; a GitHub App's permissions are its
  own. The admin guide sets up a GitHub App with Issues, Pull requests
  and Metadata, read only, and says why.
- Google Drive: `drive.readonly`, with `openid email`. The guide says to
  make the client **Internal** to a Google Workspace organization, or to
  publish it for personal use, since a client left in Testing loses its
  connections every 7 days.
- Google Calendar: `https://www.googleapis.com/auth/calendar`, with
  `openid email`, as other CalDAV clients ask, since Google's CalDAV guide
  names no narrower scope. It also lets Nether write, which it does not;
  the guide says Nether only reads. The live check tries
  `calendar.readonly`, and the scope narrows to it if Google's CalDAV
  accepts it.
- Slack: the user scopes `channels:history`, `groups:history`,
  `im:history`, `mpim:history` and `users:read`; `incoming-webhook` only
  to add a channel's notifications, in part 7.

**The flow**, the same from every app:

1. The app asks `POST /api/integrations/<service>/start`, and gets an
   address at the service and a start ID. The server keeps the start in
   `integration_starts`: the account, a random `state`, a PKCE verifier,
   ten minutes to finish.
2. The app opens the address in the system's browser, or a new tab of
   the web app's browser, and waits, asking
   `GET /api/integrations/starts/:id` every two seconds.
3. The service sends the browser to the callback with its code. The
   server takes the start by its `state`, once; exchanges the code with
   the client secret and the verifier; asks the service whose account it
   reached; and keeps the tokens sealed in the start, unused.
4. **The callback page names both accounts and asks**: "Connect GitHub
   account octocat to ada@example.org on nether.example.org?" A service
   approves a returning person without a screen, so a start made by
   someone else and opened by its victim would otherwise give the
   victim's GitHub to the stranger's account. **Connect** makes the
   connection, and the page says to go back to the app. **Cancel**, or
   ten minutes without an answer, revokes the tokens.
5. The app's wait ends with the connection, or with why it failed.

**Tokens are refreshed by the server** before they expire, under
`db.lock` on the connection, so two nodes never spend a GitHub refresh
token that rotates.

### The desktop with no server

The person brings their own, kept on the device:

- **ICS**: the feed's address.
- **CalDAV**: an address, a user name and an app password.
- **GitHub**: a personal access token, with a GitHub Enterprise Server's
  address if they use one. The tab says which fine-grained permissions to
  give: Issues, Pull requests and Metadata, read only.
- **Google**: an OAuth client of their own, of the Desktop type, whose
  ID and secret they paste; the app connects by loopback with PKCE,
  through `Servers.Listen`, and refreshes the token itself. The guide
  says how to make one and about the 7 days of Testing. Google gives
  people no tokens of their own.
- **Slack**: the user token of a Slack app they made and installed in
  their workspace, with the scopes above. Slack allows no loopback
  address to come back to.

A desktop app signed in to a server whose admin set up an app also
offers **Connect with GitHub through nether.example.org**, kept on the
server.

### The calendar

**Sources** are the person's `ics`, `caldav` and, from part 5,
`google-calendar` connections. A Google Calendar's secret iCal address
works as an ICS feed from part 1, with no OAuth.

- **ICS**: the whole feed, asked with `If-None-Match` and
  `If-Modified-Since`.
- **CalDAV**: from the address, `current-user-principal`, then
  `calendar-home-set`, then each calendar in it, by `PROPFIND`. Events
  come by `REPORT`: `sync-collection` with the last `sync-token` where the
  server gives one, as Google asks, else a `calendar-query` for the
  window's time range.
- **Parsing**: `ical.js`, which reads time zones from each feed's
  `VTIMEZONE` and expands recurrences with their exceptions
  (`RRULE`, `EXDATE`, `RECURRENCE-ID`) within the window. A `TZID` the
  feed does not define is read as an IANA zone when it is one, and as a
  floating time otherwise. Cancelled events are left out.
- **The window**: from a month back to a year ahead, kept per source in
  `context.store`. A day outside it is read when it is shown.
- **Refresh**: when a calendar block or the Events panel shows and the
  source is older than the plugin's **Refresh every** setting, 15 minutes
  by default, and on **Refresh**.

**Where events show**, read live from the store, never written unless
asked:

- **A `calendar` code block**:

  ````markdown
  ```calendar
  day: 2026-11-17
  days: 1
  calendars: Work, Home
  ```
  ````

  Every key is optional. Without `day`, a daily note's block shows that
  note's day, and any other note's shows today. A daily note template can
  hold the block with no keys. In Obsidian, or with the plugin off, it
  stays readable text.
- **The Events panel** beside a note: a daily note's day, or today. Its
  **Add to the note** appends the day's events to the note, as a Markdown
  list any app reads: `- 09:00-09:30 Standup`, with each event's
  location, and `All day:` before the day's whole events.
- Times show in the device's zone.
- **A block shows the events of whoever opens the note.** In a shared
  daily note, each member sees their own calendars. Only **Add to the
  note** writes events where others read them.

A calendar view of its own, a month or a week, waits for a call that
opens a daily note, and is not in this item.

### GitHub

- **Link previews.** An issue's or a pull request's link alone on its
  line, at `github.com` or a connection's Enterprise Server, previews as
  its number and title, its repository, and its facts: open, closed,
  merged or draft, its author, labels, assignees and when it changed.
  Asked by `GET /repos/{owner}/{repo}/issues/{number}`, and
  `/pulls/{number}` for a pull request. Kept in `previews.json` as other
  previews are, and asked again when its note opens, at most once an
  hour, while the app can reach the service.
- **A `github` code block** shows issues and pull requests live, as a
  table: number, title, state, labels, assignees and when they changed,
  each a link.

  ````markdown
  ```github
  repo: fzn0x/nether
  state: open
  labels: bug
  type: issues
  limit: 20
  ```
  ````

  `query:` takes GitHub's search syntax instead, through
  `/search/issues`, whose limit is 30 requests a minute. The last answer
  is kept in the store and shown, with its time, offline.
- **Issues and pull requests as database rows** are not in this item:
  they need a call that hands the app an import plan
  ([ADR 0027](0027-imports-are-plans-made-from-sources-read-only.md)) to
  preview and write. Part 7 opens a follow-up issue for them.

**Link previews from plugins.** A manifest's `linkPreviews` names hosts,
with a leading `*.` allowed, and whether its connections' `web` hosts
count too. The plugin answers a link with plain fields, never HTML: a
title, a description, a site, a state, facts as names and values, and
actions. The app draws the card, so nothing of the plugin's draws in the
page. An action, such as **Copy into the note**, calls the plugin back
with the link and the note it is in.

**Links in a plugin's HTML.** The sandbox's cleaning keeps `https:`
links to the `web` hosts of the plugin's connections, which open in the
system's browser, so a `github` block's issues are links. This amends
ADR 0058's cleaning for plugins with connections; others are unchanged.

### Google Drive

- **Link previews** of `docs.google.com` and `drive.google.com` links:
  the file's name, its kind, its owner and when it changed, from
  `files.get`.
- **Copy into the note**, a preview's action: a Doc as Markdown, by
  `files.export` as `text/markdown`; a Sheet's first sheet as a table,
  from its CSV; any other file up to 20 MB into the vault, beside the
  note as the app puts attachments, by `context.vault.writeFile`, and
  embedded where the link was. The link stays above what it copied.
- Google's Picker is a script of Google's in a frame, which neither the
  page nor the sandbox runs, so `drive.file` is not enough.

### Slack

- **Link previews** of message links, `*.slack.com/archives/<channel>/p<ts>`:
  the author, the channel, the time and the start of the text, from
  `conversations.replies`, with `users.info` naming the people it
  mentions.
- **Clip into the note** and **Clip the thread**, a preview's actions,
  replace the link with a quote callout:

  ```markdown
  > [!quote] Ada Lovelace in #launch, 2026-11-17 10:02
  > We ship on Friday.
  > [Open in Slack](https://acme.slack.com/archives/C0123/p1763373720000100)
  ```

  Slack's own markup becomes Markdown: bold, italics, strikes, code,
  links, and mentions of people and channels by name.
- **Notifications to a channel** come from the server, not a plugin:
  every member's device would otherwise post the same change. A webhook
  ([ADR 0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md))
  gains a `format`, `standard` by default or `slack`, and an optional
  `folder`:
  - a `slack` webhook posts `{"text": ...}`, as "Launch plan was changed,
    in Projects, in Acme", with Slack's escaping, unsigned. Mattermost's
    incoming webhooks read the same body, for an install with no
    internet;
  - **a post holds a note's title, its path and a link, never an excerpt
    of its text.** Webhooks carry a note's ID, path and title and never
    its text (`outbox.ts`), so data policies' export switch does not need
    to cover them, and a Slack post keeps it so;
  - a webhook with a folder tells only of notes in it, or, for a
    deletion, last in it;
  - everything else of ADR 0060 holds: who sees what, the outbox, bursts
    as one event, retries, and public addresses unless
    `NETHER_WEBHOOK_PRIVATE` allows others;
  - **Add to Slack**, in the Webhooks dialog when the admin set up a
    Slack app, installs it with `incoming-webhook`; the owner picks a
    channel at Slack, and the server makes the webhook from the address
    Slack gives, after the callback page's question. Without the admin's
    app, an owner pastes a webhook's address from their own Slack app;
  - the dialog shows a Slack address without its last part.

### What runs where

| | Desktop, no server | Desktop, signed in | Web app | Server |
| --- | --- | --- | --- | --- |
| Connections kept | Keychain | Keychain, and the account's on the server | The account's on the server | Sealed |
| OAuth with the admin's app | No | Through the server, in the browser | Through the server, in a tab | Runs it |
| A person's own OAuth client | Google, by loopback | Google, by loopback | No | No |
| Requests | Go's fetch | Go's fetch, or the relay | The relay | The relay, checked |
| Parsing and drawing | The plugin's worker | The plugin's worker | The plugin's worker | Nothing |
| Notifications to Slack | None | The server | The server | The webhook worker |

### Offline

- **The calendar** shows what the store kept, with "Updated at 08:15";
  a refresh that fails says so in the block and the panel, and tries
  again at the next showing.
- **Previews** show what `previews.json` kept, as other previews do.
- **A `github` block** shows its last answer and when it came.
- **Clips, copies and connecting** need the service, and say so.
- **What a plugin wrote into a note** is the note's, offline as any text.
- **A connection kept on the server** is unreachable while the server is;
  the keychain's are not.
- **Slack notifications** wait in the outbox, as webhooks do.
- In the web app, a plugin that runs apart starts only while the server
  answers, as ADR 0058 says; offline, it does not start.

### Loading and memory

- The plugins are off by default, so a vault that never turns one on
  loads only their manifests, as it does every built-in plugin's: no
  code, no frame, no request.
- A plugin turned on loads when what it adds is first used: a block
  drawn, a panel shown, a preview asked for. It then costs a frame and a
  worker, a few megabytes, as any plugin that runs apart does.
- `ical.js` and `@xmldom/xmldom` load only in the calendar's worker.
- Each part's PR says whether the desktop app's idle load changes; with
  the plugins off, it should not.

### Mobile

The mobile apps hide integrations in this item, as they hide AI: the
Integrations heading, the Connections tab and the plugins. Their part,
with connections in the Keychain and the Keystore and requests through
`CapacitorHttp`, is a follow-up.

### Audit events

Added to core's list, in ADR 0081's style:

| Action | When |
| --- | --- |
| `integration.connected` | An account connects to a service through the server: the service and the account there |
| `integration.disconnected` | An account removes a connection kept on the server, or loses it with its removal |
| `integration.app_changed` | An instance admin sets or removes an app in the console, never its secret |

Webhooks' own events cover the Slack ones.

### Testing

No test reaches a real account.

- **The SDK's new calls** run through both connections, the page's and a
  port, as ADR 0055's tests do, and the host's refusals are tested: an
  origin not the connection's, a refused header, a credential never in
  an answer, a redirect elsewhere, a body over its limit.
- **ICS**, on fixtures shaped as Google, Outlook and Apple export them:
  time zones defined and not, Windows zone names, daylight-saving
  changes, recurrences with exceptions, all-day and multi-day events,
  cancelled ones, and `304` answers.
- **CalDAV against a real server in CI.** A job installs Radicale, pinned,
  from PyPI, runs it on `127.0.0.1` with `htpasswd` users, and seeds it by
  `PUT`. Radicale is GPL-3.0 and only runs in CI, as OpenLDAP does for
  ADR 0085. The tests: discovery from `/.well-known/caldav`, a wrong
  password, `calendar-query` by time range, `sync-collection` and its
  token, and an event changed between two syncs. Locally they run when
  `NETHER_TEST_RADICALE` names a server, and skip otherwise, as
  Keycloak's do.
- **Servers not in CI**, Google's CalDAV, iCloud, Fastmail and
  Nextcloud, are tested by answers shaped as their documentation shows
  them: iCloud's other host, Google's sync tokens. The tests say which
  behaviour is assumed.
- **GitHub, Google and Slack** are local fakes in the tests, answering as
  their documentation shows, GitHub's from the examples of its published
  OpenAPI description: the previews, the `github` block, a Doc's export,
  a message and its thread, rate limits and errors. The fakes are plain
  Node servers; no mocking library is added.
- **OAuth on the server**, against a fake service: the start, the
  callback's question, `state` used once and expired, the exchange with
  the verifier, sealing, refreshing under the lock with a rotating
  refresh token, revoking, and the relay's checks through `outbound.ts`.
- **The desktop's Go service**, with the keychain stood in for, as
  `ai_test.go` does.
- **End-to-end**, in Playwright with the preview standing in for Go and
  the server, and with `CI=1`: a feed connected, its plugin turned on, a
  daily note's block showing its events, and offline after.
- **Slack's webhook format** against a local receiver in the server's
  suite.
- **A follow-up issue** asks the maintainer to check GitHub, Google,
  Slack, iCloud and Fastmail live, with the guide's steps, as SSO's #190
  does.

### Libraries

| Package | Version | License | For | Maintained |
| --- | --- | --- | --- | --- |
| `ical.js` | 2.2.1 | MPL-2.0 | Parsing feeds, time zones, recurrences | Commits in November 2026; no dependencies; 78 KB minified |
| `@xmldom/xmldom` | 0.9.12 | MIT | Reading CalDAV's XML in a worker, which has no `DOMParser` | Commits in November 2026; no dependencies |
| Radicale | A release a week old when part 2 starts | GPL-3.0 | CalDAV in CI only | 3.9.1 on 2026-11-12, 3.9.2 on 2026-11-17 |

GitHub, Google and Slack get plain `fetch` through the app: each call is
a request and a JSON answer. No vendor SDK.

### Where it lives

- `packages/integrations`: the services, their checks, origins and OAuth
  endpoints; shared by the desktop page and the server.
- `packages/plugin-api`: the new calls, MIT as the rest of it.
- `apps/desktop/src/plugins/{calendar,github,google-drive,slack}`: the
  plugins, each built as one module.
- `apps/desktop`: the `Connections` Go service, the Connections tab, the
  host's calls, the console's Integrations page.
- `apps/server`: the tables, the relay, the OAuth routes, webhooks'
  format and folder.
- The guides: a user guide page for each integration and for
  connections; an admin guide page for each service's app; the plugin
  developer guide's new calls.

### Parts

Each from `origin/main`, one PR each, its guide pages in the same PR:

1. **Connections and requests through the app, and calendars from ICS
   feeds, on the desktop.** The SDK's `connection:*` permissions,
   `connections`, `http.fetch`, `store` and a note's context; built-in
   plugins that run apart and start off; the Integrations heading of the
   Plugins tab; the Connections tab with ICS; the `Connections` Go
   service; the `calendar` plugin with its block, its panel and **Add to
   the note**; `ical.js`.
2. **CalDAV.** Discovery, `connections.allow`, `calendar-query` and
   `sync-collection`, `@xmldom/xmldom`, and the Radicale job in CI.
3. **Connections kept on the server, and the web app.**
   `integration_connections`, the relay, `NETHER_INTEGRATIONS` and
   `NETHER_INTEGRATIONS_PRIVATE`, the web app's Connections tab and its
   calendar, the desktop listing the account's connections, and the
   audit events for connections.
4. **GitHub.** `linkPreviews`, the cleaning's links, the `github`
   plugin with its previews and block, tokens on the desktop, and the
   admin's apps: `integration_apps`, `integration_starts`, the console's
   Integrations page, the environment's variables, the flow with its
   question, refreshing and revoking.
5. **Google.** Its row in the console, the desktop's own client by
   loopback, Google Calendar through its CalDAV in the `calendar`
   plugin, the `google-drive` plugin, and `vault.writeFile`.
6. **Slack clips.** Its row in the console, user tokens on the desktop,
   and the `slack` plugin's previews and clips.
7. **Slack notifications.** Webhooks' `format` and `folder`, the Webhooks
   dialog's choices, and **Add to Slack**. It ticks the roadmap item, and
   opens the follow-up issues: the live checks, and GitHub's issues as
   database rows.

Parts 5, 6 and 7 can be built side by side once 4 is in. Each part with a
migration takes the next free number when it opens.

## Alternatives

- **Integrations as plugins in the directory**, in repositories of their
  own. An air-gapped install could not get them, and the server's part
  is built in anyway. Principle 6 has Nether's own features built in on
  the API.
- **Built-in plugins in the page, with `ctx.host`.** Their HTML would
  show as it is, and they would parse what strangers write beside the
  page's bridge. They would not prove the sandbox.
- **Plugins holding their tokens**, through a secrets call. A plugin's
  mistake, or a third party's plugin, could send them anywhere; the app
  adding them keeps them in the keychain or sealed on the server.
- **The `network` permission for integrations.** Most CalDAV servers and
  feeds send no CORS headers to a `null` origin, and the credential would
  have to be in the worker.
- **A Nether-owned OAuth app.** The requirements ask for the admin's own.
  One project's app would see every install's tokens pass through its
  name, and would need Google's verification for restricted scopes.
- **OAuth flows run by plugins.** Client secrets would reach plugins, and
  only the app can open the browser and listen on a loopback address.
- **Connecting without the callback's question.** A start made by one
  account and opened by another would connect the second's service to
  the first's account, unseen, when the service approves without a
  screen.
- **Jobs on devices, or on the server, keeping calendars and issues in
  step.** On devices: start time, idle memory, and the same work on each
  member's device. On the server: none for the desktop with no server,
  and none in an encrypted workspace.
- **Events as notes**, one note an event, as Obsidian's Full Calendar
  keeps its local calendars. Hundreds of notes for each calendar, churning
  sync and history, for data the service keeps.
- **`tsdav`.** It sends its own requests, and brings `xml-js`, whose last
  release is years old.
- **`node-ical`.** It brings a Temporal polyfill; `ical.js` runs in a
  worker as it is and has no dependencies.
- **Google's Calendar API** in place of its CalDAV. A second path for one
  service; the requirement puts CalDAV and ICS first.
- **`drive.file`.** It reaches only files picked through Google's Picker,
  which needs Google's script in a frame.
- **Slack bot tokens for clips.** A bot reads only channels it was added
  to; a user token reads what the person can.
- **Slack's Events API or a message shortcut, "Save to Nether" in
  Slack.** Slack would have to reach the server from the internet, with
  signed requests; a later item can add it.
- **GitHub's device flow on the desktop.** It needs an OAuth app of the
  person's own with the flow turned on; a token is simpler for one
  person, and the admin's app goes through the server.
- **Allowing a CalDAV connection the whole registrable domain of its
  address.** It needs the public suffix list, and would allow
  `*.co.uk` from `example.co.uk` without it. The person allows each
  origin once.
- **Following redirects in Go's fetch.** A hop would go unchecked.

## Consequences

- **The plugin API grows** by connections, requests through the app, a
  store, a note's context, link previews and writing files, each part's
  additions a patch of `0.1`.
- **Built-in plugins can run apart.** Others could move there later.
- **Connections are for Nether's own plugins for now.** Opening
  `connection:<service>` to plugins from vaults and the directory is a
  later decision, after the live checks, with what their approval must
  then say.
- **Each service's app is the organization's.** The admin registers
  three, follows the guide's steps, and sets `NETHER_PUBLIC_URL` and
  `NETHER_SECRET_KEY`. A person on the desktop with no server brings
  their own credentials.
- **Google's terms show through.** A client left in Testing loses its
  connections every 7 days; `drive.readonly` needs an internal or
  personal-use client, or Google's verification. The guide says so.
- **Slack's limits show through** for an app distributed outside the
  Marketplace: one request a minute. An organization's own app in its
  own workspace is not limited so; the guide says to keep it so.
- **A webhook's address can now be Slack's**, which is a secret; it is
  kept as webhooks' addresses are, and shown cut short. Data policies'
  export switch does not stop webhooks, Slack's included; a note's title
  and path are what they send.
- **The server reads back what the relay reaches.** Members' connections
  reach the admin's network only where `NETHER_INTEGRATIONS_PRIVATE`
  allows.
- **In an encrypted workspace**, the relay sees what services answer, not
  the vault's text: the plugins send none of it. It has no webhooks, so
  no Slack notifications.
- **Mobile, a calendar view, GitHub rows and Slack's own shortcut** are
  follow-ups.
- **Revisit** background jobs if reminders are wanted; Google Calendar's
  REST API, whose `calendar.readonly` reads only, if its CalDAV keeps
  needing the full scope; and the API's `1.0`, once the SDK stops gaining
  surface.

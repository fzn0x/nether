# Phase 3 report: Self-hosted sync and collaboration

- Date: 2026-11-15
- Gate: `docker compose up` works, and two users co-edit offline and
  online with no lost edits. Both run in CI on every change: the Docker
  compose job sets a server up from its log, restarts it and restores it
  on a new install, and the gate test has two people co-edit live, offline
  and one of each, with every word kept, on fifteen seeds before it
  merged.

Phase 3 is done: Nether syncs vaults through a server you run, with
end-to-end encryption, spaces and sharing, co-editing and comments, and
the server serves Nether's web app. Every task on the
[roadmap](../roadmap.md#phase-3-self-hosted-sync-and-collaboration) is
ticked. It ships as Nether's first public release, 0.1.0. Phase 4, the
platform, starts now.

## What shipped

| Feature | Pull request | Notes |
| --- | --- | --- |
| Memory headroom | [#52](https://github.com/fzn0x/Nether/pull/52) | Database, query and dialog code loaded when used, 2.5 MB of Phase 2's 5 MB |
| The server and its database | [#53](https://github.com/fzn0x/Nether/pull/53) | PostgreSQL, migrations as it starts, first-run setup with a code from its log ([ADR 0031](../adr/0031-the-server-keeps-its-data-in-postgresql-and-is-set-up-with-a-code-from-its-log.md)) |
| Accounts | [#54](https://github.com/fzn0x/Nether/pull/54), [#55](https://github.com/fzn0x/Nether/pull/55), [#56](https://github.com/fzn0x/Nether/pull/56) | argon2id passwords, sessions and invitations, codes by email, OpenID Connect, rate limits ([ADRs 0032 to 0034](../adr/0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md)) |
| Sync | [#57](https://github.com/fzn0x/Nether/pull/57) to [#61](https://github.com/fzn0x/Nether/pull/61) | Hocuspocus beside the API, tokens in the keychain, a vault document of paths, edits made offline sent when back ([ADRs 0035 to 0037](../adr/0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md)) |
| End-to-end encryption | [#62](https://github.com/fzn0x/Nether/pull/62), [#63](https://github.com/fzn0x/Nether/pull/63), [#64](https://github.com/fzn0x/Nether/pull/64) | Keys sealed to each member, updates relayed unread, a recovery phrase ([ADR 0038](../adr/0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)) |
| Attachments | [#65](https://github.com/fzn0x/Nether/pull/65), [#66](https://github.com/fzn0x/Nether/pull/66) | By hash, on disk or in S3; synced by path, both kept when changed on two devices ([ADRs 0039 and 0040](../adr/0039-attachments-are-kept-by-their-hash-on-disk-or-in-an-s3-bucket.md)) |
| Version history | [#67](https://github.com/fzn0x/Nether/pull/67), [#68](https://github.com/fzn0x/Nether/pull/68) | Each computer's and the server's, with a line diff and restore ([ADR 0041](../adr/0041-a-notes-history-is-its-earlier-texts-kept-before-each-spell-of-editing.md)) |
| Spaces and permissions | [#69](https://github.com/fzn0x/Nether/pull/69) to [#74](https://github.com/fzn0x/Nether/pull/74) | Members and roles, teamspaces, private spaces, shared pages inherited down the tree, guests, each a sync unit ([ADR 0042](../adr/0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)) |
| Co-editing | [#75](https://github.com/fzn0x/Nether/pull/75) | Notes open in the editor sync live, with the others' carets ([ADR 0043](../adr/0043-a-note-open-in-the-editor-syncs-live-with-awareness-for-carets.md)) |
| Comments and mentions | [#76](https://github.com/fzn0x/Nether/pull/76) to [#79](https://github.com/fzn0x/Nether/pull/79) | A document of comments beside each note, notifications in the app and by email ([ADRs 0044 and 0045](../adr/0044-a-notes-comments-are-a-document-of-their-own-beside-it.md)) |
| Server search | [#99](https://github.com/fzn0x/Nether/pull/99) | PostgreSQL full text over what an account may open ([ADR 0050](../adr/0050-the-server-searches-what-it-can-read-indexed-as-notes-are-stored.md)) |
| The canvas | [#100](https://github.com/fzn0x/Nether/pull/100) to [#103](https://github.com/fzn0x/Nether/pull/103) | JSON Canvas files as Obsidian keeps them, in tabs, with five kinds of card ([ADR 0051](../adr/0051-canvases-are-json-canvas-files-drawn-with-the-page-s-own-elements.md)) |
| Task assignment | [#104](https://github.com/fzn0x/Nether/pull/104) | Person properties, and an Assigned tab across databases |
| Backups | [#105](https://github.com/fzn0x/Nether/pull/105) | One file of the database and attachments, scheduled, restored at its schema then migrated, the restore run in CI ([ADR 0052](../adr/0052-backups-are-the-server-s-own-files-restored-at-their-schema-then-migrated.md)) |
| The web app | [#107](https://github.com/fzn0x/Nether/pull/107), [#109](https://github.com/fzn0x/Nether/pull/109), [#111](https://github.com/fzn0x/Nether/pull/111) to [#114](https://github.com/fzn0x/Nether/pull/114) | The desktop page in the browser, sessions in a cookie, vaults in the private file system, installable and offline ([ADR 0053](../adr/0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)) |
| `docker compose up` | [#122](https://github.com/fzn0x/Nether/pull/122) | The server's image, PostgreSQL 18, Valkey for the rate limits, volumes; checked in CI from setup to a restore ([ADR 0054](../adr/0054-docker-compose-starts-the-server-with-postgresql-valkey-and-volumes.md)) |
| Setup from the app | [#124](https://github.com/fzn0x/Nether/pull/124), [#130](https://github.com/fzn0x/Nether/pull/130) | The Servers dialog and the web app ask for the setup code |
| Sync in every build | [#125](https://github.com/fzn0x/Nether/pull/125) | Hidden behind a build flag since [#97](https://github.com/fzn0x/Nether/pull/97), shown now |
| The gate and the load harness | [#128](https://github.com/fzn0x/Nether/pull/128), [#129](https://github.com/fzn0x/Nether/pull/129) | Two people co-editing offline and online; 200 people on a server of 2 vCPU and 4 GB |
| Fixes | [#73](https://github.com/fzn0x/Nether/pull/73), [#82](https://github.com/fzn0x/Nether/pull/82), [#89](https://github.com/fzn0x/Nether/pull/89), [#95](https://github.com/fzn0x/Nether/pull/95), [#106](https://github.com/fzn0x/Nether/pull/106), [#123](https://github.com/fzn0x/Nether/pull/123) | Among them notes changed while sync was stopped, which the gate found |
| Asked for along the way | [#83](https://github.com/fzn0x/Nether/pull/83) to [#88](https://github.com/fzn0x/Nether/pull/88), [#90](https://github.com/fzn0x/Nether/pull/90) to [#94](https://github.com/fzn0x/Nether/pull/94), [#96](https://github.com/fzn0x/Nether/pull/96) | Properties reordered by dragging, a note menu, bookmarks, merging, tabs, menus for every command, folders, a resizable sidebar, icons, two themes ([ADRs 0046 to 0049](../adr/0046-notes-open-in-tabs-in-at-most-two-panes-each-with-its-own.md)) |
| A preview release | [#98](https://github.com/fzn0x/Nether/pull/98) | 0.0.1, the desktop app alone, with signed updates |

## The gate

- **`docker compose up` works.** CI's Docker compose job builds the
  server's image and runs `deploy/docker/check.mjs` on every change, as an
  admin would: it starts the server with PostgreSQL 18 and Valkey, sets it
  up with the code from its log, keeps an attachment, loads the web app
  under its content security policy, finds the rate limits counted in
  Valkey and makes a backup; then stops it all and starts it again, signs
  in and reads the attachment back; then restores the backup on a new
  install, as the self-hosting guide has it. The apps set a new server up
  themselves since #124.
- **Two users co-edit offline and online with no lost edits.**
  `packages/sync-client/test/gate.test.ts` runs with the sync client's
  tests in CI. Ada and Grace, whom she invites, each sync a vault of their
  own through a real server, and make the edits a seeded random sequence
  picks: words written in between words, and their own words taken out
  again. They edit live, both with the note open; offline, both at once in
  two notes, each also making one; and one live while the other is
  offline. Every time both end with the same text: every word written and
  not taken out, once, and none taken out. Fifteen seeds passed before it
  merged. The test found a real loss first: a note changed while sync was
  stopped reached the server only once someone else changed it, fixed in
  #123.

## Measured

On the maintainer's Windows 11 machine, on 97b9291, as
[ADR 0017](../adr/0017-measure-performance-before-each-gate-not-in-ci.md)
has the harnesses run before each gate: the reference vault of 50,000
notes, 10,000 for the graph; and for sync, the server in Docker Desktop
with PostgreSQL and Valkey limited to 2 vCPU and 4 GB together.

| Target | Phase 3 | Phase 2 | Limit |
| --- | --- | --- | --- |
| Title search, p95 | 28.3 ms | 22.9 ms | 50 ms |
| Full-text search, p95 | 72.8 ms | 77.8 ms | 300 ms |
| Reading and parsing a note, p95 | 4.4 ms | 4 ms | 100 ms |
| Switching notes, click to frame, p95 | 39.5 ms | 35.6 ms | 100 ms |
| Typing, key to frame, p95 | 16 ms | 16 ms | 16 ms |
| Opening to the last note, median of 5 | 1.34 s | 1.23 s | 1.5 s |
| Idle memory after 60 s, median of 5 | 295.7 MB | 292 MB | 300 MB |
| A note another app writes, in the index, median of 5 | 125 ms | 116 ms | 2 s |
| The graph of 10,000 notes, shown | 679 ms | 502 ms | 3 s |
| The graph, frames while laid out, p95 | 16.8 ms | 16.8 ms | 33.4 ms |
| The graph, frames while zooming, p95 | 16.8 ms | 16.7 ms | 33.4 ms |
| Co-editing, a word to the others' clients, p95, 200 people | 4 ms | | 200 ms |

Sync under load (`pnpm --filter @nether/perf sync`): 200 people for 120
s, ten to a note on 20 notes, each typing a word every two to four seconds
with their caret, 7,993 words reaching 71,937 other clients, at 3 ms at
the median, 6 ms at the 99th percentile and 15 ms at most. The server used
0.08 of a core on average and 0.24 at most, of the 1.5 it had, and 172 MiB
of memory at most; PostgreSQL 93 MiB. No note differed between clients and
no word was lost. The clients shared the machine, so the latency leaves
out the network: in one region, add its round trip.

The desktop app measured the same day on 7eec694, before the phase's last
four pull requests, opened in 1.37 s and idled at 293.5 MB: those pull
requests cost nothing measurable, and the rise since Phase 2 came earlier
in the phase. Which of its changes it came with is not measured yet.

## Deferred

- **Several server nodes.** Valkey keeps only the rate limits' counts. Sync
  between nodes through Hocuspocus's Redis extension, the relay's fan-out
  and presence across nodes come with high availability in Phase 5, with
  the Helm chart.
- **Encrypted workspaces' extras.** They have General alone, no teamspaces
  or shared pages, and neither the server's search nor its history, which
  need what the server cannot read.
- **Mentions in a note's text**, beside those in comments: their Markdown
  syntax is still to be decided.
- **A note in a window of its own**, with windows sharing open notes; it
  needs a record of how windows share the index.
- **Web link previews in the web app**: the desktop app fetches them, which
  a page can do only from its own server.
- **From earlier phases, still deferred**: a content security policy for the
  desktop page, a screen reader pass by hand, translations, code signing of
  the Windows and macOS builds, and the Phase 2 items its report lists.

## Known issues

- Comments made while sync was stopped, as while signed out, sync only
  once the note's comments change again on either side: comments keep no
  time of their own for the engine to look at, as notes' files do (#123).
- While the server cannot reach Valkey, the routes with a rate limit,
  signing in among them, answer 503 rather than go unlimited.
- Idle memory is 4.3 MB under its limit at the median, and one of the five
  runs idled at 301.5 MB. Phase 4's plugins add their own, so the phase
  starts by finding room, as Phase 3 did.
- When every package's tests run at once on the maintainer's machine, two
  of them time out now and then: the server's restore of a full server, and
  the vault generator's rewrite of a vault. Each passes alone, and in CI.
- The first release pushes the server's image to the GitHub container
  registry; whether a new package there starts public is to be checked
  once it is pushed.
- The load ran on one machine, in Docker Desktop's virtual machine; a run
  on a real server of 2 vCPU is still to do.
- Dependabot's updates wait until after the release: MyGO from 0.6.2 to
  0.9.0 (#126), the actions (#127) and 50 npm packages (#131).
- Merged branches stay on GitHub; deleting them is left to the maintainer.

## Plan for Phase 4: the platform

One feature per pull request, in this order, each with its record where
it decides something:

1. Headroom in the desktop app's memory, before plugins add their own.
2. The plugin API: a versioned TypeScript SDK for commands, block types,
   views, sidebar panels, settings tabs, Markdown post-processors and
   property types, which core features use where they can.
3. The plugin sandbox: permissions a plugin declares and the user approves
   at install, and untrusted plugins run isolated.
4. The plugin and theme directory: a GitHub-backed index browsable in the
   app, with the community themes deferred from Phase 2.
5. Share links with view, comment or edit access, an expiry and a
   password.
6. Publishing a note or a folder as a site the server serves, on a custom
   domain, with its metadata, and links between published pages only.
7. The public REST API with tokens, and webhooks on create, update and
   delete.
8. AI, bring your own: provider settings with keys kept encrypted, the off
   switch, writing assist, asking your notes with citations, building with
   AI behind a preview, and semantic search, off by default.
9. Buttons and automations: buttons that make notes, set properties or run
   plugin actions, and database triggers.
10. PDF annotation: highlights and comments that become linkable blocks.
11. The web clipper, for Chrome and Firefox.

The gate: a third-party plugin runs sandboxed, and a published site loads
on a custom domain.

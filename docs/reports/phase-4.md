# Phase 4 report: Platform

- Date: 2026-11-17
- Gate: third-party plugins run sandboxed, and a published site loads on a
  custom domain. Both run in CI on every change: the desktop app's
  end-to-end tests run plugins from a vault approved, apart and cleaned,
  and the web app's have a published site load on a domain its DNS proves.

Phase 4 is done: plugins have an API, a sandbox and a directory; the
server has a REST API and webhooks, share links and published sites; AI
comes from a provider you bring; notes have buttons and databases
triggers; PDFs are annotated; and pages clip from the browser. Every task
on the [roadmap](../roadmap.md#phase-4-platform) is ticked. Phase 5,
enterprise, mobile and scale, starts now.

## What shipped

| Feature | Pull request | Notes |
| --- | --- | --- |
| Memory headroom | [#137](https://github.com/fzn0x/nether/pull/137) | The strings notes' indexes repeat, shared as the links load: 10 MB of the heap, before plugins add their own |
| The plugin API | [#138](https://github.com/fzn0x/nether/pull/138) to [#146](https://github.com/fzn0x/nether/pull/146) | `@nether/plugin-api` under MIT: commands, code blocks, blocks and slash entries, panels, settings, views, database layouts and property types, with Nether's diagrams, queries, panels, canvas, graph and layouts built-in plugins on it ([ADRs 0055 to 0057](../adr/0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)) |
| The plugin sandbox | [#147](https://github.com/fzn0x/nether/pull/147), [#149](https://github.com/fzn0x/nether/pull/149), [#150](https://github.com/fzn0x/nether/pull/150) | A vault's plugin runs in a worker in a sandboxed frame, approved on each device for its code as it is; its views drawn in the worker and shown cleaned; the vault read and written through the app as far as it asked ([ADRs 0058](../adr/0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md), [0063](../adr/0063-a-vault-plugins-views-draw-in-its-worker-and-the-page-shows-them-cleaned.md), [0064](../adr/0064-a-plugin-reads-and-writes-notes-through-the-app-as-far-as-it-asked.md)) |
| The plugin and theme directory | [#153](https://github.com/fzn0x/nether/pull/153) | `registry/index.json` here, of files pinned by commit and hash, browsed and installed from the settings ([ADR 0065](../adr/0065-the-directory-is-an-index-in-the-repository-of-files-pinned-by-commit-and-hash.md)) |
| The REST API and webhooks | [#148](https://github.com/fzn0x/nether/pull/148), [#151](https://github.com/fzn0x/nether/pull/151), [#154](https://github.com/fzn0x/nether/pull/154), [#156](https://github.com/fzn0x/nether/pull/156) | Personal access tokens; notes as Markdown, databases and search read, and written live with `If-Match`; signed webhooks to public addresses; both made in the app ([ADRs 0059 and 0060](../adr/0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md)) |
| PDF annotation | [#152](https://github.com/fzn0x/nether/pull/152), [#155](https://github.com/fzn0x/nether/pull/155), [#159](https://github.com/fzn0x/nether/pull/159) | pdf.js, a highlight a callout linking to its passage, PDF++'s colors, the outline and links, embeds drawn once on screen, areas ([ADRs 0061, 0062 and 0067](../adr/0061-pdfs-show-through-pdf-js-and-a-highlight-is-a-callout-that-links-to-its-passage.md)) |
| Share links | [#157](https://github.com/fzn0x/nether/pull/157), [#164](https://github.com/fzn0x/nether/pull/164) | A page shared on its own opens to anyone with its link, in the web app, to read, comment or edit live under a name they give; an expiry and a password ([ADR 0071](../adr/0071-a-share-link-opens-one-shared-page-to-anyone-with-it-through-the-web-app.md)) |
| AI, bring your own | [#158](https://github.com/fzn0x/nether/pull/158), [#163](https://github.com/fzn0x/nether/pull/163), [#166](https://github.com/fzn0x/nether/pull/166), [#167](https://github.com/fzn0x/nether/pull/167), [#170](https://github.com/fzn0x/nether/pull/170) | Providers on the desktop with keys in the keychain, and writing assist; the web app's through its server, keys sealed; asking your notes, each citation checked; search by meaning on the desktop; building with AI, previewed before it is made ([ADRs 0068 to 0070](../adr/0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md), [0074](../adr/0074-search-by-meaning-keeps-passages-vectors-on-the-device-and-loads-them-only-to-search.md), [0075](../adr/0075-asking-your-notes-answers-from-passages-the-vaults-search-finds-each-citation-checked.md), [0078](../adr/0078-building-with-ai-reads-a-checked-json-reply-into-an-import-plan-the-user-previews.md)) |
| The web clipper | [#161](https://github.com/fzn0x/nether/pull/161) | A Manifest V3 extension for Chrome and Firefox that saves a selection or an article to your own server ([ADR 0066](../adr/0066-the-web-clipper-is-a-manifest-v3-extension-that-sends-clips-to-the-users-own-server-alone.md)) |
| Buttons and automations | [#162](https://github.com/fzn0x/nether/pull/162), [#168](https://github.com/fzn0x/nether/pull/168) | Meta Bind's button blocks, asking before they run a command; database triggers, run once where the change was made, a stale rule skipped and shown ([ADR 0072](../adr/0072-buttons-are-meta-bind-button-blocks-and-triggers-are-schema-rules-run-where-the-change-is-made.md)) |
| Publishing | [#165](https://github.com/fzn0x/nether/pull/165), [#169](https://github.com/fzn0x/nether/pull/169) | A page or a folder as a site the server draws with no script, linking only to its own pages; a custom domain its DNS proves, with what search engines read ([ADRs 0076 and 0077](../adr/0076-a-published-site-is-a-note-or-a-folder-drawn-by-the-server-as-it-is-now-linking-only-to-its-own-pages.md)) |
| Fixes | [#134](https://github.com/fzn0x/nether/pull/134), [#171](https://github.com/fzn0x/nether/pull/171), [#172](https://github.com/fzn0x/nether/pull/172) | The repository's lowercase name; a sync test that gave a page's notes three fixed seconds; the perf bench, which a `.tsx` import had stopped |
| The guide | [#135](https://github.com/fzn0x/nether/pull/135), [#136](https://github.com/fzn0x/nether/pull/136) | Installing 0.1.0, and the Awesome MyGo listing |

Most items came in parts, each its own pull request, several built side
by side by agents in worktrees of their own and measured before they
merged. ADR 0073 was kept for the triggers and not needed: the numbers
skip it.

## The gate

- **Third-party plugins run sandboxed.** `apps/desktop/e2e/plugins.spec.ts`
  runs in CI with the desktop app's end-to-end tests. A plugin from a
  vault's folder runs only once this device approves it, in a worker
  inside a sandboxed frame, and is off again when its code changes; it
  draws its panel apart, which the page shows cleaned; and it reads and
  writes notes only through the app, as far as it asked, and never a
  hidden folder.
- **A published site loads on a custom domain.** `apps/web/e2e/web.spec.ts`
  runs in CI with the web app's end-to-end tests, against a real server.
  A page published from the Share dialog claims `docs-<time>.example.test`;
  the check is refused until the TXT record is there, then passes. A
  second Chromium, its resolver mapping the test domain to the server,
  loads the site at the domain: no script, its canonical address and
  description, no policy violations and none of axe's. The domain's
  `robots.txt` names its sitemap, the API answers the site's 404 there,
  and once the domain is given up, Caddy's ask endpoint answers 404 for
  it.

## Measured

On the maintainer's Windows 11 machine, on b8a2018, with the bench on
#172's fix of it, as
[ADR 0017](../adr/0017-measure-performance-before-each-gate-not-in-ci.md)
has the harnesses run before each gate: the reference vault of 50,000
notes, 10,000 for the graph; and for sync, the server in Docker Desktop
with PostgreSQL and Valkey limited to 2 vCPU and 4 GB together.

| Target | Phase 4 | Phase 3 | Limit |
| --- | --- | --- | --- |
| Title search, p95 | 25.7 ms | 28.3 ms | 50 ms |
| Full-text search, p95 | 76.7 ms | 72.8 ms | 300 ms |
| Reading and parsing a note, p95 | 6 ms | 4.4 ms | 100 ms |
| Switching notes, click to frame, p95 | 36.6 ms | 39.5 ms | 100 ms |
| Typing, key to frame, p95 | 16 ms | 16 ms | 16 ms |
| Opening to the last note, median of 5 | 1.38 s | 1.34 s | 1.5 s |
| Idle memory after 60 s, median of 5 | 292 MB | 295.7 MB | 300 MB |
| A note another app writes, in the index, median of 5 | 120 ms | 125 ms | 2 s |
| The graph of 10,000 notes, shown | 348 ms | 679 ms | 3 s |
| The graph, frames while laid out, p95 | 16.8 ms | 16.8 ms | 33.4 ms |
| The graph, frames while zooming, p95 | 16.8 ms | 16.8 ms | 33.4 ms |
| Co-editing, a word to the others' clients, p95, 200 people | 4 ms | 4 ms | 200 ms |

**Opening the app.** The harness's first set of five, run just after the
app was built, read 1.51 s at the median, from 1.41 to 1.71 s, its first
run the new build's first start: over the limit by 7 ms. A second set,
each run alternating with 0.1.0, Phase 3's release, in the same hour, read
1.38 s for this build, from 1.36 to 1.49 s, and 1.36 s for 0.1.0, from
1.33 to 2.10 s, its slowest the first start after its index was put back:
the phase added about 26 ms to opening, and the table gives that set. Idle memory in the same set was 292 MB, against 294.7 MB for 0.1.0;
the headroom found at the phase's start held through its plugins.

**Each change on the way** was measured the same way, five rounds of idle
memory alternating with main before it merged; none showed a rise beyond
the spread of the machine, which ran other builds meanwhile. A change that
adds an index migration needs main's rounds to put the index back as main
reads it, as search by meaning's did.

Sync under load (`pnpm --filter @nether/perf sync --build`): 200 people for
120 s, ten to a note on 20 notes, 7,960 words, at 3 ms at the median, 5 ms
at the 99th percentile and 12 ms at most. The server used 0.07 of a core
on average and 0.18 at most, and 157 MiB of memory at most; PostgreSQL 94
MiB. No note differed between clients and no word was lost. The clients
shared the machine, so the latency leaves out the network.

## Deferred

- **The directory's first entries.** `registry/index.json` is empty until
  a plugin or theme is published from a repository of its own.
- **The web clipper in the browsers' stores**: publishing to the Chrome
  Web Store and Firefox Add-ons needs the maintainer's developer accounts
  ([#160](https://github.com/fzn0x/nether/issues/160)).
- **Search by meaning in the web app**: the server's relay forces each
  provider's chat model, and keeps no embedding model yet.
- **Renaming and deleting a database's properties in the app**: triggers
  have the helpers that follow a rename or a delete, for when the app has
  the commands.
- **Buttons**: inline `BUTTON[id]` buttons and `open`'s new tab.
- **Published sites**: diagrams and plugin blocks show their code; held
  domains are not checked again on a schedule; a site's name and title
  change through the API only.
- **AI for plugins**, as `context.ai` with a permission of its own.
- **The web clipper**: a context menu and a clip in the background, and
  Safari.
- **From earlier phases, still deferred**: a content security policy for
  the desktop page, a screen reader pass by hand, translations, code
  signing of the Windows and macOS builds, and the items Phase 3's report
  lists.

## Known issues

- **Opening the app has 120 ms of margin** at the median, and a new
  build's first start, or the first after a build on the same machine,
  can pass the limit. Phase 5 should start by looking at what the start
  does before the last note shows, before its own features add to it.
- **An older build refuses an index a newer one migrated**: after search
  by meaning's migration, 0.1.0 says a vault's index was written by a
  newer version and opens it only once Nether is updated again. Going back
  is not a path the app offers, but a vault's index cannot be taken back
  to an older version short of deleting it, which reads every note again.
- **Idle memory is 8 MB under its limit** at the median, the five runs
  from 287 to 295 MB.
- The web app's end-to-end server sometimes takes a moment more to listen
  on its control port, and a test that starts in that moment fails once.

## Phase 5

Enterprise features, all free and open source, an admin switch away, as
[Section 3](../requirements.md#editions) has them: single sign-on with
SAML and enforced OpenID Connect, SCIM and LDAP provisioning, audit logs,
data policies, advanced permissions, the admin console, high availability
with the Helm chart, and private AI endpoints enforced; then the mobile
apps, with Capacitor, and the integrations, as plugins. The gate: a
self-hosted install runs air-gapped, with single sign-on and audit logs
on, and no license key.

<p align="center">
  <img src="docs/assets/mark.svg" width="96" height="96" alt="Nether's mark: an N whose diagonal links two notes">
</p>

# Nether: Local-first note taking app that you truly own

[![CI](https://github.com/fzn0x/nether/actions/workflows/ci.yml/badge.svg)](https://github.com/fzn0x/nether/actions/workflows/ci.yml)
[![Docs](https://github.com/fzn0x/nether/actions/workflows/pages.yml/badge.svg)](https://fzn0x.github.io/nether/)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](#license)
[![Listed on Awesome MyGo](https://awesomemygo.dev/badge.svg)](https://awesomemygo.dev/apps/nether)

Nether is self-hostable and local-first note taking app combining both
Notion and Obsidian features. You can import your Obsidian vaults and
Notion exports. Self-hosting is available for enterprise.

> [!NOTE]
> Nether is in early development. [Phase 0](docs/reports/phase-0.md),
> [Phase 1](docs/reports/phase-1.md), [Phase 2](docs/reports/phase-2.md)
> and [Phase 3](docs/reports/phase-3.md) of six are done: a vault of
> Markdown notes with the block editor, links, backlinks, tags, search,
> templates and export; databases with six views, relations, rollups,
> formulas, the graph, themes and importers from Obsidian, Notion, Logseq,
> HTML and CSV; and a server you start with one `docker compose up`, which
> syncs vaults with end-to-end encryption, shares spaces and pages, lets
> people co-edit and comment, keeps history and backups, and serves the web
> app. All within the performance targets on 50,000 notes.
>
> [Version 0.1.0](https://github.com/fzn0x/nether/releases/latest), the
> first public release, has the desktop app for Windows, macOS and Linux
> ([how to install it](https://fzn0x.github.io/nether/install/)) and the
> server's image, `ghcr.io/fzn0x/nether-server`
> ([how to run it](https://fzn0x.github.io/nether/self-hosting/)). Phase 4,
> the platform, is done ([its report](docs/reports/phase-4.md)): the plugin API is done, with Nether's own
> diagrams, panels, canvas, graph and database layouts built on it, and
> plugins from a vault run in a sandbox, with what each device approved, and
> install from its directory; the
> server's [REST API](https://fzn0x.github.io/nether/api/) reads and writes
> notes, databases and search with personal access tokens, and its webhooks
> tell other services when notes change; PDFs are annotated, words or
> areas highlighted in PDF++'s colors and commented on, each highlight
> Markdown that Obsidian reads, and drawn in the notes that embed them;
> [writing assist](https://fzn0x.github.io/nether/ai/) works with an AI
> provider you bring, OpenAI-compatible or Anthropic, its key in the
> desktop's keychain or sealed on your server for the web app; asking
> your notes answers from their passages, each citation a link; building
> with AI makes databases, templates and plans from a description,
> previewed first; the desktop app searches notes by meaning with its
> embedding model; share links
> open a page to anyone with one, with no account, to read, comment on or
> edit; [buttons](https://fzn0x.github.io/nether/buttons/) in a note, as
> Meta Bind writes them, run commands, make notes from templates and set
> properties, and a database's triggers set a row's properties when one
> becomes a value; a page or a folder
> [publishes](https://fzn0x.github.io/nether/publishing/) as a site the
> server draws for anyone, on its own domain if you like, linking only
> between its own pages. Phase 5, enterprise, mobile and scale, is under
> way, 8 of 11 on the
> [roadmap](docs/roadmap.md#phase-5-enterprise-mobile-and-scale): a
> 50,000-note vault opening to its last note about 450 ms sooner; the
> [admin console](https://fzn0x.github.io/nether/admin/), where an
> instance admin turns enterprise features on, sees every workspace, and
> sets how long sessions last and how many sign-in tries there are; AI
> locked to the endpoints the organization approves; single sign-on
> through SAML and OpenID Connect providers, which can be required; data
> policies for public sharing, export, retention and legal hold;
> [provisioning](https://fzn0x.github.io/nether/admin/#provisioning) of
> accounts and groups by SCIM from Okta or Entra ID, or read from Active
> Directory or OpenLDAP;
> [audit logs](https://fzn0x.github.io/nether/admin/#audit-logs) of every
> sign-in, permission change, share, export and deletion, chained so a
> change shows, and sent to a SIEM by syslog or webhook; and
> [high availability](https://fzn0x.github.io/nether/high-availability/),
> several server nodes upgraded one at a time, on Kubernetes with the
> [Helm chart](https://fzn0x.github.io/nether/kubernetes/).

[Documentation](https://fzn0x.github.io/nether/) ·
[Roadmap](docs/roadmap.md) · [Requirements](docs/requirements.md) ·
[Architecture](docs/architecture.md) · [Decisions](docs/adr/)

## What Nether is built to do

- **Keep your notes as files.** Every note is a Markdown file with YAML
  frontmatter in a folder you choose, readable by Obsidian and any text
  editor, and export never loses text.
- **Add structure when you want it.** Any note can have typed properties,
  and notes become databases with table, board, calendar, timeline,
  gallery and list views, relations, rollups and formulas.
- **Work offline.** The desktop app needs no account and no server, and
  edits from several devices merge without conflict dialogs, through
  CRDTs.
- **Run on your server, or on none.** One `docker compose up` brings sync,
  sharing, publishing and real-time co-editing, and end-to-end encryption
  keeps the server from reading your notes.
- **Keep all of it free.** One license, the AGPL-3.0-or-later, covers
  everything, enterprise features such as single sign-on and audit logs
  included: no paid editions, no license keys, no telemetry.
- **Bring your own AI.** Any OpenAI-compatible endpoint, Anthropic, or a
  local model, set up by you, and nothing when none is.

## Roadmap

| Phase | What it delivers | Complete |
| --- | --- | :---: |
| 0. Foundations | Decisions, the repository, CI, the data model, a 50,000-note test vault | ✅ |
| 1. Local-first notes | The desktop app: a vault on disk, the block and Markdown editor, links and backlinks, tags, search, templates, export | ✅ |
| 2. Databases and structure | Databases with six views, relations, rollups, formulas, synced blocks, the graph view, importers from Obsidian and Notion | ✅ |
| 3. Sync and collaboration | The first public release: the server, end-to-end encrypted sync, co-editing, comments, permissions, the web app, the canvas, backups | ✅ |
| 4. Platform | Plugins in a sandbox, bring-your-own AI, publishing, the REST API, the web clipper, automations | ✅ |
| 5. Enterprise, mobile and scale | Single sign-on, SCIM, audit logs, data policies, high availability, the Helm chart, mobile apps | ❌ |

Each phase ends with a gate it must pass before the next one starts; the
[roadmap](docs/roadmap.md) lists them, and the
[requirements](docs/requirements.md) give every feature its acceptance
criteria.

## How it is built

| Part | Built with |
| --- | --- |
| Apps and shared packages | TypeScript, in a pnpm and Turborepo monorepo |
| Editor | TipTap on ProseMirror, with Markdown converted through remark ([ADR 0002](docs/adr/0002-editor-tiptap.md)) |
| Sync | Yjs CRDTs, one document per note, through Hocuspocus ([ADR 0003](docs/adr/0003-sync-yjs-hocuspocus.md)) |
| Desktop app | [MyGO](https://github.com/egoist/mygo) in Go, showing the shared UI in the system's webview ([ADR 0004](docs/adr/0004-desktop-on-mygo.md)) |
| Server | Fastify on Node.js, with PostgreSQL, Redis or Valkey, and S3-compatible storage ([ADR 0005](docs/adr/0005-server-on-fastify.md)) |

The [architecture](docs/architecture.md) shows how the parts fit together.

## Develop

You need Node.js 24, pnpm 10 and, for the desktop app, Go 1.27.

```sh
pnpm install
pnpm test                               # unit tests
pnpm --filter @nether/desktop dev       # the desktop app
pnpm vault:generate                     # the 50,000-note reference vault
```

`docker compose up` in [deploy/docker](deploy/docker/) starts the server
with PostgreSQL and Valkey; the
[self-hosting guide](https://fzn0x.github.io/nether/self-hosting/) goes on
from there. Run from the repository, the server needs PostgreSQL 16 or
newer; [its README](apps/server/README.md) shows how to run it, set it up
and back it up.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: every check, how work is
organized, and how commits are signed off.

## License

Copyright (C) 2026 the Nether contributors.

Nether is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version. See [LICENSE](LICENSE).

The enterprise features in [`enterprise/`](enterprise/) are under the same
license and just as free; [ADR 0001](docs/adr/0001-license-agpl-and-dco.md)
explains why, and why contributions come under the DCO.

The plugin API alone, [`packages/plugin-api`](packages/plugin-api/), is
under the [MIT license](packages/plugin-api/LICENSE), so a plugin may use
any license
([ADR 0055](docs/adr/0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)).

<p align="center">
  <img src="docs/assets/mark.svg" width="96" height="96" alt="Nether's mark: an N whose diagonal links two notes">
</p>

# Nether: Local-first note taking app that you truly own

[![CI](https://github.com/fzn0x/nether/actions/workflows/ci.yml/badge.svg)](https://github.com/fzn0x/nether/actions/workflows/ci.yml)
[![Docs](https://github.com/fzn0x/nether/actions/workflows/pages.yml/badge.svg)](https://fzn0x.github.io/nether/)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](#license)
[![Listed on Awesome MyGo](https://awesomemygo.dev/badge.svg)](https://awesomemygo.dev/apps/nether)

Nether is a self-hostable, local-first note taking app that brings
Notion's databases and collaboration to Obsidian's plain Markdown files.
Your notes stay files in a folder you choose, the app works offline with
no account, and a server of your own adds sync, sharing and the web app.

[Documentation](https://fzn0x.github.io/nether/) ·
[Download](https://github.com/fzn0x/nether/releases/latest) ·
[Self-hosting guide](https://fzn0x.github.io/nether/self-hosting/)

## Features

- **Your notes are files.** Every note is Markdown with YAML frontmatter,
  readable by Obsidian and any editor. Import Obsidian vaults, Notion
  exports, Logseq, HTML and CSV.
- **Write and link.** A block editor that speaks Markdown, `[[wiki links]]`,
  backlinks, tags, templates, daily notes, and a graph of it all.
- **Structure when you want it.** Typed properties, and databases with
  table, board, calendar, timeline, gallery and list views, relations,
  rollups and formulas.
- **Sync on your own server.** End-to-end encrypted sync between devices,
  real-time co-editing, comments, sharing and publishing, from one
  `docker compose up`.
- **Bring your own AI.** Any OpenAI-compatible endpoint, Anthropic or a
  local model. Nothing of AI shows until you set one up.
- **Extend it.** Plugins in a sandbox, a REST API with webhooks, and a web
  clipper for Chrome and Firefox.
- **Free, all of it.** One license covers everything, enterprise features
  such as single sign-on, SCIM and audit logs included. No paid editions,
  no license keys, no telemetry.

## Install

| Platform | Get it |
| --- | --- |
| Windows, macOS and Linux | The installers on the [latest release](https://github.com/fzn0x/nether/releases/latest) |
| Linux, updating itself | `curl -fsSL https://github.com/fzn0x/nether/releases/latest/download/install.sh \| sh` |
| Web | The web app, served by your Nether server |
| Chrome and Firefox | The web clipper's files on the [latest release](https://github.com/fzn0x/nether/releases/latest) |

The [install guide](https://fzn0x.github.io/nether/install/) covers each
system, updates, and the Android and iOS apps, which are in progress.

## Usage

1. **Open a vault.** Start Nether and choose a folder. It becomes your
   vault: every note is a `.md` file in it. An Obsidian vault opens as it
   is.
2. **Write.** Make a note with `Ctrl+N` (`Cmd+N` on macOS) and type.
   Markdown turns into formatting as you type, `/` opens the menu of block
   types, `[[` links another note, and `#` makes a tag.
3. **Find.** `Ctrl+O` opens a note by its name, `Ctrl+Shift+F` searches
   every note, and `Ctrl+P` runs any command.
4. **Add structure.** Give a note properties from its properties panel, or
   run **New database** to collect notes as rows with views of their own.
   `Ctrl+Shift+D` opens today's note.
5. **Bring notes in.** **Import…** in the File menu reads a Notion export,
   a Logseq graph, HTML or CSV into the vault.
6. **Sync.** Run **Servers and signing in**, type your server's address
   and sign in. Your workspaces then sync to every device, and the web app
   at the server's address opens them in a browser.

The [user guide](https://fzn0x.github.io/nether/) goes on from there.

## Self-hosting

The server syncs vaults, shares and publishes pages, and serves the web
app. It runs with Docker Compose, with PostgreSQL and Valkey beside it.
You need [Docker](https://docs.docker.com/get-started/get-docker/) with
Compose 2.24 or later.

### On your own machine

```sh
git clone https://github.com/fzn0x/nether.git
cd nether/deploy/docker
docker compose up -d
```

The server answers at `http://127.0.0.1:3000`, on this machine only. A new
server has no account: its log has a one-time setup code that makes the
first one, the server's admin.

```sh
docker compose logs server | grep "Set it up"
```

Open `http://127.0.0.1:3000` in a browser, or run **Servers and signing
in** in the desktop app with that address, and enter the code, then your
name, email, password and the first workspace's name.

### On a VPS

1. **Point a domain at it.** Add a DNS `A` record, such as
   `nether.example.org`, for the VPS's address, and open ports 80 and 443
   in its firewall.
2. **Install Docker**, as in
   [Docker's guide](https://docs.docker.com/engine/install/) for your
   system.
3. **Get Nether, and choose its database password** before the first
   start:

   ```sh
   git clone https://github.com/fzn0x/nether.git
   cd nether/deploy/docker
   cat > .env <<'EOF'
   NETHER_POSTGRES_PASSWORD=a-long-random-password
   NETHER_PUBLIC_URL=https://nether.example.org
   NETHER_TRUST_PROXY=uniquelocal
   EOF
   docker compose up -d
   ```

   The server stays on `127.0.0.1:3000`, so only the proxy below reaches
   it.
4. **Put it behind HTTPS.** Install [Caddy](https://caddyserver.com/docs/install),
   which fetches its certificate on its own, and give it this `Caddyfile`:

   ```text
   nether.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Reload Caddy. It passes the WebSocket connections that sync uses, too.
5. **Set it up.** Read the setup code with
   `docker compose logs server | grep "Set it up"`, open
   `https://nether.example.org`, and make the admin account. Invite the
   others from **Workspace members**.

To update, run `docker compose pull` and `docker compose up -d` in the
same folder. The [self-hosting guide](https://fzn0x.github.io/nether/self-hosting/)
covers email, storage on S3, backups and restores, single sign-on and
every setting. The [Kubernetes guide](https://fzn0x.github.io/nether/kubernetes/)
has the Helm chart.

## Development

You need Node.js 24, pnpm 10 and, for the desktop app, Go 1.27.

```sh
pnpm install
pnpm test                               # unit tests
pnpm --filter @nether/desktop dev       # the desktop app
```

The server's [README](apps/server/README.md) shows how to run it from the
repository. [CONTRIBUTING.md](CONTRIBUTING.md) has every check, how work
is organized, and how commits are signed off. The
[documentation](https://fzn0x.github.io/nether/) links the roadmap, the
architecture and the design decisions.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md) first, and report security problems
privately, as [SECURITY.md](SECURITY.md) says.

## License

Copyright (C) 2026 the Nether contributors.

Nether is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version. See [LICENSE](LICENSE).

The enterprise features in [`enterprise/`](enterprise/) are under the same
license and just as free. The plugin API,
[`packages/plugin-api`](packages/plugin-api/), is under the
[MIT license](packages/plugin-api/LICENSE), so a plugin may use any
license.

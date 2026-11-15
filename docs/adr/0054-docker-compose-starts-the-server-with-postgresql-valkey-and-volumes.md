# 0054. Docker Compose starts the server with PostgreSQL, Valkey and volumes

- Status: Accepted
- Date: 2026-11-15

## Context

The [requirements](../requirements.md#apps-and-deployment) ask, in
Phase 3, that one `docker compose up` start the server, PostgreSQL, Redis
and storage with sane defaults, the first run making the admin account;
and the Phase 3 gate is that it works.

The server already runs on its own: it migrates its PostgreSQL database
as it starts and writes a setup code to its log until the admin account
exists ([ADR 0031](0031-the-server-keeps-its-data-in-postgresql-and-is-set-up-with-a-code-from-its-log.md)),
keeps attachments on disk or in S3
([ADR 0039](0039-attachments-are-kept-by-their-hash-on-disk-or-in-an-s3-bucket.md)),
backs itself up ([ADR 0052](0052-backups-are-the-server-s-own-files-restored-at-their-schema-then-migrated.md))
and serves the web app
([ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)).
It used no Redis yet: [ADR 0032](0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md)
kept the rate limits in each node's memory until Redis came with Docker
Compose, and [ADR 0035](0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md)
left sharing documents between nodes to the high-availability work of
Phase 5.

## Decision

**One image holds the server and the web app**:
`ghcr.io/fzn0x/nether-server`, built by `deploy/docker/Dockerfile` from
the repository's root. The web app and the server are built once, on the
builder's platform, since their JavaScript is the same everywhere; only the
server's production dependencies are installed for each platform, amd64
and arm64. The workspace's own packages stay folders beside the server, as
in the repository, since Node strips their types only outside
`node_modules`. The server runs as the `node` user on `0.0.0.0:3000`,
keeps its attachments and backups under `/data`, and answers the image's
health check on `/health`. A release tag pushes it as the version, its
minor line and `latest`.

**`deploy/docker/docker-compose.yml`** runs it with three more pieces:

- **PostgreSQL 18**, the newest major version, whose data is a named
  volume at `/var/lib/postgresql`, as its image now keeps it so a later
  `pg_upgrade` can sit beside it. Its password is `nether` unless
  `NETHER_POSTGRES_PASSWORD` says otherwise before it first starts; it is
  reached only inside the project's network.
- **Valkey 9**, the Linux Foundation's BSD-licensed fork of Redis, keeping
  nothing on disk.
- **A named volume for `/data`**: the storage of the requirement. A disk
  is what one machine needs; an S3-compatible bucket is one setting away,
  in the same `.env`.

The server waits for both to be healthy. It pulls the image, or builds it
from the repository when the image cannot be pulled, as before the first
release that publishes it. It is published on `127.0.0.1:3000` unless
`NETHER_PUBLISH` names another address, so a server nobody has put behind
TLS is not on the network by mistake. A `.env` beside the file sets the
rest, and the server reads it too, so every `NETHER_*` setting works there.

**The rate limits count in Redis or Valkey** when `NETHER_REDIS_URL` is
set, through `@fastify/rate-limit`'s Redis store and `ioredis`: a restart
forgets no tries, and nodes count together. That store keys every limit
made outside a route's configuration alike, so each limit now has a name of
its own, and a server refuses two of one name. The server checks Valkey
answers as it starts, and while it cannot reach it the routes with a limit
fail rather than go unlimited; the log says when it is lost and when back.
Presence and sync between nodes stay with the high-availability work.

**CI checks it as an admin would**: it builds the image, starts the
project, sets the server up with the code from its log, keeps an
attachment, loads the web app, finds the limits' counts in Valkey, makes a
backup, then stops and starts it all and finds the account and the
attachment kept. Every server test also counts its limits in a Valkey.

## Alternatives

- **No Redis yet**, until several nodes need one. One node does without,
  but the requirement names it, ADR 0032 planned for it here, and limits
  that a restart resets are weaker against guessing.
- **Redis itself.** Redis 8 is offered under the AGPL-3.0 among other
  licenses, which would do; Valkey is under the BSD license alone, with
  the same protocol. The server speaks to either.
- **MinIO, or another S3 service, in the project.** MinIO stopped
  publishing its community edition's images in October 2025. Garage and
  SeaweedFS run well, but want their keys, and Garage its layout, made by
  hand once they start, and add a service to one machine for nothing a
  volume does not do.
- **`pnpm deploy`** for the production dependencies. It copies workspace
  packages into `node_modules`, where Node will not strip their types.
- **Bundling the server into one file.** It would make the image smaller,
  but adds a build step that the tests, the smoke run and the drill do not
  run.
- **Publishing the port on every address by default.** It is what people
  try first on a server in their network, but it puts a server whose
  sessions travel without TLS on it; one line in `.env` does it.

## Consequences

- `docker compose up` in `deploy/docker` is the way to try and run a
  server; the self-hosting guide starts there.
- A self-hoster backs up the `database` and `files` volumes, or the
  server's own backups, which land in `files`.
- PostgreSQL's major version is fixed by its volume: moving past 18 is a
  `pg_upgrade` or a backup restored into a new volume, documented when it
  comes.
- Revisit Valkey's role with the high-availability work: Hocuspocus's
  Redis extension, the relay's fan-out and presence across nodes.

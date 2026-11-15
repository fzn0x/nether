# Docker

The Nether server's image and a `docker-compose.yml` that starts it with
PostgreSQL, Valkey and a volume for its files
([ADR 0054](../../docs/adr/0054-docker-compose-starts-the-server-with-postgresql-valkey-and-volumes.md)).
The [self-hosting guide](https://fzn0x.github.io/Nether/self-hosting/)
covers setting it up, HTTPS, settings, updates, backups and restoring.

```sh
docker compose up -d                          # in this folder
docker compose logs server | grep "Set it up" # the code that makes the admin account
```

| File | |
| --- | --- |
| `docker-compose.yml` | The server, PostgreSQL 18, Valkey 9, and the `database` and `files` volumes. Settings go in a `.env` beside it, which the server reads too |
| `Dockerfile` | The image, built from the repository's root: `docker build -f deploy/docker/Dockerfile -t nether-server .` |
| `check.mjs` | What CI checks: `node deploy/docker/check.mjs --build` starts a project of its own, sets the server up, restarts it, restores a backup on a new install, then removes it all |

The image is `ghcr.io/fzn0x/nether-server`, for amd64 and arm64, tagged
with each release's version, its minor line, as `0.1`, and `latest`. In
it the server runs as the `node` user from `/app/apps/server`, listens on
port 3000, and keeps attachments in `/data/attachments` and backups in
`/data/backups`. The admin command runs inside it:

```sh
docker compose exec server node dist/admin.js backup /data/backups/now.ndjson.gz
```

Compose's own settings are `NETHER_PUBLISH` (`127.0.0.1:3000`),
`NETHER_VERSION` (`latest`) and `NETHER_POSTGRES_PASSWORD` (`nether`, read
when the database volume is first made).

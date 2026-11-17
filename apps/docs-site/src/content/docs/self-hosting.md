---
title: Run a server
description: How to start a Nether server with Docker Compose, set it up, put it behind HTTPS, configure it, update it, and back it up and restore it.
---

A Nether server syncs vaults between devices, shares them with other
people and serves the web app. One `docker compose up` starts it with
everything it needs: PostgreSQL for its data, Valkey for its rate limits,
and a volume for attachments and backups.

## Start it

You need [Docker](https://docs.docker.com/get-started/get-docker/) with
Docker Compose 2.24 or later. Get the repository, and start the server
from its `deploy/docker` folder:

```sh
git clone https://github.com/fzn0x/nether.git
cd nether/deploy/docker
docker compose up -d
```

Compose pulls the server's image, `ghcr.io/fzn0x/nether-server`, or builds
it from the repository when it cannot pull it. Once a release has
published the image, the `docker-compose.yml` file alone is enough: copy
it into a folder of its own and run `docker compose up -d` there.

The server answers on `http://127.0.0.1:3000`, on this machine only, until
you choose otherwise below.

## Set it up

A new server has no account. Its log has a code that makes the first one,
the server's admin, with a first workspace:

```sh
docker compose logs server | grep "Set it up"
```

Open the server's web app, `http://127.0.0.1:3000`, and choose **Sign
in**; or, in the desktop app, run **Servers and signing in** and type the
server's address. Either asks for the setup code, then your name, email
address, password (twelve characters or more) and the first workspace's
name, and signs you in as the server's admin. Then invite the others from
**Workspace members**, as the [servers guide](../servers/) shows.

The code works once. Only someone who can read the server's log can set it
up, so a new server cannot be claimed by whoever finds it first. Without
an app at hand, `POST /api/setup` does the same:

```sh
curl -X POST http://127.0.0.1:3000/api/setup -H 'content-type: application/json' \
  -d '{"code":"ABCDE-FGHJK-LMNPQ-RSTUV","name":"Ada","email":"ada@example.org",
       "password":"at least twelve characters","workspace":"Team"}'
```

## Put it behind HTTPS

Browsers keep the web app's sessions and run its offline copy only over
HTTPS, and passwords should never cross a network in the clear. Put a
reverse proxy in front of the server, on the same machine. With
[Caddy](https://caddyserver.com), which fetches its certificate on its
own, this `Caddyfile` does it:

```text
nether.example.org {
	reverse_proxy 127.0.0.1:3000
}
```

Then tell the server its address, and to believe the proxy about each
client's address, in a `.env` file beside `docker-compose.yml`:

```sh
NETHER_PUBLIC_URL=https://nether.example.org
NETHER_TRUST_PROXY=uniquelocal
```

`uniquelocal` believes any private address. It is safe while the server is
published on `127.0.0.1` alone, as it is by default, since only the proxy
on this machine reaches it then. The proxy passes WebSocket connections
through, which sync uses, on the same port.

[Published sites](../publishing/) are served at the same address, under
`/p/`, so the proxy needs nothing more for them, and `NETHER_PUBLIC_URL`
is the address the app copies for them.

## Custom domains for published sites

A published site can be [put on a domain of its own](../publishing/#a-custom-domain),
which the person publishing it proves with a TXT record. The server then
answers that domain's requests with the site. The proxy needs a
certificate for each such domain, and Caddy's on-demand TLS gets one the
first time the domain is asked for, after asking the server whether a site
holds it:

```text
{
	on_demand_tls {
		ask http://127.0.0.1:3000/api/sites/domain
	}
}

nether.example.org {
	reverse_proxy 127.0.0.1:3000
}

https:// {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:3000
}
```

Caddy adds `?domain=` and the name to the `ask` address. The server
answers 200 only for a domain a published site holds, so Caddy gets no
certificate for any other name pointed at the machine. The proxy keeps
the request's host, which is how the server knows the site; keep
`NETHER_TRUST_PROXY` set as above.

Each site's owner points their domain at this machine with an `A` or
`CNAME` record, beside the TXT record that proves it. Keep
`NETHER_PUBLIC_URL` set: its host stays the server's own, and no site can
take it.

## Settings

Settings go in the `.env` file beside `docker-compose.yml`, one
`NAME=value` a line, and take effect when the server starts again:
`docker compose up -d`. Three are Compose's own:

| Setting | Default | |
| --- | --- | --- |
| `NETHER_PUBLISH` | `127.0.0.1:3000` | The address and port on this machine the server answers at; `0.0.0.0:3000` for every network it is on |
| `NETHER_VERSION` | `latest` | The image's version, as `0.1.0`, to stay on one release |
| `NETHER_POSTGRES_PASSWORD` | `nether` | PostgreSQL's password, read when its volume is first made; set it before the first start |

The server reads every other setting of the
[server's configuration](https://github.com/fzn0x/nether/tree/main/apps/server#configuration)
from the same file, such as:

- **Email**, for codes that sign in and mentions:
  `NETHER_SMTP_URL=smtp://user:password@mail.example.org:587` and
  `NETHER_MAIL_FROM=Nether <nether@example.org>`.
- **Single sign-on** with your OpenID Connect provider:
  `NETHER_OIDC_ISSUER`, `NETHER_OIDC_CLIENT_ID` and
  `NETHER_OIDC_CLIENT_SECRET`, with `NETHER_PUBLIC_URL` set.
- **Attachments in an S3-compatible bucket** instead of the volume:
  `NETHER_STORAGE=s3` with `NETHER_S3_ENDPOINT`, `NETHER_S3_BUCKET`,
  `NETHER_S3_ACCESS_KEY` and `NETHER_S3_SECRET_KEY`.
- **Scheduled backups**: `NETHER_BACKUP=disk`, below.
- **Webhooks to your own network**: webhooks reach public addresses only.
  `NETHER_WEBHOOK_PRIVATE=192.168.1.20` lets them reach that one, or a
  range as `10.0.0.0/8`, or `on` any; those may use `http://`.
- **AI in the web app**, through the server: `NETHER_SECRET_KEY`, made
  with `openssl rand -base64 32`, lets the server keep providers' keys,
  sealed with it. Keep it safe: a restored backup needs the same one to
  open them. `NETHER_AI_PRIVATE=loopback`, or an address or range, lets
  the providers you set for everyone reach a model on your own network,
  as Ollama beside the server; accounts' own providers reach public
  addresses only. `NETHER_AI=admin` leaves only your providers, and
  `NETHER_AI=off` turns AI through the server off. See [AI](../ai/).

## Update it

```sh
docker compose pull
docker compose up -d
```

The server brings its database to the new version's schema as it starts.
Versions within one major release can be skipped. To choose when to move,
set `NETHER_VERSION` to a release and change it when you are ready.

## Back it up

The server's data is in two volumes: `database`, PostgreSQL's, and
`files`, which holds the attachments and the server's own backups. The
simplest backup is the server's: one file holding the database and every
attachment, made while it runs. Add to `.env`:

```sh
NETHER_BACKUP=disk
```

The server then makes one a day in `/data/backups`, in the `files`
volume, and keeps the newest seven (`NETHER_BACKUP_HOURS` and
`NETHER_BACKUP_KEEP` change that). To make one now, and copy it off this
machine, where a backup belongs:

```sh
docker compose exec server node dist/admin.js backup /data/backups/now.ndjson.gz
docker compose cp server:/data/backups/now.ndjson.gz .
```

## Restore it

A backup restores into a new, empty server, on this machine or another,
from the server that made it or an older one of the same major release.
With the backup in the current folder, as `nether.ndjson.gz`:

```sh
docker compose down --volumes      # only on this machine: deletes the server's data
docker compose run --rm --volume "$PWD:/restore:ro" server \
  node dist/admin.js restore /restore/nether.ndjson.gz
docker compose up -d
```

The first line deletes the database and files volumes, so be sure the
backup is outside them first. The restore refuses a database that has
data, so it never overwrites one by mistake. Accounts, sessions,
workspaces, notes and attachments come back as they were when the backup
was made. CI runs these steps on every change.

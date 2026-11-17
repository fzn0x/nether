---
title: Kubernetes
description: How to run a Nether server on Kubernetes with its Helm chart, one node or several, on your own PostgreSQL and Valkey.
---

The Helm chart runs the Nether server on Kubernetes: one node, or several
with [high availability](../high-availability/). It installs the server
and a Job that migrates its database before each upgrade, and nothing
else: PostgreSQL and Valkey are yours, so their failover and backups are
too. To try Nether first, `bundled.enabled` starts one PostgreSQL and one
Valkey with it, with no failover.

The chart is AGPL-3.0-or-later, as Nether is, and is published with each
release at `oci://ghcr.io/fzn0x/charts/nether`. It needs Kubernetes 1.30
or newer and Helm 3.8 or newer.

## Try it

```sh
helm install nether oci://ghcr.io/fzn0x/charts/nether \
  --set bundled.enabled=true
kubectl port-forward svc/nether 3000:80
```

Open `http://127.0.0.1:3000` and set the server up with the setup code
from the Secret the chart made:

```sh
kubectl get secret nether -o jsonpath='{.data.NETHER_SETUP_CODE}' | base64 -d
```

## Your own PostgreSQL and Valkey

PostgreSQL 16 or newer, with failover, is an operator's job.
[CloudNativePG](https://cloudnative-pg.io) (Apache-2.0) runs one: its
`Cluster` gives a `-rw` Service that always points at the primary, which
is the address Nether needs. For Valkey, the Valkey project's own chart,
`valkey-io/valkey-helm` (BSD-3-Clause), runs it with Sentinel. Redis 8
works as well. Valkey keeps rate limits and the nodes' messages, nothing a
restart loses for good.

Put their addresses, and the server's other secrets, in a Secret of your
own:

```sh
kubectl create secret generic nether-secrets \
  --from-literal=NETHER_DATABASE_URL='postgres://nether:<password>@nether-db-rw:5432/nether' \
  --from-literal=NETHER_REDIS_URL='redis://valkey:6379' \
  --from-literal=NETHER_SECRET_KEY="$(openssl rand -base64 32)" \
  --from-literal=NETHER_SETUP_CODE="$(openssl rand -hex 12)"
```

and name it at install, with the server's address:

```sh
helm install nether oci://ghcr.io/fzn0x/charts/nether \
  --set secrets.existingSecret=nether-secrets \
  --set server.publicUrl=https://nether.example.org
```

The chart reads each secret by the key `secrets.keys` names, the server's
variable by default. Without a Secret of your own, the chart makes one
from `secrets.databaseUrl` and the other values under `secrets`, and makes
up `NETHER_SECRET_KEY` and the setup code once, keeping them across
upgrades. That Secret stays after `helm uninstall`: keep its
`NETHER_SECRET_KEY` with your backups, since a restore needs it.

`deploy/helm/nether/examples` in the repository has whole sets of values:
one node behind ingress-nginx, several nodes with S3 storage and an
autoscaler, and several behind a Gateway API Gateway.

## Attachments

With `storage.kind: disk`, the default, attachments and backups are on a
volume the chart claims, `storage.disk.size` large. Several nodes need
every node to read it: a `ReadWriteMany` volume, as NFS or CephFS give
(`storage.disk.accessModes: [ReadWriteMany]`), or `storage.kind: s3` with
`storage.s3.endpoint`, `bucket` and `region`, and the keys in the Secret.

## Reaching it

The chart makes a Service on port 80, and, when you ask, an Ingress
(`ingress.enabled`) or a Gateway API `HTTPRoute` (`httpRoute.enabled`).
Sessions, sign-ins and documents live in PostgreSQL and Valkey, so no
sticky sessions are needed.

`/api/sync` and `/api/relay` are WebSockets that stay open while an app
is connected. Give them an hour of idle time, and let them through:

| In front of Nether | What to set |
| --- | --- |
| ingress-nginx | `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` and `proxy-send-timeout: "3600"` |
| HAProxy Ingress | `haproxy-ingress.github.io/timeout-tunnel: 1h` |
| A Gateway API Gateway | The route sets no request timeout; check your implementation's own idle timeout, as Envoy Gateway's `ClientTrafficPolicy` |
| A cloud load balancer | Its idle timeout, as AWS ALB's `idle_timeout.timeout_seconds=3600` |

ingress-nginx is retired, with no releases after March 2026; the
examples use it because many clusters still run it. Set
`server.trustProxy` to your controller's addresses, or `uniquelocal`, so
the server reads clients' addresses from `X-Forwarded-For`.

**Published sites on their own domains** need a certificate for each
domain. Put [Caddy](../self-hosting/#custom-domains-for-published-sites)
in front, whose on-demand TLS asks Nether for each domain, or make a
cert-manager `Certificate` for each. The chart makes neither.

## What the chart runs

- **The server**, a Deployment of one node, or two with `ha.enabled`, or
  `replicaCount`; `autoscaling.enabled` scales it on CPU from 2 to 10
  instead. The sync service is the server, so scaling it scales sync.
- **Updates roll one node at a time**: a new node is ready before an old
  one stops, and a PodDisruptionBudget keeps one up while a cluster node
  drains. Nodes spread across cluster nodes and zones.
- **Probes**: liveness at `/health`, which checks nothing else, so a
  database outage restarts no pod; readiness at `/health/ready`, which
  fails while the database does not answer or the node drains.
- **Stopping**: a `preStop` sleep while the endpoints let the pod go, then
  SIGTERM, then `NETHER_DRAIN_SECONDS` of serving, then the sockets close
  and the open documents are stored, within a 45-second grace period.
- **The migration Job** runs `node dist/admin.js migrate` before each
  upgrade, and before the first install with your own PostgreSQL. See
  [Upgrades](../upgrades/).
- **Security**: the image's non-root `node` user, a read-only root file
  system, every capability dropped, and no service account token.

## Settings

Everything the server reads from its environment can be set: the common
ones under `server` (`publicUrl`, `trustProxy`, `logLevel`, `drainSeconds`,
`enterprise`), anything else in `extraEnv`, as
`[{ name: NETHER_MAIL_FROM, value: "Nether <nether@example.org>" }]`.
`values.schema.json` checks values as you install, and the chart refuses
values that cannot run, saying what is missing.

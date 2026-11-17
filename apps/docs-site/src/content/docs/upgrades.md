---
title: Upgrades
description: How a Nether server moves to a new release, with Docker Compose or Kubernetes, and how several nodes upgrade with no downtime.
---

A Nether server brings its database to the new release's schema as it
starts. Any number of releases within one major release can be skipped:
it applies every migration in between, in order, in one transaction, under
a lock every node takes, so one migration that fails changes nothing.

## Docker Compose

```sh
docker compose pull
docker compose up -d
```

To choose when to move, set `NETHER_VERSION` to a release and change it
when you are ready. Back up first: see [Run a server](../self-hosting/#back-it-up).

## Kubernetes

```sh
helm upgrade nether oci://ghcr.io/fzn0x/charts/nether --version <release> \
  --reuse-values
```

Before any pod changes, the chart's Job runs `node dist/admin.js migrate`
with the new release's image. Then the pods roll one at a time: a new one
is ready before an old one stops, and the old one drains first. Several
nodes serve throughout, so nobody is cut off; one node's apps reconnect to
the new one within a second or so. The chart's test upgrades a release
while a client keeps asking, and checks that none of its requests failed.

## Why the old release runs on the new schema

During a rolling upgrade, the previous release's nodes run on the schema
the new release migrated. So a release's migrations only add: tables,
columns that are nullable or have a default, indexes. Renaming or removing
what the previous release reads waits for a later release, and that step
records which release first stopped reading it (`readable_from`). A node
runs on a database a newer release migrated, unless a step since needs a
newer release than its own; then it refuses to start, saying which. So an
old node that restarts in the middle of a rollout starts again.

## Stopping a node

On SIGTERM, as Kubernetes and `docker stop` send it, a node:

1. answers 503 at `/health/ready`, so the load balancer sends it nothing
   new, and closes each connection after its answer;
2. keeps serving for `NETHER_DRAIN_SECONDS`, 5 unless set;
3. closes every sync connection with 1012, "service restart", and stores
   its open notes;
4. finishes the requests under way, and exits, within half a minute.

The Compose file sets `NETHER_DRAIN_SECONDS` to 0, since its one node has
no other to take its traffic. On Kubernetes, the chart's `preStop` sleep
and its 45-second grace period leave room for all of it.

## Going back

A release that only added to the schema can be rolled back: the previous
release runs on its schema. With Helm, `helm rollback nether`. To go back
past a release that removed something, restore the backup made before the
upgrade, with the release that made it: see
[Run a server](../self-hosting/#restore-it).

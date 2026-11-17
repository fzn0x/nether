---
title: High availability
description: How several Nether server nodes share one server, what they need, what a node's failure costs, and what to do when one fails.
---

A Nether server can run as several nodes behind a load balancer, so it
keeps serving when a node, a machine or a zone fails, and so it upgrades
with no downtime. It is the `ha` enterprise feature: free and open source,
like the rest of Nether, and set by the server's environment alone,
`NETHER_ENTERPRISE_HA=on` on every node, read as each node starts. The
[Helm chart](../kubernetes/) sets it with `ha.enabled`.

## What it needs

- **One PostgreSQL**, 16 or newer, every node uses, with failover of its
  own, as [CloudNativePG](https://cloudnative-pg.io) gives on Kubernetes.
- **One Valkey** (or Redis), `NETHER_REDIS_URL`, every node reaches.
- **Attachments every node reads**: S3-compatible storage, or one volume
  every node mounts, with `NETHER_STORAGE_SHARED=on`.
- **`NETHER_SETUP_CODE`** while the server has no account, so every node
  takes the same code.

A node with `NETHER_ENTERPRISE_HA=on` that lacks one of these stops at
startup, saying which.

## How the nodes share

- **Open notes are shared through Valkey**: two people on two nodes see
  each other's edits as they type, and who else is in a note.
- **Every store merges** with what is stored, so two nodes, or an old and
  a new one during an upgrade, never undo each other's edits.
- **Order comes from PostgreSQL.** A workspace's changes are numbered in
  the order they commit, so a device that catches up misses nothing, on
  any node. Encrypted workspaces' updates reach every node's devices in
  that order.
- **Messages between nodes go through Valkey**, such as "close this
  person's connections" when someone is removed from a workspace. A node
  that loses Valkey and gets it back closes its connections, spread over
  five seconds, so each app connects again with its access as it is now.
- **Hourly work runs once**, claimed in PostgreSQL, whichever node takes it.
- **No sticky sessions**: any node serves any request.

The admin console's **Nodes** section lists the nodes that wrote their
heartbeat in the last two minutes. A node without `ha` that sees another
one says so in its log, since such nodes do not share open notes.

## What a node's failure costs

Nothing an app has. Each app keeps its own edits and sends the server what
it lacks when it connects again, so edits a node held but had not stored
yet arrive through another node. An encrypted push a failed node never
answered is sent again. An API write answers only once it is stored.

The apps connect again on their own, within a second or so, backing off
while no node answers, and the load balancer sends them to a node that
is up. A test kills a node mid-edit and stops another, and checks that no
edit and no push is lost, on every change to the server.

## When Valkey is away

The rate limits answer 503 to the routes that have one, as signing in
does, and open notes stop crossing nodes: two people on two nodes see each
other's edits only once they are stored, a few seconds later. When Valkey
is back, every node closes its connections, spread out, and the apps sync
again. Nothing is lost. `/health/ready` reports Valkey but stays ready:
taking every node out at once would help no one.

## Failover runbook

**A node stopped answering.** The load balancer takes it out when its
readiness fails; Kubernetes restarts it when `/health` fails. Nothing to
do. Its log, from before it stopped, says why.

**PostgreSQL fails over.** Each node's queries fail until the new primary
takes the address, and readiness answers 503 meanwhile. The apps keep
their edits and send them again once the server answers. Check that the
database address points at the primary (`-rw` in CloudNativePG), not at
one instance.

**Valkey restarts or fails over.** See above: limits answer 503 until it
is back, then the nodes close their connections and the apps sync again.
Check `NETHER_REDIS_URL` names the address that follows the primary, as
Sentinel's or your service's.

**Every node fails at startup with "NETHER_ENTERPRISE_HA is on, and
several nodes need ...".** Set what it names: Valkey's address, shared
attachments, or the setup code before the first account.

**People do not see each other's edits until they are stored.** Some
nodes run without `ha`, or cannot reach Valkey: check every node's
`NETHER_ENTERPRISE_HA` and `NETHER_REDIS_URL`, and the console's Nodes
section, which lists every node running.

**A node was killed during an upgrade.** Start it again; migrations run
under a lock, once, and a node of the previous release runs on the new
schema. See [Upgrades](../upgrades/).

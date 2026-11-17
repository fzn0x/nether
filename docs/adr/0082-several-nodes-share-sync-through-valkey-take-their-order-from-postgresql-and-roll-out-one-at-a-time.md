# 0082. Several nodes share sync through Valkey, take their order from PostgreSQL, and roll out one at a time

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for **high availability**, the `ha` enterprise feature: "Multi-node
deployment with documented failover; zero-downtime upgrades". They also
ask, under [Kubernetes](../requirements.md#apps-and-deployment), for an
"Official Helm chart with horizontal scaling of the sync service". The
roadmap's Phase 5 item joins them: "several server nodes with documented
failover and zero-downtime upgrades, the sync service scaled out".

Today one server process holds state that other nodes would not see:

| State | Where it is | With several nodes |
| --- | --- | --- |
| Open Hocuspocus documents, their unstored edits and awareness | Each node's memory ([ADR 0035](0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md)) | Clients on two nodes would not see each other's edits until a store |
| The encrypted relay's subscribers ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)) | Each node's memory | A push reaches only its own node's subscribers |
| The relay's per-document turns (#176) and the API's per-workspace turns for making notes | Each node's memory | Two nodes could number or create at once again |
| `disconnect(userId)`, which closes an account's sockets | Each node's own sockets | A removed member could keep syncing through another node |
| Hourly purges, scheduled backups, the webhooks worker | Timers on each node | Run on every node |
| The first-run setup code | Written to each node's log | Each node would ask for a different code |
| Attachments on disk | Each node's volume | A file sent to one node is missing on the others |

Some of it is already cluster-safe: sessions, share-link visits and OIDC
flows are in PostgreSQL; the rate limits count in Redis or Valkey when
`NETHER_REDIS_URL` is set ([ADR 0054](0054-docker-compose-starts-the-server-with-postgresql-valkey-and-volumes.md));
the webhooks worker claims each webhook for a minute with `FOR UPDATE SKIP
LOCKED`; a backup is claimed in `backup_state` by one node per interval;
the search backfill takes its pending row in a transaction; and the
enterprise switches are read again every five seconds
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).

Issue #177 adds two windows, both from numbers drawn with
`nextval('document_seq')` and committed out of order on two connections:

- **The catch-up listing**, `GET .../documents?since=`, can read past a
  store still committing: it lists B at 11 while A at 10 commits later,
  and the device keeps 11.
- **The relay's per-document turns**, which #176 added so a client told a
  number has been sent every earlier update, hold only within one
  process.

Two drafts in review add work of their own: single sign-on (ADR 0080
draft) reads each SAML provider's metadata again every day and closes an
account's sync connections through `disconnect`; audit (ADR 0081 draft)
purges every hour, appends a checkpoint every hour, chains its rows under
an advisory lock, and appends `audit.key_changed` at startup.

## Decision

### What is core and what is `ha`

**What makes several nodes correct lives in core; what needs Valkey is
the `ha` module.**

- **Core**, in `apps/server`, with a single node in mind as well: numbers
  in commit order, stores that merge, the relay reading in that order,
  locks and job claims in PostgreSQL, the readiness probe, draining, and
  the migration policy. A single node gains from each: a rolling restart
  already runs two pods for a moment.
- **Core defines a cluster bus**, with an in-process implementation: a
  topic, a message, and handlers. It carries hints, never data a reader
  depends on.
- **`enterprise/ha`** gives the bus over Valkey, installs Hocuspocus's
  Redis extension, and checks at startup that the deployment can run
  several nodes. Core never imports it, as ADR 0079 has it.

### Hocuspocus documents across nodes

**Hocuspocus's own Redis extension shares documents and awareness.**

| | `@hocuspocus/extension-redis` 4.8.0 |
| --- | --- |
| License | MIT |
| Maintenance | The Hocuspocus team at Tiptap; 4.4.0 to 4.8.0 between 2026-07-13 and 2026-10-28 |
| Needs | `@hocuspocus/server` ^4.8.0, `ioredis` ~5.6.1, `@sesamecare-oss/redlock` ^1.4.0, `kleur` |
| What it sends | Each document's sync messages and awareness over a pub/sub channel per document, and stateless broadcasts |
| On load | When another node has the document open, waits up to 1 s (`awaitInitialSyncTimeout`) for its state, so a direct connection sees edits not stored yet |
| On store | Takes a Redlock lock per document unless `lockTimeout` is 0 |

- **The server and provider move to Hocuspocus 4.8**, which the extension
  needs; 4.8.0 is older than pnpm's seven-day `minimumReleaseAge`.
- **Its `ioredis` is 5.6**, beside the server's 6.0 for the limits. The
  extension makes its own two connections from `NETHER_REDIS_URL`; giving
  it ours would mean its types and ours disagree.
- **`@sesamecare-oss/redlock`'s `package.json` says `UNLICENSED`**, but
  the package ships an MIT `LICENSE.md` (Mike Marcacci's, as the original
  `redlock`). The license scan's `reviewed` list records that, as it does
  for `khroma`.
- **Stores never need its lock.** We set `lockTimeout: 0`, as its own
  documentation offers "for persistence that cannot conflict across
  instances": our stores merge, below.
- **The "stored" notices cross nodes.** They are stateless broadcasts on
  the vault document, which the extension publishes.
- **The API reads through a direct connection** under `ha`. `state()`
  read the open copy or else the stored state; on another node, the
  stored state could be up to `maxDebounce`, 10 s, behind. A direct
  connection skips the extension's wait when no other node has the
  document open.

**Stores merge with what is stored, when it changed.** Today the state is
overwritten, and a store from a copy that missed an edit removes it from
the database until the next store. Two nodes, or an old pod's last store
during a rolling restart, could do that.

- **Each node remembers the number it last read or stored** for each
  document it has open.
- **A store locks the row reading its number alone**, which does not
  read the state out of its TOAST storage.
- **If the number is still the one this node knows**, no one else stored
  it since, and the store writes as today: a single node's stores cost
  what they cost now.
- **If not**, it reads the stored state, applies it and its own to one
  `Y.Doc`, and writes that.
- **What compares the state a store replaces with the new one** compares
  the state that was stored with the merged result: webhooks' outbox
  (ADR 0060), the search index's paths, and audit's `note.deleted` (ADR
  0081 draft).

**Not PostgreSQL's LISTEN/NOTIFY for documents.** NOTIFY is
transactional and needs no other service, but a payload has 8000 bytes
at most, every keystroke and cursor would go through the primary's
notification queue, and each node needs a connection of its own that
PgBouncer's transaction pooling cannot give. No Hocuspocus extension uses
it. Valkey is already in the Compose file for the limits, and is what
the extension speaks.

### Numbers in commit order, and #177's listing

**A workspace's stores take their numbers in the order they commit.**
Each store, of a document or of an encrypted update, takes
`pg_advisory_xact_lock` on a key for its workspace, then draws
`nextval('document_seq')`, and commits.

- **The lock is the last lock a transaction takes.** Its row locks come
  before it, and none after, so two transactions cannot wait on each
  other across it.
- **A transaction that stores several documents takes it once, at the
  end**, then draws all its numbers, then commits.

- A transaction holds the lock from the draw to its commit,
  milliseconds. The next store of that workspace waits for it, so a
  reader that sees a number sees every smaller number of that workspace.
- The catch-up listing then cannot read past a store still committing;
  this closes #177's first half on one node or many.
- The key is a 64-bit hash of `nether.seq.` and the workspace ID. Two
  workspaces whose keys collide only take turns.
- No schema change: the sequence stays, and every cursor a device keeps
  stays valid.

### The encrypted relay across nodes, and #177's turns

**The database gives the relay its order; the bus only says when to
look.** This replaces #176's in-process turns.

- **A push** stores its update in a transaction, numbered as above.
  After the commit, its node publishes a hint, `relay.<workspace>`, and
  reads.
- **Each node reads each workspace it has relay sockets for**, with a
  watermark: on a hint, on a subscribe, and every five seconds while it
  has subscribers, it selects that workspace's updates after the
  watermark, in order. It sends each to its own subscribers of that
  document, and a note's "stored" notice to its own vault subscribers.
  Numbers in commit order make what it reads a whole prefix, so it never
  skips one.
- **The pusher is answered after its node has read past its number.** By
  then its node has sent the pusher every update numbered before it, the
  property #176 gave one node. Each device keeps that number as how far
  it has read, as today.
- **A lost hint costs latency, not data.** A node that missed one reads
  within five seconds.
- **A subscribe** reads the document's updates after the client's
  cursor, as today, and joins the node's reader for what comes after.
- **The protocol and the clients do not change.**

**The API's turns move to PostgreSQL.** Making a note checks its path and
then edits the vault document; two nodes could both find the path free.
`Database` gains `lock(key, work)`: a session advisory lock on a
connection taken from the pool for the work's length, and an in-process
queue on PGlite.

### Work that runs once

**A job is claimed in the database by the node that runs it.** Core
gives `every(name, period, work)`:

- A `cluster_jobs` row per job holds when it last started. A node runs
  the job when an update finds that time older than the period, as
  `backup_state` does for backups today.
- Each node checks its jobs every minute, at a random second.
- A job that fails clears its claim, so the next check tries again.
- `EnterpriseServices` gains `every`, so modules use the same claims.

| Work | Today | With several nodes |
| --- | --- | --- |
| Purging versions, notifications and deliveries | A timer on each node | `every("purge", 1 hour)` |
| Scheduled backups | Claimed in `backup_state` | Unchanged; needs shared attachments, below |
| Webhooks worker | Claims each webhook for a minute with `SKIP LOCKED` | Unchanged, on every node |
| Search backfill | Takes its pending row at start | Unchanged |
| SSO: each SAML provider's metadata | Daily (ADR 0080 draft) | `every("sso.metadata", 1 day)` |
| Audit: purge and checkpoint | Hourly, "one node, under its own lock" (ADR 0081 draft) | `every("audit.purge", 1 hour)` and `every("audit.checkpoint", 1 hour)` |
| Audit: the SIEM sender | Claims each destination with `SKIP LOCKED` | Unchanged |
| Audit: `audit.key_changed` at startup | Each node that starts | Appended under the chain's lock, after reading the last fingerprint again, so two nodes starting at once append it once |

**Each node writes a heartbeat**, `cluster_nodes`, every 30 seconds:
its name and when it started. A route for instance admins lists them,
and the console's page has a short Nodes section. A node with `ha` off
that sees another node for more than two minutes logs an error, so three
replicas without `ha` do not pass unnoticed. A rolling restart overlaps
for less.

### Closing an account's sockets on every node

**`disconnect(userId)` goes through the bus.** Every node closes its own
Hocuspocus and relay sockets of that account, or of that share-link
visitor.

- The callers move to it: removing a member, changing a unit's people,
  revoking a link, and SSO's enforcement through
  `EnterpriseServices.disconnect`, which the bus backs.
- **Its shape stays `(userId: string) => void`**, which
  `EnterpriseServices`, the services every module is given, carries.
  Local sockets close at once; the publish is fire and forget, its errors
  logged; callers never wait for it.
- **Pub/sub can drop a message while a node is away from Valkey.** A node
  whose bus connection comes back closes every socket it has, and each
  client signs in again with its access as it is now. The closes are
  spread over a few seconds at random, so the clients of every node do
  not reconnect in the same instant, and the node logs that it closed
  them and why.

### Upgrades with no downtime

**Migrations expand, and contract a release later.**

- A release's migrations only add: tables, columns with a default or
  nullable, indexes, functions. The previous release's server must run
  on the new schema, as it will during a rolling upgrade.
- Renames, drops and narrowed types are contract steps. They come in a
  later release than the one that stopped using what they remove.
- A large backfill runs in batches outside the migration's transaction.
- **The database says which servers may run on it.**
  `schema_migrations` gains `readable_from`: an expand step writes none;
  a contract step writes the schema version of the first release that no
  longer needed what it removes. A server starts on a newer database
  when its own schema version is at least the highest `readable_from`.
  Today it refuses any newer database (`NewerDatabase`), so an old pod
  that restarts during a rollout would fail.
- **The chart migrates before it rolls.** A pre-install and pre-upgrade
  Job runs a new `admin migrate` command. Pods still migrate at start
  under the existing advisory lock, which then has nothing left to do.

**A node drains before it stops.** On SIGTERM it:

1. answers 503 at its readiness probe;
2. waits `NETHER_DRAIN_SECONDS`, 5 by default, while the load balancer
   takes it out;
3. stores its open documents and closes its sockets with code 1012,
   "service restart";
4. finishes the requests under way, and exits within the pod's grace
   period, 45 s in the chart.

Clients reconnect on their own, within about a second and backing off
while no node answers, through the load balancer to another node.

**Probes:**

- **`/health`**, liveness: the process answers. It checks nothing else,
  so a database outage does not restart every pod.
- **`/health/ready`**, new, readiness: the database answers `SELECT 1`,
  and the node is not draining. Valkey's state is in its answer but does
  not fail it: when Valkey is away, every node would fail together, and
  taking them all out of service helps no one.

**No sticky sessions.** Sessions, visits and sign-in flows are in
PostgreSQL, limits in Valkey, documents shared through the extension,
and a relay socket keeps nothing a new one cannot ask for again.

**What a node's crash loses: nothing a client has.** Every client keeps
its own edits and sends what the server lacks when it syncs again; a
relay push not answered is sent again in the next round; an API write
answers only after its edit is stored.

### The `ha` switch

**`ha` is a deployment fact, pinned by the environment only.**

- `NETHER_ENTERPRISE_HA=on` makes a node one of several. Unset or `off`,
  it is off, and the console cannot turn it on: it shows "set by
  `NETHER_ENTERPRISE_HA`, read at startup".
- This amends ADR 0079 for `ha` alone: "Unset, the console decides" does
  not apply, and `EnterpriseSwitches.set("ha")` is refused.
- **A module may now act at startup.** `EnterpriseModule` gains
  `startup(services)`, run once before the routes when its feature is on
  at startup. The `ha` module returns the Valkey bus and the Hocuspocus
  extension from it.
- **At startup, `ha` on requires:**
  - `NETHER_REDIS_URL`;
  - attachments in S3-compatible storage, or `NETHER_STORAGE_SHARED=on`
    to say the disk path is one volume every node mounts;
  - `NETHER_SETUP_CODE` while the server has no account, so every node
    accepts the same code. It is new, and a single node may use it too.

  Missing one stops the node, saying which.

### The Helm chart

**`deploy/helm/nether`: the server, its migration Job, and nothing else
by default.**

- **The server** is a Deployment:
  - 2 replicas with `ha.enabled`, else 1;
  - rolling updates with `maxUnavailable: 0` and `maxSurge: 1`;
  - a PodDisruptionBudget, and spread across nodes and zones;
  - a `preStop` sleep and a grace period of 45 s;
  - the three probes;
  - non-root as the image's `node` user, no service account token, and
    every capability dropped.
  - An optional HorizontalPodAutoscaler scales it on CPU, 2 to 10. The
    sync service is the server, so scaling the server scales sync.
- **Settings and secrets.** Settings come from values. Secrets come from
  an `existingSecret` with named keys, or from a Secret the chart makes:
  the database and Valkey addresses, `NETHER_SECRET_KEY`, the setup code,
  and the S3, SMTP and OIDC credentials. A Secret the chart makes keeps
  its generated key and code across upgrades by looking up the one there.
- **PostgreSQL and Valkey are external by default.** The chart does not
  depend on Bitnami's charts. On 2025-08-28 Bitnami moved its public
  images to `bitnamilegacy`, which gets no updates, and its charts "will
  not work out-of-the-box" without other images.
  - The guide shows CloudNativePG, Apache-2.0, 1.30.1 of 2026-09-23, for
    PostgreSQL with failover.
  - It shows the Valkey project's own chart, `valkey-io/valkey-helm`
    1.0.0, BSD-3-Clause, with `valkey/valkey:9.1.3` and Sentinel.
  - `bundled.enabled` starts one PostgreSQL (`postgres:18-alpine`) and
    one Valkey (`valkey/valkey:9-alpine`) from the chart's own templates,
    for trying it and for the chart's test, with no failover. It is off
    by default.
- **Licenses.** The chart is AGPL-3.0-or-later with the repository. The
  images it names are the server's (AGPL-3.0-or-later), PostgreSQL's
  (the PostgreSQL License) and Valkey's (BSD-3-Clause). Redis 8, under
  the AGPLv3 among its three licenses, works as well; the guide names
  Valkey.
- **Ingress.**
  - The chart offers an Ingress or a Gateway API `HTTPRoute`. Gateway
    API 1.7.0 is current, and ingress-nginx, which Kubernetes retires
    with "no further releases" after March 2026, is not assumed.
  - `/api/sync` and `/api/relay` are WebSockets: the guide gives each
    common controller's idle timeout, an hour, and no affinity.
  - Custom domains for published sites
    ([ADR 0077](0077-a-site-holds-a-custom-domain-its-dns-proves-and-tells-search-engines-what-each-page-is.md))
    need a certificate per domain. The guide shows Caddy in front, with
    its `ask`, or a cert-manager Certificate per domain. The chart makes
    neither.
- **Publishing.** The chart is pushed with each release as an OCI
  artifact to `oci://ghcr.io/fzn0x/charts/nether`.

### Testing

- **Two nodes in one process.** Two `buildApp`s share one database and
  the in-process bus. They run locally on PGlite, and test:
  - numbers in commit order, with a database that answers out of order,
    as #176's test does, and a transaction storing two documents against
    another storing one of them;
  - the relay across nodes, and `disconnect` on both;
  - job claims, and the API's lock.
- **The same tests over Valkey.** When `NETHER_TEST_REDIS_URL` and
  `NETHER_TEST_DATABASE_URL` are set, as in CI, they run with the
  extension and the Valkey bus.
- **Failover with two processes.**
  - Two servers share PostgreSQL and Valkey, behind a small TCP proxy in
    the test that sends each connection to a node that is up.
  - Two sync clients, one through each node, edit a plain and an
    encrypted note. The test kills one node with SIGKILL, then stops one
    with SIGTERM, and checks that the edits arrive and none is lost.
  - It runs in CI on its services, and locally with Docker.
- **The chart.** `helm lint`, `helm template` for each values example,
  and kubeconform on the output, on every change to `deploy/helm`.
- **On kind, in a workflow of its own.** It runs on changes to the chart
  or the server, and nightly:
  - build the image and load it;
  - install with `bundled.enabled` and two replicas, and wait for
    readiness;
  - sync through the Service, delete a pod, and check that sync goes on;
  - `helm upgrade` with a changed value while a client syncs, and check
    that none of its requests failed.

  Docker 29.9.2 runs on the maintainer's machine, so kind and the
  failover test run there too.

### Parts

Each from `origin/main`, one PR each:

1. **Order.** Numbers in commit order; the relay's ordered reads in
   place of #176's turns, with the in-process bus. Closes #177's first
   half, and its second for one process.
2. **Merging and claims.** Stores that merge when the row changed, with
   their cost measured on the reference vault's largest vault document;
   `Database.lock` for the API's turns; `cluster_jobs` and
   `EnterpriseServices.every`, with the purges moved onto it; heartbeats,
   their route and the console's Nodes section.
3. **The bus.** `EnterpriseServices.disconnect` through it, with its
   callers; closing every socket, spread out, when the bus reconnects;
   `NETHER_SETUP_CODE`.
4. **Upgrades.** `readable_from` and the policy in the contributing
   guide; `admin migrate`; `/health/ready`; draining on SIGTERM.
5. **`enterprise/ha`.**
   - The Valkey bus and the Hocuspocus extension, with Hocuspocus 4.8;
     `EnterpriseModule.startup`; the environment-only switch and its
     startup checks; the API's reads through a direct connection.
   - The two-node tests over Valkey, and the failover test. Closes #177.
6. **The chart.**
   - The chart and its values schema.
   - The guides: Kubernetes, high availability with a failover runbook,
     and upgrades.
   - The chart's checks in CI, and the kind workflow. It ticks the
     roadmap item.

## Alternatives

- **PostgreSQL LISTEN/NOTIFY as the bus.** It would deliver the relay's
  hints in commit order with no other service. But Hocuspocus needs
  Valkey anyway, and two buses are two things to run. The relay's
  correctness does not rest on its bus.
- **Each node fans out the relay's updates through Valkey with their
  data.** Messages from two publishers can arrive in either order, and
  one lost in a crash is gone. Ordering them by number at each receiver
  would need gapless numbers and a way to fill gaps from the database,
  which reading from the database already is.
- **Clients keep only the numbers they were sent as their cursor**, not
  their own push's. It would cost every device its own updates once a
  round. It would also protect only updated clients, while the server's
  order protects every client.
- **A per-workspace counter row** for commit order. It gives gapless
  numbers, but needs a migration that seeds each counter, and the lock
  it takes is the same as an advisory lock's.
- **Redlock for jobs and the API's turns.** It would need Valkey even on
  one node, and the claims belong with the data they guard.
- **`ha` as a console switch.** Turning it on would need a bus to exist
  before it is chosen, and a restart of every node. It describes the
  deployment, as the database address does.
- **Sticky sessions.** They would hide the cross-node paths that a
  failover takes anyway, until the day a node dies.
- **Bitnami's PostgreSQL and Redis subcharts.** They no longer work out
  of the box since August 2025.
- **One subchart for PostgreSQL.** A database with failover is an
  operator's job; CloudNativePG does it, and a subchart would pin us to
  its chart's releases.

## Consequences

- A workspace's stores take turns for the moment from their number to
  their commit. One workspace commits at most a few hundred stores a
  second, far above 200 active users' needs. Different workspaces do not
  wait for each other.
- A store reads the stored state only when another node or process
  stored the document since this one last did. With several nodes each
  node holding a document stores it, so stores grow with the number of
  nodes holding a document, not with its users.
- Each relay push makes every node with subscribers in that workspace
  read the new rows, one indexed query each.
- `Database` gains `lock`, `EnterpriseModule` gains `startup`, and
  `EnterpriseServices` gains `every`; its `disconnect` goes through the
  bus. The SSO and audit modules use `every`.
- The audit draft's startup `audit.key_changed` must be appended under
  its chain's lock after reading the last fingerprint again.
- Contract migrations wait a release, and each says which schema version
  stopped needing what it removes.
- `NETHER_SETUP_CODE`, `NETHER_DRAIN_SECONDS`, `NETHER_STORAGE_SHARED`
  and `/health/ready` are new; nothing existing changes meaning.
- Valkey becomes a dependency of `ha`. While it is away, the limits
  answer 503 (ADR 0054), and documents stop crossing nodes until it is
  back. Nodes then close their sockets, and the clients, which kept
  their edits, sync again.

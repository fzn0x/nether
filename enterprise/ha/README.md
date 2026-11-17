# Enterprise: High availability

Several nodes of one server behind a load balancer, with documented
failover and upgrades that need no downtime
([ADR 0082](../../docs/adr/0082-several-nodes-share-sync-through-valkey-take-their-order-from-postgresql-and-roll-out-one-at-a-time.md)).

The environment alone turns it on: `NETHER_ENTERPRISE_HA=on` on every
node, read as the node starts. The module then checks that the deployment
can run several nodes, and stops the node, saying what is missing, unless
it has:

- `NETHER_REDIS_URL`, the Valkey every node shares;
- attachments every node reads: `NETHER_STORAGE=s3`, or
  `NETHER_STORAGE_SHARED=on` when `NETHER_STORAGE_PATH` is one volume every
  node mounts;
- `NETHER_SETUP_CODE` while the server has no account.

It gives the server:

- **a bus over Valkey** (`src/bus.ts`), each topic a pub/sub channel under
  `nether:bus:`, for the encrypted relay's hints and the closes of an
  account's sockets. When its connection comes back after it was lost, the
  node closes every socket it has, spread over five seconds;
- **Hocuspocus's Redis extension**, `@hocuspocus/extension-redis`, which
  shares each open document and its awareness under `nether:sync`. Stores
  merge with what is stored, so they take no lock (`lockTimeout: 0`);
- **reads through Hocuspocus**: the API reads a document through a
  connection of its own, which takes another node's open copy.

Its tests run two nodes in one process over one database and one Valkey,
when `NETHER_TEST_REDIS_URL` names one, as CI does.

Roadmap: Phase 5, enterprise, mobile and scale.

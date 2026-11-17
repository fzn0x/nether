# Enterprise: Audit logs

Every sign-in, permission change, share, export and deletion, logged and
searchable, and exported to a SIEM through syslog or a webhook
([ADR 0081](../../docs/adr/0081-audit-events-come-from-a-hook-the-server-emits-kept-in-a-chained-append-only-log-and-sent-to-a-siem.md)).

- `src/log.ts`: the log's rows, each written as the next in the chain.
- `src/chain.ts`: the chain's hashes, under a key from `NETHER_SECRET_KEY`.
- `src/check.ts`: checking the chain from the oldest row kept.
- `src/retention.ts`: how long the log keeps its events, and the hourly
  purge and checkpoint; the purge records what a SIEM never got.
- `src/search.ts`: searching the log, and the groups of actions.
- `src/destinations.ts`: where the log is sent, from the console or the
  environment, a webhook's secret sealed with `NETHER_SECRET_KEY`.
- `src/syslog.ts`: RFC 5424 messages over TLS, framed as RFC 5425 has it.
- `src/export.ts`: sending each destination the events after its cursor,
  tried again until it takes them.
- `src/siem.ts`: the console's destinations routes, and the worker that
  sends.
- `src/index.ts`: the module, its routes and its upkeep.

Roadmap: Phase 5, enterprise, mobile and scale.

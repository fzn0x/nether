# Enterprise: Policies

The policies an organization sets for every workspace on its server, free
and open source as every enterprise feature is, and off until an instance
admin turns **Data policies** on (ADR 0079).

- **Approved AI endpoints** (ADR 0086): the only addresses Nether's apps
  send AI requests to, set in the console or by `NETHER_AI_ENDPOINTS`. Core
  keeps the list and enforces it in the relay and `/api/me`; this module
  gives the console its routes, `GET` and `PUT /api/admin/ai-endpoints`.

Still to come here: retention rules, legal hold, limits on public sharing
and export per workspace, custom roles, group-based access and
domain-restricted sharing.

Roadmap: Phase 5, enterprise, mobile and scale.

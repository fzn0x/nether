# Enterprise: Policies

The policies an organization sets for every workspace on its server, free
and open source as every enterprise feature is, and off until an instance
admin turns **Data policies** on (ADR 0079).

- **Approved AI endpoints** (ADR 0086): the only addresses Nether's apps
  send AI requests to, set in the console or by `NETHER_AI_ENDPOINTS`. Core
  keeps the list and enforces it in the relay and `/api/me`; this module
  gives the console its routes, `GET` and `PUT /api/admin/ai-endpoints`.
- **Data policies** (ADR 0088): for every workspace, or one set apart,
  whether share links open at any level, only view, or not at all, whether
  its published sites are served, and whether the public API gives its
  text. Core keeps them in `instance_settings` and `workspace_policies` and
  enforces them; this module gives the console its routes under
  `/api/admin/data-policies`.

Still to come here: the apps' export kept to the policy, retention rules,
legal hold, custom roles, group-based access and domain-restricted
sharing.

Roadmap: Phase 5, enterprise, mobile and scale.

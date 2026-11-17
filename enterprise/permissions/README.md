# Enterprise: Permissions

Advanced permissions, free and open source as every enterprise feature is,
and off until an instance admin turns **Advanced permissions** on, or
`NETHER_ENTERPRISE_PERMISSIONS` pins it (ADR 0079).

- **What a role may do** (ADR 0089): ten settings, which each built-in role
  fixes to what it has always given. Core reads them through `placeOf`
  wherever the server decides what an account may do, and gives each
  workspace's to the apps in `/api/me`, as `may`.

Still to come here, each in its part of ADR 0089: custom roles, groups
granted teamspaces and pages, and sharing within a workspace's domains.

Roadmap: Phase 5, enterprise, mobile and scale.

# Enterprise features

Features for organizations: single sign-on, user provisioning, audit logs,
data policies, the admin console and high availability.

They are free and open source under the same license as the rest of
Nether. There is no license key, no seat limit and no phone-home, and
everything works air-gapped. They live in this folder only to keep the code
organized:

- Code outside `enterprise/` never depends on it. Enterprise features plug
  in through extension points, so a server runs with all of them off.
- An admin turns each feature on in the admin console, at `/admin` in the
  server's web app, or pins it with an environment variable, as
  `NETHER_ENTERPRISE_AUDIT=on`
  ([ADR 0079](../docs/adr/0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).
- `server/` is the image's entry: it starts the server with every
  feature's module, each off until switched on. A module is a Fastify
  plugin for one feature, given what the server shares with every module,
  `EnterpriseServices` (the database, and closing an account's sync
  connections), and a check that answers 404 while its feature is off.

| Folder | What it holds |
| --- | --- |
| `sso/` | SAML 2.0 and enforced OIDC sign-in |
| `scim/` | Provisioning users and groups through SCIM and LDAP |
| `audit/` | Audit logs, search, and export to a SIEM |
| `policies/` | Data policies, advanced permissions, and locking AI to an approved endpoint |
| `admin/` | The admin console's usage, workspaces and security pages; its Features page is the server's own |
| `server/` | The image's entry: the server with every module |
| `ha/` | High availability: several nodes, failover, upgrades with no downtime |

Roadmap: Phase 5, enterprise, mobile and scale.

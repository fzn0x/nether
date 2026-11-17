# Enterprise: Provisioning

Automatic provisioning and deprovisioning of users and groups, through SCIM
and LDAP
([ADR 0085](../../docs/adr/0085-a-directory-provisions-accounts-and-groups-by-scim-or-an-ldap-pull-and-deprovisioning-deactivates-before-it-removes.md)).

- `src/directories.ts`: the directories the console keeps, with their
  domains, and a SCIM directory's token, kept as its SHA-256.
- `src/console.ts`: the console's Directories page's routes.
- `src/paths.ts`: SCIM's attribute paths and filters.
- `src/userDoc.ts`: a user as Nether keeps it, from a `POST` or `PUT`,
  and `PATCH` in the forms Okta and Entra ID send.
- `src/users.ts`: the accounts a directory makes, takes over, changes,
  deactivates and removes.
- `src/groups.ts`: a directory's groups, read, with their members.
- `src/groupDoc.ts`: a group as Nether keeps it, and `PATCH` in the
  forms Okta and Entra ID send.
- `src/groupWrites.ts`: groups made, changed and removed, and mapped to
  workspaces, each change settling the places it touches.
- `src/discovery.ts`: what a directory's address says of itself.
- `src/scim.ts`: the SCIM server at `/api/scim/<directory>/v2`.

The LDAP pull comes next.

Roadmap: Phase 5, enterprise, mobile and scale.

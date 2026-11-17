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
- `src/ldapSettings.ts`: an LDAP directory's settings, its presets for
  Active Directory and OpenLDAP, and what binds its sealed password.
- `src/ldapConnect.ts`: reaching a directory with ldapts, always
  encrypted, its certificate checked, its address under the outbound
  rules, on one connection a run.
- `src/ldapRead.ts`: what a run reads, people and groups by their stable
  IDs, nested groups flattened.
- `src/ldapSync.ts`: what a run changes, worked out and applied through
  the paths SCIM's requests take, 500 accounts to a transaction.
- `src/ldapRuns.ts`: runs claimed one node at a time, on the schedule or
  at once, the first a preview and a large deactivation held back.
- `src/ldapConsole.ts`: the Directories page's LDAP routes: settings,
  Test the connection, and Sync now.

`test/ldap/` builds the OpenLDAP the LDAP tests read, from Alpine's
packages. With Docker:

```sh
docker build -t nether-ldap-test enterprise/scim/test/ldap
docker run -d --name nether-ldap -p 1389:389 -p 1636:636 -v "/tmp/nether-ldap:/out" nether-ldap-test
NETHER_TEST_LDAP="/tmp/nether-ldap" pnpm --filter @nether/enterprise-scim test
```

Without `NETHER_TEST_LDAP`, those tests are skipped.

`test/ad/` builds a Samba Active Directory domain controller, which the
Active Directory preset's tests read. It needs `SYS_ADMIN` to provision:

```sh
docker build -t nether-ad-test enterprise/scim/test/ad
docker run -d --name nether-ad --hostname dc1 --cap-add SYS_ADMIN -p 2389:389 -p 2636:636 -v "/tmp/nether-ad:/out" nether-ad-test
NETHER_TEST_AD="/tmp/nether-ad" pnpm --filter @nether/enterprise-scim test
```

Without `NETHER_TEST_AD`, those tests are skipped.

Roadmap: Phase 5, enterprise, mobile and scale.

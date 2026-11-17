# 0085. A directory provisions accounts and groups by SCIM or an LDAP pull, and deprovisioning deactivates before it removes

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for "SCIM and LDAP": "Automatic user and group provisioning and
deprovisioning". It is the `scim` enterprise feature: free, in every image,
and off until an instance admin turns it on
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).
Its module is `enterprise/scim`. Core never imports it.

What it has to live with:

- **Accounts.** They come by invitation, at setup, or from a provider
  ([ADRs 0032](0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md)
  and [0034](0034-sign-in-with-openid-connect-through-the-server-and-back-to-the-app.md)).
  An address is one account's: `users.email_key` is unique. No route ends
  an account, and none pauses one. The first account, made at setup, is
  the only instance admin, and nothing makes another.
- **Every sign-in ends in `startSession`.** A password, an email code,
  OpenID Connect, an invitation and setup all call it, and single sign-on
  will too. Every request then finds its account through `sessionAccount`,
  or `tokenCaller` for an API token.
- **Memberships.** A `memberships` row is what every check reads: the
  routes, the units
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)),
  sync and the relay. Removing a member deletes its sealed keys and its
  grants, and a workspace keeps an owner. A change closes the account's
  sync connections through `disconnect(userId)`.
- **Encrypted workspaces.** A member's app seals the key to a new member
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).
  Nothing rotates it: a removed member keeps what they synced.
- **A workspace can lose its owners.**
  [ADR 0083](0083-the-console-lists-every-workspace-and-an-instance-admin-may-set-its-members-roles.md)
  lets an instance admin give it a new one from its members, and leaves
  adding members to invitations, owners and provisioning.
- **Drafts in review.** Single sign-on (ADR 0080) binds providers to email
  domains, links an account by an address at its provider's domains, and
  says "a later sign-in does not change an account's address; provisioning
  (SCIM) will". Audit logs (ADR 0081) keep a closed list of actions in
  core, emitted inside the change's transaction. High availability (ADR
  0082) gives `every(name, period, work)`, carries `disconnect` to every
  node, and lets a release's migrations only add.

**What the two identity providers send**, from their documentation:

| | Okta | Microsoft Entra ID |
| --- | --- | --- |
| Finds a user | `filter=userName eq "..."` | `userName eq` and `externalId eq`, the matching attribute its admin picks |
| Finds a group | `filter=displayName eq "..."` | `displayName eq`, with `excludedAttributes=members` |
| Filter operators | `eq` | `eq` and `and` only |
| Pages | `startIndex` and `count=100` | Lists and pages users |
| Updates a user | `PUT` with the whole user, after a `GET` | `PATCH` |
| Deactivates | `PATCH` with no `path`: `{"op": "replace", "value": {"active": false}}` | `{"op": "Replace", "path": "active", "value": "False"}`, a string |
| Deletes a user | Never | `DELETE`, 30 days after a soft delete, or when deleted for good |
| Renames a group | `PATCH` with no `path`, `value` holding `id` and `displayName` | `PATCH` `replace` |
| Adds members | `{"op": "add", "path": "members", "value": [...]}` | `{"op": "Add", "path": "members", "value": [...]}` |
| Removes members | `"path": "members[value eq \"<id>\"]"` | `"op": "Remove"`, `"path": "members"`, with the members in `value` |
| Replaces members | `{"op": "replace", "path": "members", ...}` | Not documented |
| Credentials | Basic, a bearer token, or OAuth | One bearer token, "long-lived" |

More of their quirks:

- **Entra ID capitalizes `op`** as `Add`, `Replace` and `Remove`, and asks
  that it be matched without case.
- **Entra ID's flag `aadOptscim062020`**, added to its tenant address,
  makes it compliant. `active` is then a boolean. A removal then names its
  member in the path. A replace of several attributes becomes one
  operation with no `path`, whose keys are paths, as
  `"name.givenName"` and
  `"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber"`.
  The flag is not the default yet, so both forms arrive.
- **Entra ID's documented mappings send more than a name and an
  address**: phone numbers, postal addresses, `title`, and the enterprise
  extension's `department`, `employeeNumber` and `manager`. Its
  `mailNickname` goes to `externalId`. One of its paths is spelled
  `emails[type eq "other"].Value`.
- **Entra ID leaves a disabled user's groups to the app.** "When a user
  goes from soft-deleted to active, the Microsoft Entra provisioning service
  activates the user in the target app, but doesn't automatically restore
  the dynamic membership group." It also "can't read or provision users in
  nested groups", and asks that groups be unique by `displayName`.
- **Okta's create carries `password`** "even if password sync isn't
  enabled", and `groups`. Its base address "can't contain the underscore
  `_` character".
- **Both expect** `application/scim+json`, `200` with an empty
  `ListResponse` when a filter finds nothing, and `409` for a duplicate.

**LDAP.** Some organizations have a directory and no identity provider
that speaks SCIM, as Active Directory on its own. Nether then has to read
the directory itself. Active Directory's `MaxPageSize` lets a page hold
1,000 entries at most, and its `MaxValRange` sends 1,500 values of one
attribute at most, so a large group's `member` comes in ranges.

## Decision

### A directory

**A directory is where accounts and groups come from**: a SCIM client,
such as Okta or Entra ID, or an LDAP server Nether reads. An instance
admin adds it on the console's **Directories** page, which the `scim`
module adds. Each has:

- an ID of the admin's, lowercase letters, digits and hyphens, as single
  sign-on's providers have, so it fits Okta's base address;
- a name;
- the email domains it speaks for. A domain belongs to one directory at
  most;
- whether it may make accounts at other domains, off by default, below.

**An account belongs to one directory at most**, which then manages it:
its name, its address, whether it is active, and its groups. Accounts no
directory manages stay as they are.

**Where it lives.**

- Code: `enterprise/scim`.
- The console's page: the module's routes, and a page in the web app's
  console.
- Tables: in core's migrations, as single sign-on's and the audit log's
  are, so a restore that runs core's migrations alone creates them. Each
  only adds, as ADR 0082 asks.
  - `users.deactivated_at`.
  - `memberships.own_role`, below.
  - `directories`: the kind, the name, the settings, an LDAP directory's
    sealed secrets, a SCIM directory's token hash and expiry, and the
    state of its last sync.
  - `directory_domains`: each domain and its directory.
  - `directory_accounts`: each account a directory manages, with its
    `userName`, its `externalId` and what the directory sent of its name
    and addresses.
  - `groups`, `group_members` and `group_workspaces`, below.

### Deactivation is core's

**An account can be deactivated.** `users.deactivated_at` says when. The
module sets it; core enforces it, whether the feature is on or off.
Turning the feature off never brings an account back.

**A deactivated account:**

- **signs in no way.** `startSession` refuses it, so every way in refuses
  it at once: a password, an email code, OpenID Connect, single sign-on,
  an invitation, and any way added later.
  - A password answers as a wrong password does, so it cannot be used to
    test passwords.
  - An email code is not sent, with the answer every address gets.
  - A provider's sign-in, whose provider has already said who it is,
    answers at redeeming that the account is deactivated, and the apps
    show it.
- **loses its sessions, its email codes and its API tokens**, deleted in
  the transaction that deactivates it. `sessionAccount` and `tokenCaller`
  also refuse a deactivated account, so a session started at that moment
  does not outlive it.
- **is disconnected**: `disconnect(userId)` closes its sync and relay
  connections on every node, as ADR 0082 carries it.
- **keeps its memberships, roles, grants, sealed keys and private
  spaces.** Entra ID asks the app to keep an inactive user's groups, and
  a person disabled by mistake comes back as they were.
- **does not count as an owner** when a workspace keeps one. The rule
  becomes "at least one active owner": a last active owner cannot step
  down while only deactivated owners remain.
- **gets no mail**, and **is not listed as waiting for a key**, so no
  member seals one to it.
- **shows as Deactivated** in members' lists and in the console.

Its sites, webhooks and share links stay: they are the workspace's, and
its owners remove them as they would anyone's.

**Reactivating it** lets it sign in again. Nothing else changes, since
nothing else did.

**The last active instance admin cannot be deactivated or removed** by a
directory. The request answers 403, saying why, so the server always keeps
a way into its console. Any other instance admin may be.

### Removal

**A directory's removal of an account**, as SCIM's `DELETE`, ends it for
the organization:

- it is deactivated, if it was not;
- it leaves every workspace, as an owner's removal does: its memberships,
  its sealed keys and its grants go, and with its memberships, the sites
  and webhooks it made;
- its identities at providers go, so no provider's earlier link reaches
  it;
- the directory lets it go: `GET` answers 404 from then on, as RFC 7644
  asks after a delete.

**The account itself stays, deactivated**, as a record. Its name still
reads in the history, and its private spaces, whose notes a unit keeps,
are not deleted. Deleting accounts, with what is kept and for how long,
belongs to data policies, a later item.

**An organization that never deletes**, as Okta never does, keeps its
deactivated people as members until their groups or the owners remove
them.

### Workspaces whose owners are gone

**Nothing is handed over on its own.** A workspace whose last active owner
is deactivated or removed keeps its roles:

- its admins still manage members and guests;
- the console's Workspaces page marks it **No active owner**, with a
  filter that lists those first;
- an instance admin gives it an owner from its members, as ADR 0083
  allows;
- a workspace with no active member left gets one through a group mapped
  to it as owner, below.

Choosing a successor needs knowing the organization, which the server
does not.

### Encrypted workspaces

- **Deactivation keeps the sealed copies**, so a person who comes back
  reads again with no one sealing anew.
- **Removal deletes them**, as an owner's removal does today.
- **Nothing is rotated.** A removed person's devices keep the key and what
  they synced, as ADR 0038 has it. Their sessions are gone, so the server
  gives them nothing new. Rotating the key on removal is its own item.
- **Someone a group adds** waits for a member online to seal them the key,
  as any new member does.

### Accounts a directory makes or takes

**A new account** has:

- **no password.** Its owner signs in through single sign-on, the
  environment's OpenID Connect provider, or an email code. The console
  says so when none of these is set up.
- **its address from the directory**: the primary of its `emails`, else
  the one typed `work`, else the first, else `userName` when it is an
  address. With none, the request is refused.
- **its name from the directory**: `displayName`, else `name.formatted`,
  else the given and family names, else the address before its `@`.

**An address must be at one of the directory's domains**, unless the
directory may make accounts at other domains. That setting is for a
server with one organization, whose identity provider holds guests and
contractors at their own addresses, as Entra ID's B2B guests are.

**An account that already has the address**:

- **is taken over** when the address is at one of the directory's domains
  and no other directory manages it. The directory now manages it, sets
  its name, and says whether it is active. Its password, memberships and
  identities stay.
- **is refused** otherwise, with 409, as a duplicate. A directory never
  takes an account at a domain it does not speak for, even when it may
  make accounts at other domains. On a server for several organizations,
  one organization's directory so cannot end another's people.

So a person signed in just in time by single sign-on before the directory
reached them is taken over by it, not duplicated.

**A changed address** follows the directory: it must be at one of its
domains, and no other account may have it.

**Single sign-on finds these accounts by their domain.** ADR 0080 links a
first sign-in to the account whose address is at the provider's domains.
A directory and a provider for the same domain so meet with nothing to
set. Nether does not link identities by `externalId`: it is set in the
identity provider's provisioning, and a provider's subject in its
sign-in, and nothing makes them equal. The guide suggests turning off a
provider's own account making when a directory provisions its domains,
so only people assigned to Nether get in.

### Groups

**A group is the instance's**, not a workspace's. A directory's group
spans workspaces, as the organization's teams do, and advanced
permissions, the next item, grants access to the same groups.

- `groups`: its ID, a UUID of Nether's that never changes; its
  directory; its name, unique within its directory; and the directory's
  `externalId`. The directory is set for every group this item makes; it
  may be empty later for groups an instance admin makes.
- `group_members`: which accounts are in it. A member must be an account
  the same directory manages, so a SCIM group that names a group as a
  member is refused; Entra ID does not provision nested groups anyway. An
  LDAP directory's nesting is flattened when it is read.

**A group gives its members a role in a workspace.** An instance admin
maps it on the directory's page: a group, a workspace from the console's
list, and owner, admin or member. Guests come by pages, so no group makes
one. `group_workspaces` keeps the mapping.

**A membership has its own role and its groups' roles.** `role` stays
what every check reads: the highest of the two. `memberships.own_role`
keeps the rest:

| `own_role` | Means |
| --- | --- |
| Empty | Its own role is `role`, and no group gives more. Every membership today is so, as is any row a node of the previous release inserts |
| A role | A group raised `role` above its own, which this is |
| `none` | Its groups alone give it |

**One core function settles a membership**, `settleMembership`, given a
transaction, a workspace and an account. It reads the account's own role
and the roles its groups give there, and writes the highest. When there
is none, it removes the membership as a removal does, with its sealed
keys and grants. It
closes the account's connections when anything changed. It runs when a
group's members change, when a mapping is set or removed, and when a
group or an account is removed. It locks the rows it changes in one
order, by workspace and then account, so two settles cannot wait on each
other.

**What the workspace's owners may do**:

- **Raise a member** above what its groups give, as its own role.
- **Not lower it below its groups, nor remove it**, and the member may
  not leave. The answer names the group. Removing someone from a group is the
  directory's.
- **Invite someone a group already gave a place**: accepting gives the
  membership its own role, so the group leaving does not take it.

The workspace's members list marks each place a group gives, with the
group's name.

**A directory's removal from the console keeps what its groups gave.**
Each membership its groups gave becomes the account's own, at the role it
has, before its groups and mappings go. Its accounts stay as they are,
active or not, now managed by no directory.

**What advanced permissions builds on.** Nothing here grants a unit to a
group; that is the next item's. It will find:

- groups with stable IDs, for any module to read, as core's tables;
- `settleMembership`, the one place a membership comes from its sources,
  where custom roles add theirs;
- `accessible()`, the one place a unit's access is worked out, where
  grants to groups join grants to accounts;
- the directories' domains, beside single sign-on's, as the
  organization's own domains that sharing may be restricted to;
- audit events that name groups as their targets.

### The SCIM server

**Each SCIM directory has its base address**:
`NETHER_PUBLIC_URL/api/scim/<directory>/v2`. The page shows it, and says
to set `NETHER_PUBLIC_URL` when it is not.

**It takes one bearer token**, which is what Entra ID sends and one of
Okta's choices.

- The console makes it: `nether_scim_` and 32 random bytes, shown once,
  as an API token is shown. The server keeps its SHA-256, with its last
  four characters to tell it by.
- **It lasts a year**, or as long as the admin picks, up to two. RFC 7644
  says bearer tokens "MUST have a limited lifetime". The page shows when
  it ends and warns a month before; the server's log warns each day of its
  last week.
- **A new token replaces the old one at once.** Revoking it, or removing
  the directory, ends it.
- A token works only at its own directory's address. Any other answers
  401, with a SCIM error. Requests with a wrong token are limited by
  address, as signing in is: 30 in 5 minutes. A directory's own requests
  are not limited, as a first sync sends one or more for each person.
- No Basic authentication, which RFC 7644 says "should be avoided", and no
  OAuth. Entra ID's own tokens "should only be used for testing", its
  documentation says.

**The endpoints:**

| Endpoint | Methods |
| --- | --- |
| `/Users` | `GET` with a filter and pages, `POST` |
| `/Users/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/Groups` | `GET` with a filter and pages, `POST` |
| `/Groups/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/ServiceProviderConfig` | `GET` |
| `/ResourceTypes`, `/ResourceTypes/{name}` | `GET`: User and Group |
| `/Schemas`, `/Schemas/{id}` | `GET`: the core User and Group schemas, with the attributes Nether keeps |

All of them need the token. No `/Me`, `/Bulk` or `/.search`: neither
provider uses them.

**`ServiceProviderConfig` says**: PATCH supported; filters supported, up to
1,000 results a page; no bulk, no sort, no ETags, no password changes; and
`oauthbearertoken` as the way in.

**A user** is its account:

- `id` is the account's ID.
- `userName`, unique within the directory without regard to case, and
  `externalId`, kept as sent and not unique, as RFC 7643 scopes it to the
  client.
- `name`, `displayName` and `emails`, kept in `directory_accounts` as sent,
  so a `GET` gives back what was sent. The account's name and address come
  from them.
- `active`.
- `groups`, read only: its groups here.
- `meta`: `resourceType`, `created`, `lastModified`, and `location` when
  `NETHER_PUBLIC_URL` is set.

`password` is accepted and dropped, never stored. Attributes Nether does
not keep, as phone numbers, `title`, addresses and the enterprise
extension, are accepted and dropped too, since Entra ID's documented
mappings send them. A person's details are kept only where Nether uses
them.

**A group** has `id`, `displayName`, `externalId`, `members` and `meta`.
`displayName` is unique within the directory, as Entra ID asks.

**Filters** take `eq`, joined by `and`, with attribute names in any case,
as RFC 7644 has them. On users: `id`, `userName`, `externalId`,
`emails.value`, `emails[type eq "work"].value` and `active`. On groups:
`id`, `displayName`, `externalId` and `members.value`. `userName`,
`emails.value` and `displayName` compare without regard to case; IDs
compare exactly. Anything else answers 400 `invalidFilter`.

**Paging** is by `startIndex` from 1 and `count`, 100 by default and at
most 1,000, in the order accounts and groups were made, so pages hold
still as long as nothing is made or removed between them. `totalResults`,
`itemsPerPage` and `startIndex` are numbers, as Okta asks.
`excludedAttributes=members`, and `attributes` and `excludedAttributes`
for top-level attributes, are honored.

**`PATCH` takes both providers' forms.** A request is atomic, as RFC 7644
asks: every operation applies, or none.

| Form | Example |
| --- | --- |
| `op` in any case | `Replace`, as Entra ID sends |
| Attribute names in any case | `emails[type eq "other"].Value` |
| A path | `displayName`, `name.familyName`, `active` |
| A path with a value filter | `emails[type eq "work"].value`, `members[value eq "<id>"]` |
| No path, the value an object | `{"active": false}`; `{"id": ..., "displayName": ...}`; keys that are paths, as `"name.givenName"` |
| A schema's URN before a path | `urn:ietf:params:scim:schemas:core:2.0:User:userName` |
| Booleans as strings | `"False"`, `"true"`, in any case |
| Removing members named in `value` | Entra ID's form without its flag |
| Replacing `members` | Okta's whole list |
| An attribute Nether does not keep | Accepted, and dropped |

**Reactivating takes every form deactivating does**: `active` set to
true by its path or in an object with no path, as a boolean or a string
in any case. Okta does not show its reactivation body, so none of these
is assumed.

A `remove` with no path answers 400 `noTarget`. A user's `PATCH` answers
200 with the user. A group's answers 204, as Entra ID advises, and Okta
takes either.

**`PUT`** replaces what Nether keeps. A `PUT` with no `active` leaves it
as it is, so a client that leaves it out does not reactivate anyone.

**`POST`** makes or takes an account, as above, and answers 201.

**Errors** are RFC 7644's: `application/scim+json`, with the error
schema, `status` as a string, `scimType` where one fits, and a `detail`
that says what to change.

| Status | When |
| --- | --- |
| 400 `invalidFilter` | A filter Nether does not take |
| 400 `invalidSyntax` | A body that is not SCIM |
| 400 `invalidPath`, `noTarget` | A `PATCH` path that names nothing |
| 400 `invalidValue` | No address; an address outside the directory's domains; a member not of this directory |
| 401 | No token, a wrong one, or another directory's |
| 403 | The last active instance admin; a filter on a discovery endpoint, as RFC 7644 suggests |
| 404 | No such user or group, or one removed; and every route while the feature is off |
| 409 `uniqueness` | A `userName` or group name the directory has; an address another account has that the directory may not take |

Requests may be `application/scim+json` or `application/json`, up to 4 MB,
so a group's whole list of members fits.

**Everything a request changes is one transaction**: the account, its
groups, the memberships they settle, and their audit events.

### The LDAP pull

**The library is `ldapts`.**

| | `ldapts` 9.2.0 | `ldapjs` 3.0.7 |
| --- | --- | --- |
| License | MIT; its one dependency, `strict-event-emitter-types`, is ISC | MIT |
| Maintenance | Releases through 2026, the last on 2026-09-15 | Deprecated on npm: "This package has been decomissioned" |
| Size | 581 KB unpacked, with a 10 KB dependency | |
| Needs | Node 22 or later; the image runs Node 24 | |
| What we use | Simple bind, StartTLS, paged search, binary attributes, and its socket factories, so Nether connects where it checked | |

**Connecting.**

- **Always encrypted**: `ldaps://`, or `ldap://` with StartTLS. Plain
  LDAP is refused, as a bind sends its password.
- **The server's certificate is checked**, and its name: against the
  system's authorities, or against authorities the admin pastes, as an
  internal one often is, or by a pinned SHA-256 fingerprint. These are
  the audit log's choices for syslog (ADR 0081). There is no way to skip
  the check.
- **The address is checked** under the outbound rules
  ([ADR 0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md)):
  its name is resolved, and a private address is reached only when
  `NETHER_LDAP_PRIVATE` names its network, as `NETHER_SSO_PRIVATE` does
  for providers. Nether connects to the address it checked, and gives TLS
  the name.
- **The bind** is a DN and a password. The password is sealed with
  `NETHER_SECRET_KEY`, bound to the directory, its address and its DN,
  as the web app's AI keys are sealed
  ([ADR 0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md)).
  Changing the address or the DN asks for the password again, so the
  console cannot send a kept password to a new address. Without
  `NETHER_SECRET_KEY`, the page says LDAP needs it.
- **One connection a run.** `ldapts` reconnects on its own when a
  connection drops, and the new one has neither the bind nor StartTLS.
  The socket factory Nether gives it refuses a second connection, so a
  dropped connection fails the run instead.
- Timeouts: 10 seconds to connect, 60 for each page.

**What it reads.** The page starts from a preset, and every field stays
the admin's:

| | Active Directory | OpenLDAP |
| --- | --- | --- |
| People | `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`, which leaves disabled accounts out | `(objectClass=inetOrgPerson)` |
| A person's stable ID | `objectGUID`, read as bytes | `entryUUID` |
| `userName` | `userPrincipalName` | `uid` |
| Address | `mail` | `mail` |
| Name | `displayName`, else `cn` | `displayName`, else `cn` |
| Groups | `(objectClass=group)` | `(objectClass=groupOfNames)` |
| Who is in a group | Each person's `memberOf` | Each person's `memberOf`, with the `memberof` overlay; else each group's `member` |

- A base DN each for people and groups, with a subtree search.
- **Membership is read from people by default**, through `memberOf`.
  A person is in few groups, while a group's `member` holds every person,
  and Active Directory sends those past 1,500 in ranges. Reading groups'
  `member` or `uniqueMember` DNs, or `memberUid` names, is there for
  directories without `memberOf`. A group whose members come in ranges
  stops the run, naming it, rather than being read in part.
- **Nested groups are flattened**: a group that is a member of another
  read group gives it its members, to any depth, ignoring loops.
- **A person is known by the stable ID**, so a renamed or moved entry
  stays the same account. The ID is the account's `externalId`.
- The admin narrows the groups with the filter, as `(cn=nether-*)`. Only
  read groups can be mapped.

**When it runs.** One job, `every("scim.ldap", 1 minute)` from ADR 0082,
looks for directories that are due. Each directory runs every hour by
default, from 15 minutes to a day, and **Sync now** runs it at once. A
run claims its directory's row until it ends, or for an hour if its node
dies, so two nodes never read one directory at once.

**A run:**

1. Binds, and reads every person and group in pages of 500, under
   Active Directory's 1,000.
2. **Gives up, changing nothing, on any error**: a failed bind, a page
   that fails, a size or time limit, a referral, or a group in ranges. A
   directory read in part would deactivate everyone not read.
3. Works out what changes: accounts to make, take, change, deactivate or
   reactivate; groups to make, rename or remove; members to add or
   remove.
4. **Holds back a large deactivation.** When it would deactivate more than
   a tenth of the directory's active accounts, and more than five, it
   changes nothing and waits for an instance admin to look. The page
   shows who would go, and **Run anyway** applies it once. The share is
   the admin's to set, from 1 to 100 percent.
5. Applies the rest, 500 accounts to a transaction, each account with its
   groups, memberships and events. A run that stops between batches
   leaves each batch whole, and the next run finishes.
6. Records how it went: when, how long, and how many it made, changed,
   deactivated and skipped. A person with no address is skipped and
   named.

**A directory's first run is a preview**: it reads and shows what it
would do, and applies nothing until the admin confirms.

**Deprovisioning by LDAP.** A person the directory no longer returns,
deleted, moved out of its base or out of its filter, is deactivated: an
LDAP read cannot tell a deletion from a filter that now leaves someone
out. Those people also leave the read groups, so what groups gave them
goes, and their own memberships stay. A person who comes back is
reactivated and gets their groups again.

**Signing in is not LDAP's.** An LDAP directory provisions; it does not
check passwords. Its people sign in through single sign-on, as Keycloak
or AD FS in front of the same directory, or by an email code.

### Air-gapped installs

- **LDAP works with nothing outside the network**: the library is in the
  image, the directory is on the network, its authority is pasted, and
  `NETHER_LDAP_PRIVATE` names where it is.
- **SCIM needs the identity provider to reach the server.** A cloud
  provider reaches only a public address; Entra ID needs an https address
  whose certificate comes from an authority it lists, and offers an agent
  for private networks. A provider on the same network needs nothing
  more.
- No part of this feature calls out but the LDAP read, and nothing is
  reported anywhere.

### Audit events

In ADR 0081's style, added to core's list of actions:

| Action | When |
| --- | --- |
| `account.created` | Already named: now also by a directory, with `details.via` `scim` or `ldap` |
| `account.changed` | A directory changes an account's name or address, from and to |
| `account.deactivated`, `account.reactivated` | An account stops or starts being able to sign in |
| `directory.account_linked` | A directory takes over an account that existed |
| `directory.account_unlinked` | A directory removes an account, or is removed |
| `directory.created`, `directory.changed`, `directory.deleted` | An instance admin adds, changes or removes a directory, never its secrets |
| `directory.token_created` | A SCIM directory gets a new token, which ends the old one |
| `directory.synced` | An LDAP run ends: its counts, or why it failed or was held back |
| `group.created`, `group.changed`, `group.deleted` | A directory makes, renames or removes a group |
| `group.member_added`, `group.member_removed` | An account joins or leaves a group |
| `group.workspace_set`, `group.workspace_removed` | An instance admin maps a group to a workspace, with its role, or removes it |

- **Memberships keep their names.** A group that gives a place emits
  `member.joined`, `member.role_changed` or `member.removed`, with
  `details.via` `group` and the group.
- **A refused sign-in** is a `session.signed_in` failure with the reason
  `deactivated`.
- **The actor is the directory**: a new kind beside `account`, `visitor`,
  `anonymous` and `system`, with its ID and name. A SCIM request's address
  and client are the provider's; an LDAP run's are the server's.
- Every name fits syslog's `MSGID`, 32 characters.

### Testing

- **Core**, on PGlite: every way in refuses a deactivated account, and its
  sessions and tokens stop at once; a session started as it is
  deactivated is refused at its next request; active owners and the 403
  for the last active instance admin; `own_role` and `settleMembership`,
  with rows of the previous release's shape; removal's keys and grants;
  waiting for a key.
- **SCIM, with requests as each provider documents them**, in
  `enterprise/scim`:
  - Okta: the check by `userName eq`, pages of 100, a create carrying
    `password` and `groups`, `PUT` updates, the deactivation with no path,
    and group push's rename, add, remove by filter, whole-list replace and
    delete.
  - Where Okta's documentation is silent, every form: its reactivation by
    path and with no path, as a boolean and as a string; and a burst of a
    directory's own requests, none answered 429. The tests say which
    behaviour is assumed rather than documented.
  - Entra ID, without its flag and with it: capitalized `op`, `"False"`,
    `emails[type eq "work"].value`, the enterprise extension's paths,
    removing members in `value` and by filter, paths as keys, filters by
    `externalId` and `displayName` with `excludedAttributes=members`, the
    test connection's lookup of a random user, and `DELETE`.
  - RFC 7644's errors and discovery documents, and atomic `PATCH`.
  - Taking an account over and refusing to, by domain, and two
    directories.
- **A real LDAP server in CI.** A job builds a small image from Alpine
  3.22's OpenLDAP packages: `slapd` 2.6.8, under the OpenLDAP Public
  License 2.8, which is BSD-style, and only run in CI. It has the
  `memberof` and `refint` overlays, a seeded tree, and a test authority
  and certificate made with `openssl` when it starts.
  - Tried on the maintainer's machine with Docker 29.9.2: paged searches
    of two entries a page, `entryUUID` and `memberOf` came back as
    expected.
  - The tests: ldaps and StartTLS with the pasted authority; a wrong
    authority and a wrong fingerprint refused; 2,500 people in pages; a
    renamed entry kept by its ID; nested groups; someone leaving the
    filter deactivated; the hold on a large deactivation; a failed bind
    changing nothing.
  - Locally they run when Docker is there, and skip otherwise, as single
    sign-on's Keycloak tests do.
- **Active Directory** is not in CI. Its preset is tested on fixtures:
  `objectGUID`'s bytes, and the filter's text. A follow-up issue asks the
  maintainer to check Okta, Entra ID and Active Directory live, with the
  guide's steps and Microsoft's SCIM validator.

### Parts

Each from `origin/main`, one PR each, its guide pages in the same PR:

1. **Deactivation and the tables.** The migration; `startSession`,
   `sessionAccount` and `tokenCaller` refusing a deactivated account;
   active owners; `own_role`, `settleMembership`, and removal as one core
   function; waiting for a key; the apps showing **Deactivated**; and the
   audit names, once ADR 0081's list is on main.
2. **SCIM users.** The module, its Directories page with SCIM directories,
   domains and tokens; `/Users` and the discovery endpoints; filters,
   paging, `PATCH` and `PUT`; deactivation and removal; taking accounts
   over; the Okta and Entra ID user tests; the admin guide's Okta and
   Entra ID pages.
3. **SCIM groups and their workspaces.** `/Groups`; mapping groups on the
   directory's page; settling memberships; owners' limits and the members
   list's marks; **No active owner** on the Workspaces page; the group
   tests.
4. **LDAP.** `ldapts`, LDAP directories on the page, their certificates
   and sealed bind, `NETHER_LDAP_PRIVATE`, the job on `every`, the
   preview and the hold; the OpenLDAP job in CI; the guide's Active
   Directory and OpenLDAP pages. It ticks the roadmap item, and opens the
   follow-up issue.

## Alternatives

- **Deleting the account on `DELETE`.** Its private spaces' notes block it,
  as a unit with notes is never deleted; its name would leave the history;
  and what is kept, and for how long, is data policies' to say. A
  deactivated account that belongs to no workspace and no directory
  removes the person all the same.
- **Removing memberships on deactivation.** Entra ID asks the app to keep
  an inactive user's groups, a person disabled by mistake would come back
  to nothing, and an encrypted workspace's members would have to seal the
  key again.
- **Handing a workspace to its longest-standing admin when its owner
  goes.** The server does not know who should own it; the console's
  instance admin can, and a group mapped as owner does it by rule.
- **Groups per workspace.** A directory's group spans the organization, and
  advanced permissions grants to the same groups across workspaces.
- **Group places as plain memberships with a source column.** A row
  inserted by the previous release, during a rolling upgrade, would have
  no source and could be removed by mistake. Reading memberships from two
  tables would change every check in core. An empty `own_role` means what
  every row means today.
- **Linking provider identities by `externalId`.** Nothing makes it equal
  to a provider's subject; the domain rule links at the first sign-in
  without that.
- **Tokens with no end.** RFC 7644 says bearer tokens must have a limited
  lifetime. A year, with warnings, keeps provisioning from stopping by
  surprise.
- **OAuth or Basic authentication.** OAuth would make Nether an
  authorization server for one client; Basic is a password in every
  request. Both providers send a bearer token.
- **Refusing attributes Nether does not keep.** Entra ID's documented
  mappings would fail on every user until an admin trimmed them.
- **Keeping every attribute a directory sends.** Phone numbers, managers
  and addresses would sit in Nether with no use.
- **ETags.** RFC 7644 makes them optional, and neither provider sends
  `If-Match`.
- **`ldapjs`.** Decommissioned.
- **Signing in with the directory's password**, by an LDAP bind. Nether
  would handle directory passwords; Keycloak, under Apache-2.0, can put
  OpenID Connect or SAML in front of the same directory today.
- **Plain LDAP, or skipping certificate checks.** A bind sends its password,
  and a name the certificate does not hold is a server Nether did not mean
  to reach.
- **Deactivating whoever a run did not read.** A misspelled filter or a
  moved base would end everyone; the hold and the rule that a failed run
  changes nothing prevent it.
- **Test servers.** `lldap`, under the GPL-3.0, is "not a fully-featured
  LDAP server, intentionally so", and its README documents neither paged
  results nor StartTLS. `osixia/openldap`'s last stable tag is from 2021,
  and its 2.6 build is still a release candidate. Bitnami's images get no
  updates since August 2025, as ADR 0082 found. An image from Alpine's
  packages is small and ours to keep.

## Consequences

- **Core gains deactivation**, which every way in and every lookup checks.
  A later console feature, as an instance admin pausing an account, can
  reuse it.
- **Owners can no longer remove a member a group placed.** The members
  list says which group, and the directory's admin changes it.
- **Accounts with no password** need single sign-on, the environment's
  provider, or email codes. The console says so.
- **A first sync writes many audit events**, one or more per person and
  group, each under the chain's lock. Tens of thousands take minutes, not
  hours.
- **Microsoft's validator** will report that attributes Nether does not
  keep are missing after a write. The guide says so.
- **An address given to someone new** reaches the old, deactivated account
  when a directory takes it over. Deleting accounts, with data policies,
  is how an organization ends one for good.
- **Interfaces shared with work in progress.**
  - `startSession` refuses a deactivated account, and single sign-on's
    redeem answers it as the environment's provider's does (ADR 0080).
  - Core's member functions change for every caller, the console's
    included (ADR 0083): `setRole` counts active owners and will not go
    below a group's role, removal becomes one function settling also
    uses, and accepting an invitation gives a membership its own role.
  - Core's list of actions gains the names above, and the event's actor
    gains `directory` (ADR 0081).
  - The module uses `every` and `disconnect` from `EnterpriseServices`
    (ADR 0082), and the server's configuration for `NETHER_SECRET_KEY`
    and `NETHER_PUBLIC_URL`, both read from `EnterpriseServices.config`,
    which single sign-on adds. `EnterpriseServices` gains nothing of its
    own.
  - The migration is the next free number when part 1 merges.
- **Revisit** the hold's default if it stops real changes often; the
  `aadOptscim062020` forms once Entra ID makes them its default; and
  `DELETE` when data policies define deleting accounts.

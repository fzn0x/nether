# 0089. Custom roles adjust a built-in role, groups are granted teamspaces and pages, and a workspace may share only within its domains

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for "Advanced permissions | Custom roles, group-based access,
domain-restricted sharing". It is an enterprise feature: free, in every
image, and off until an instance admin turns it on
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).
Core never imports its module.

What it has to live with:

- **Four roles.** A `memberships` row holds `owner`, `admin`, `member` or
  `guest`, and the server's checks compare that text where they stand:
  owners and admins invite, manage members, change the workspace's
  settings, turn publishing off, see every site and manage webhooks;
  anyone but a guest lists members, makes teamspaces, has a private space,
  writes General, uploads attachments and writes through the relay of an
  encrypted workspace. The checks are spread over `invitations.ts`,
  `members.ts`, `units.ts`, `workspaces.ts`, `sites.ts`, `webhooks.ts`,
  `relay.ts` and `attachments.ts`.
- **Four levels.** Full access, edit, comment and view, in sync units
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)).
  `accessible()` is the one place a unit's level is worked out: General at
  full for anyone but a guest, a teamspace by its grants and never for a
  guest, a private space for its member, a shared page by its grants,
  raised by where it sits unless it is restricted. Sync, the relay's
  reads, search, history, mentions, webhooks' deliveries, published sites
  and the public API
  ([ADR 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md))
  all ask it.
- **Older apps know four of each.** The sync engine drops a unit whose
  level is not one of the four (`readUnits` in `@nether/sync-client`), so
  a new level would hide a page from an older app. The apps compare role
  names to decide what to offer: the Members dialog, the Share dialog's
  people list and the AI settings all do.
- **Groups.** [ADR 0085](0085-a-directory-provisions-accounts-and-groups-by-scim-or-an-ldap-pull-and-deprovisioning-deactivates-before-it-removes.md)
  made groups the instance's, from a directory, each mapped by an
  instance admin to workspaces at owner, admin or member. A membership
  keeps its own role beside its groups' (`own_role`), and
  `settleMembership` writes the highest into `role`. It left for this
  item: grants to groups in `accessible()`, custom roles in
  `settleMembership`, and the directories' domains as the organization's
  own.
- **Share links have no account behind them**
  ([ADR 0071](0071-a-share-link-opens-one-shared-page-to-anyone-with-it-through-the-web-app.md)),
  and a data policy may let a workspace's links only view, or open nothing
  ([ADR 0088](0088-data-policies-set-a-workspaces-retention-legal-hold-public-sharing-and-export-over-its-owners.md)).
- **Addresses are not always proved.** An account made by accepting an
  invitation types its own address. An invitation that names an address
  binds its token to it, but an invitation with none lets whoever has it
  type any address that has no account yet. Single sign-on vouches for an
  address at its provider's domains
  ([ADR 0080](0080-single-sign-on-binds-saml-and-oidc-providers-to-email-domains-and-enforcement-refuses-other-ways-in.md)),
  a directory for those it manages, and an email code for the moment it is
  used.
- **Rolling upgrades.** The previous release runs on the new schema while
  nodes are replaced one at a time
  ([ADR 0082](0082-several-nodes-share-sync-through-valkey-take-their-order-from-postgresql-and-roll-out-one-at-a-time.md)).
  It reads `memberships.role` and `unit_grants` and nothing new.

## Decision

**The feature is `permissions`, "Advanced permissions"**, switched by
`NETHER_ENTERPRISE_PERMISSIONS` or the console, with its module in
`enterprise/permissions`. While it is off, everything it set is kept and
does nothing: each custom role acts as its base, groups' grants open
nothing, and sharing domains restrict nothing.

### A role is a set of settings

**What a role may do is ten settings.** Each built-in role is one fixed
set of them, which gives exactly what the role gives today:

| Setting | Values | Owner | Admin | Member | Guest |
| --- | --- | --- | --- | --- | --- |
| General | full, edit, comment, view, none | full | full | full | none |
| At most | full, edit, comment, view | full | full | full | full |
| Teamspaces | make, join, none | make | make | make | none |
| Private space | yes, no | yes | yes | yes | no |
| Members | manage, invite, see, none | manage | manage | see | none |
| Guests | yes, no | yes | yes | yes | yes |
| Share links | yes, no | yes | yes | yes | yes |
| Publishing | yes, no | yes | yes | yes | yes |
| Export | yes, no | yes | yes | yes | yes |
| Workspace | yes, no | yes | yes | no | no |

What each one decides, and where the server checks it:

| Setting | Decides | Checked in |
| --- | --- | --- |
| General | The level at which General opens; none, it is not opened | `accessible()`; the relay's writes in an encrypted workspace |
| At most | The highest level anything opens at, whatever is granted; a private space stays full | `accessible()` |
| Teamspaces | Making one; being given one at all | the teamspaces route; the grants route; `accessible()` |
| Private space | Having one | `PUT /private` |
| Members | Seeing who is in the workspace; inviting members and admins; changing and removing members and guests | the members and invitations routes |
| Guests | Inviting a guest to a page it has full access to | the invitations route |
| Share links | Making links to a page it has full access to | the links routes |
| Publishing | Publishing a page or folder it has full access to | the sites routes |
| Export | Reading text and rows through the public API; the apps' export | the API's reads, as a data policy's export does; `/api/me` for the apps |
| Workspace | The workspace's settings, its publishing switch, every one of its sites, and its webhooks | the workspace, sites and webhooks routes |

- **Full access to a unit still decides who manages it**: grants, its
  links, its guests, sharing a page on its own. Guests, Share links and
  Publishing only add a gate before what full access allows.
- **Attachments** are uploaded by an account whose General, or any unit
  it opens, is at edit or more. Today only non-guests upload, so a guest
  who edits a page cannot add its images; this lets them.
- **Owners alone** make, change and delete custom roles, set the
  workspace's sharing domains, give the owner role, and change or remove
  owners and admins. An admin may still invite an admin, as today. A
  workspace keeps an active owner, as ADR 0085 has it.

**One core function reads a person's settings in a workspace**,
`placeOf(db, user, workspace)`: their base role, the custom roles that
hold for them, and the settings. Every check above reads it in place of
comparing role names. The first part makes that change alone, with the
built-in table, so every answer stays as it is.

### Custom roles

**A custom role is a workspace's.** Its owners make, change and delete
them in the Members dialog. An instance admin sees them on the console's
Workspaces page and may give them, as roles are given there
([ADR 0083](0083-the-console-lists-every-workspace-and-an-instance-admin-may-set-its-members-roles.md)).

A custom role has:

- **a name**, 1 to 60 characters, unique in the workspace without regard
  to case, and none of the built-in roles' names;
- **a base**: admin, member or guest, set when it is made and never
  changed. A new base is a new role;
- **its settings**, starting from its base's. Each may go above or below
  the base's, up to an admin's.

At most 30 custom roles to a workspace.

**Settings that would contradict each other are refused**:

- General is no higher than At most;
- Teamspaces `make`, Guests, Share links and Publishing need At most at
  full, since each needs full access somewhere.

**The base is what the role falls back to.** It is kept in
`memberships.role`, as the role always was:

- older apps show it, and older nodes enforce it;
- the role acts as it while the feature is off;
- it decides who may give the role, by today's rules read for its base:
  a role based on admin is given by owners, or by an admin's invitation as
  now; one based on member or guest also by admins, and by roles with
  Members `manage`.

The Members dialog says so beside each custom role: "Viewer. A member
while advanced permissions are off."

**No one gives more than they have.** A role, built-in or custom, is
given, or invited to, only by someone whose own settings are at least as
high in every one, owners excepted. No one but an owner changes their own
role. A membership manager so cannot make a role that lets them do more
and take it.

**A change applies at once.** Changing a role's settings, or giving a
member another, closes the connections of everyone who holds it, as a
role change does, and their apps ask for their units again.

**A role in use is not deleted.** Deleting one that a member, a group's
mapping or an open invitation holds answers 409 with how many hold it.
The owners give those another role first. Deleting does not silently move
anyone to the base.

**Giving a member a role, or changing a role's settings, is refused when
it would leave a teamspace or a restricted page with no one to manage
it**, naming the unit: At most below full takes full access away, and
such a unit keeps a person with full access, as it does today.

**Encrypted workspaces.** Their settings hold for General and for every
action. The relay refuses writes below edit. A member whose app holds the
workspace's key can read what it syncs, so General `none` reads as view
there, as a guest reads all of an encrypted workspace today (ADR 0042).

### How a person's access is worked out

**Each source gives a role**: the member's own, built-in or custom, and
the role each of their groups mapped to the workspace gives, built-in or
custom. **Their settings are the most of each setting across their
sources.** Being in one more group never takes access away, which is what
directories expect of groups.

- `memberships.role` stays the highest base among the sources, which
  `settleMembership` already writes. A custom role does not change how a
  membership is settled, only what it may do.
- A member's own custom role is kept in `memberships.custom_role`, beside
  `own_role`; a group's, in `group_workspaces.custom_role`.

**A unit's level** for a person, in `accessible()`:

1. **Granted**: the highest of their own grant and the grant of each of
   their groups that reaches them (below).
2. **Where it sits**: a shared page that is not restricted takes the
   higher of what is granted and the level of the unit it sits in, as
   today. A restricted page counts only its grants, people's and groups'.
3. **The role**: General opens at its General setting. A teamspace opens
   only when Teamspaces is `join` or `make`. A private space is its
   member's alone, at full access.
4. **At most**: the level is cut to it, a private space excepted.

So a member whose own role is a Viewer, and who is in no other group,
reads General, and reads a teamspace they were given at edit. The same
member in a group mapped as member writes both.

### Groups are granted teamspaces and pages

**Which groups a workspace may grant to**:

- **a directory's group an instance admin mapped to it** at a role
  (ADR 0085);
- **a directory's group an instance admin offered to it for access
  alone.** It places no one: its grants reach those of its members who are
  in the workspace by other means. `group_offers` keeps the offers;
- **the workspace's own groups.**

A workspace's people see no other group, so on a server for several
organizations no one learns another's teams.

**A workspace's own groups** are made by those whose Members setting is
`manage`. Each has a name unique in the workspace, and members picked
from the workspace's members and guests. It gives no role, only what is
granted to it. At most 200 to a workspace. A member who leaves the
workspace leaves its groups.

- **Changing a group's members takes full access to everything the group
  is granted**, besides Members `manage`. Otherwise an owner or a
  membership manager could add themselves to a group granted a page
  restricted from them.
- A directory's groups are changed by their directory alone.

**A group is granted a teamspace or a shared page at a level**, by anyone
with full access to it, as a person is. `unit_group_grants` keeps it.
General is not granted: roles decide it.

**A grant reaches** each member of the group who:

- is a member of the workspace, at any role;
- may open the unit at all: a teamspace needs Teamspaces `join` or
  `make`;
- has an address at the workspace's sharing domains, when it has them
  (below).

**A teamspace, or a restricted page, keeps a person with full access.** A
group's full access does not count, since its members change outside the
workspace.

**Changes apply at once.**

- Setting or removing a group's grant closes the connections of its
  members in the workspace.
- A group's members changing closes the connections of those added or
  removed, wherever the group gives a place, a custom role or a grant.
  One core function, `groupChanged(tx, group, users, by, events)`,
  settles their places as ADR 0085 does and gives everyone whose access
  changed, for the caller to close once its transaction commits. The SCIM
  module, the LDAP pull and the workspace's own groups all call it.
- Removing a mapping or an offer takes the group's grants in that
  workspace with it. Removing a group takes all of its grants.

**Encrypted workspaces** have General alone, so nothing is granted to a
group there.

### Sharing within a workspace's domains

**A workspace may share only with people whose address is at its
domains.**

**Who sets them.**

- **Its owners**, in the Members dialog.
- **An instance admin**, on the console's Permissions page, for every
  workspace, or for one set apart, as data policies are set. The admin's
  setting holds over the owners'; the owners see it and why their field is
  gone.
- What holds for a workspace: its own setting from an instance admin,
  else the admin's for every workspace, else its owners'. An instance
  admin may set a workspace apart with no domains, which lets it share
  with anyone whatever every workspace has.

**A domain matches exactly**, lowercase, as single sign-on's do: listing
`example.com` does not allow `eu.example.com`. At most 50 to a workspace.
The field offers the server's own domains, those of its single sign-on
providers and directories, to pick from. Core gains the domain rule that
single sign-on's `domainOf` has, and the `sso` module imports it from
there.

**While a workspace has domains, no one gains access to it whose address
is outside them, however it is given**:

| How access is given | While it has domains |
| --- | --- |
| An invitation, to the workspace or to a page | Must name an address, at one of its domains. An invitation with no address, made before, cannot be accepted, and says to ask for a new one |
| Accepting an invitation | The account's address must be at one of its domains |
| A grant to a person | Their address must be at one of its domains |
| A group's place, or a group's grant | Reaches only the group's members at one of its domains. Places are settled again when the domains change |
| A share link | Opens only for someone signed in with a proved address at one of its domains (below). Links for anyone pause |

A refusal answers 403, naming the domains.

**What was given before stays.** Members, guests and grants outside the
domains keep what they have; a group's place or grant is worked out by
rule and so follows the domains at once. The Members dialog and the Share
dialog mark each person outside them, and **Remove those outside** takes
away, in one step, the memberships of everyone outside the domains whose
place is their own, keeping an active owner.

**Published sites are public**, and the domains do not touch them. The
workspace's publishing switch and data policies decide them, and the
Members dialog says so beside the domains.

**Proved addresses.** `users.email_proved_at` says when the server last
saw an account's address proved: by a sign-in with an email code, by a
provider that vouches for it (single sign-on at its domains, or the
environment's OpenID Connect provider with `email_verified`), by a
directory that manages the account, or by accepting an invitation that
named it. A change of address clears it, unless a directory makes the
change. Existing accounts are filled in from their directories, their
providers' identities and the invitations they accepted.

Only share links ask for a proved address. An invitation and a grant name
their person, chosen by someone in the workspace; a link is held by
whoever it was passed to, who could have typed an address of the domain
when making an account by an open invitation elsewhere on the server.

**Share links for people at the domains.** A link gains an audience,
`anyone` or `domains`.

- While the workspace has domains, every new link is for its domains,
  and links for anyone pause: they are kept, answer as paused, and their
  visits' connections close. They open again when the domains are taken
  away.
- Opening a link for the domains takes the web app signed in; the page
  asks for it, then comes back to the link. The account's address must be
  proved and at one of the domains.
- The visit is the account's: `link_visits.user_id` keeps it. It opens
  the link's unit alone, as any visit does; its comments and caret carry
  the account's name; and `disconnect(user)` closes it, as it does the
  account's other connections. A visit ends when the account is
  deactivated, or its address leaves the domains.
- A data policy narrows links further, as it does today: `view` lets them
  only view, `off` opens none.

**A change of domains closes what it stops**: every member's connections
and every visit of the workspace, as restricting a page does today, so
each connects again under the new domains.

### Older apps and older nodes

**The server's answers keep four roles and four levels.** `role` is the
base; each unit's `level` is one of the four, already cut by At most.
What is new comes beside them:

- `/api/me` gives, with each workspace, `may`, the account's settings
  there, the built-in ones while the feature is off; `customRoles`, the
  custom roles that hold for the
  account, each with the group that gives it, if one does; and
  `sharingDomains`, or null. At its top, `permissions` says whether the
  feature is on.
- `GET /api/v1/workspaces` gives `customRoles` beside `role`.

**Older apps keep working.** They show the base's name. They open each
unit at the level given, read-only below edit, so a Viewer's older app
reads General and changes nothing. A control the role takes away is
still offered, and the server answers 403, naming the role. Groups' access
shows as the units it opens. They cannot manage custom roles, groups or
domains, which need a current app.

**Older nodes** during a rolling upgrade read only `role` and
`unit_grants`: custom roles act as their bases, groups' grants and domains
do nothing, and a link for the domains would open for anyone on such a
node. So:

- **The Features page refuses to turn the feature on while the Nodes page
  lists a node of an older version**, and says which. A pin in the
  environment logs a warning instead, since it cannot be refused.
- **Rolling back** to a release before this item: turn the feature off
  first. The Features page says, before it turns it off, how many members
  hold custom roles and how many grants are groups'.

### Where it lives

**Core**, `apps/server`:

- the tables, in core's migrations, each only adding (ADR 0082), so a
  restore that runs core's migrations alone keeps them;
- `placeOf()`, the built-in settings, the union of sources and the
  checks that read them;
- `accessible()`, with groups' grants, At most, Teamspaces and the
  domains;
- `setRole` and invitations with custom roles, and their rules;
- `groupChanged()`;
- the domains' checks in invitations, grants, settling and links, and
  proved addresses where sessions start;
- `Permissions`, which knows the feature's switch and reads sharing
  domains, as `DataPolicies` does, given to every module in
  `EnterpriseServices.permissions`;
- `/api/me` and the API's new fields, and the audit names.

**`enterprise/permissions`**:

- the workspace's routes to manage what the feature adds: custom roles,
  its own groups and their members, groups' grants, its owners' domains,
  and **Remove those outside**. Off, they answer 404, as any module's do;
- the console's routes and its **Permissions** page: sharing domains for
  every workspace and for each set apart, and groups offered to
  workspaces.

**Giving a member a custom role** goes through core's members route, which
takes `customRole` beside `role`, and refuses it while the feature is off.
The console's Workspaces page and the directory's group mapping take a
custom role the same way, through `setRole` and `setMapping`.

### The apps and the console

The desktop and web apps share these, and the mobile apps with them:

- **The Members dialog.**
  - The role list has the built-in roles, then the workspace's custom
    roles, each with its base.
  - Each member shows their role and the groups that give them one.
  - **Roles**, for owners: each custom role with how many hold it, made,
    changed and deleted in a form of its ten settings, starting from its
    base.
  - **Groups**: the workspace's own, with their members, for those who
    manage them; and the directory's groups mapped or offered to it, with
    how many members each has here.
  - **Sharing**, for owners: the domains, or the instance admin's setting
    and why it holds; the people outside them; and **Remove those
    outside**.
- **The Share dialog** adds groups beside people, each with how many of
  its members are here; marks a person who also has access through a
  group; refuses an invitation outside the domains before it is sent, and
  says why; and makes links for the domains, listing paused ones as
  paused.
- **What `may` takes away is not offered**: a new teamspace, the private
  space, the members list, invitations, links, publishing, export, the
  workspace's settings and webhooks. The apps keep the last answer for
  when the server cannot be reached, as they keep a data policy.
- **The web app's link page** asks to sign in for a link for the domains,
  and says which domains.
- **The console**: the Features page has Advanced permissions; its
  Permissions page sets sharing domains and offers groups; the Workspaces
  page lists custom roles and gives them; and the directory's page maps a
  group at a custom role.

### Audit events

In ADR 0081's style, added to core's list of actions:

| Action | When |
| --- | --- |
| `role.created`, `role.changed`, `role.deleted` | An owner makes, changes or deletes a custom role: its name, base and settings, before and after |
| `member.role_changed` | Already named: its details gain the custom role, from and to |
| `grant.set`, `grant.removed` | Already named: a group's grant has the group as its target |
| `group.created`, `group.changed`, `group.deleted` | Already named: now also for a workspace's own groups, with the workspace |
| `group.member_added`, `group.member_removed` | Already named: likewise |
| `group.workspace_set`, `group.workspace_removed` | Already named: details gain the custom role, or `access` for an offer |
| `sharing.domains_changed` | Domains set or cleared, by an owner or an instance admin, for one workspace or every one, from and to |
| `member.removed` | Already named: `details.via` is `domains` for **Remove those outside** |

- **A refusal for the domains** is a failure of `invitation.created`,
  `invitation.accepted`, `grant.set` or `share_link.opened`, with the
  reason `outside_domains` or `address_not_proved`.
- **A visit of a link for the domains** has its account as its actor, and
  `details.link`.
- Every name fits syslog's `MSGID`, 32 characters.

### Migrations

Each part that changes the schema takes the next free number when it
merges, and only adds.

| Part | Adds |
| --- | --- |
| 2 | `custom_roles`: its workspace, name, base and settings. `memberships.custom_role`, `invitations.custom_role` and `group_workspaces.custom_role`, each by a key of the workspace and the role, so a role is only ever its own workspace's |
| 4 | `unit_group_grants`: a unit, a group and a level. `group_offers`: a group and a workspace. `groups.workspace_id`, for a workspace's own groups, which have no directory, with their names unique in the workspace |
| 6 | `workspace_sharing`: the owners' domains and an instance admin's for the workspace. `users.email_proved_at`, filled in. `share_links.audience`, `anyone` unless set. `link_visits.user_id`. The domains for every workspace are kept in `instance_settings` |

A row of the previous release's shape, with no custom role, no group
grant and no domains, means what it means today.

### Testing

- **Core**, on PGlite:
  - a table of every route and every built-in role, written before the
    first part and passing before and after it;
  - each setting where it is checked; the union of an own role and two
    groups'; At most in sync's read-only connections, the API's answers
    and the relay's writes; a custom role acting as its base while the
    feature is off; giving more than one has, refused;
  - groups' grants with people's, through restricted pages and their
    parents; teamspaces and guests; a unit keeping a person with full
    access; connections closed as a group changes; a mapping or offer
    removed taking its grants;
  - each refusal for the domains; open invitations; group places settled
    again; **Remove those outside**; links paused and opened again; a link
    for the domains refused anonymous, refused unproved, opened proved,
    and ended when its account is deactivated.
- **The sync engine** of the last release reads capped levels and opens
  read-only.
- **End to end**, in Chromium, with `CI=1`: an owner makes a Viewer and
  gives it, and the Viewer's editor is read-only in General; a page is
  granted to a group, and its member opens it; a link for the domains asks
  to sign in, then opens.

### Parts

Each from `origin/main`, one PR each, its guide pages in the same PR:

1. **What a role may do, in one place.** `placeOf()` and the built-in
   settings; every check reads them; `may` in `/api/me`; the `permissions`
   feature in the switches, with its module empty and its line on the
   Features page. No migration, and no answer changes, but that guests who
   edit a page may upload its attachments.
2. **Custom roles on the server.** The migration; the module's roles
   routes; `customRole` in the members route, invitations and group
   mappings; the union of sources and At most in `accessible()`; the
   relay; the refusals; `customRoles` in `/api/me` and the API; the
   Features page's check of older nodes; the audit names.
3. **Custom roles in the apps.** The Members dialog's roles; the apps
   offering only what `may` allows, keeping the last answer; the console's
   Workspaces and directory pages; the admin guide's page on roles.
4. **Groups' grants on the server.** The migration; groups' grants and
   offers; the workspace's own groups; `groupChanged()`, which the SCIM
   module then calls; groups in `accessible()`; the audit details.
5. **Groups in the apps.** The Share dialog's groups; the Members dialog's
   groups; the console's offers; the guide.
6. **Sharing domains on the server.** The migration; the domains and their
   checks; proved addresses; links for the domains and their visits;
   **Remove those outside**; the console's routes; `sharingDomains` in
   `/api/me`; the audit names.
7. **Sharing domains in the apps.** The Members dialog's sharing; the
   Share dialog's refusals and links; the web app's link page; the
   console's Permissions page; the guides. It ticks the roadmap item.

## Alternatives

- **Custom levels**, beside full access, edit, comment and view. An older
  sync engine drops a unit whose level it does not know, so a page would
  vanish from older apps; and a level finer than edit, as "edit but not
  delete", would need the sync server to read every update for what it
  does.
- **A role ID in place of `memberships.role`.** Every check in core,
  every older node and every older app reads the role's name; all would
  break at once.
- **Custom roles that only narrow, or only widen, their base.** Narrowing
  alone cannot make a member who manages members; widening alone cannot
  make a Viewer, which is the role organizations ask for first.
- **The least of a person's roles winning.** A directory's group could
  then take access away from someone in another group, and adding a group
  would need checking every other.
- **Custom roles for the whole instance**, made in the console. One
  organization's roles would be offered to another's workspaces on a
  shared server, and owners could not shape their own. A later item can
  copy roles between workspaces.
- **A setting for each action**, as making a link, inviting a guest,
  renaming a teamspace and so on, one by one. Full access already decides
  most of them; ten settings cover what organizations restrict, and a form
  of forty would not be read.
- **Group grants as rows of `unit_grants` with a group in place of a
  person.** Its key is the unit and the account; and older nodes reading
  it would see rows they cannot place.
- **A group grant placing its members as guests**, as an invitation to a
  page does. A node of the previous release, settling a membership, would
  remove such a guest, since it knows no such source. Mapping a group,
  and inviting guests, do it today; placing guests by grants can come
  later.
- **Every group of the instance grantable in every workspace.** Group
  names would show across organizations on a shared server.
- **Groups made only by an instance admin in the console.** A team without
  a directory would need the instance admin for every group of every
  workspace.
- **Domains as a data policy.** Data policies are the instance admin's
  alone; the requirement has owners restrict their own workspaces too.
- **No share links while a workspace has domains.** Simpler, but a link
  for colleagues is how most pages are passed around in an organization.
- **Links for the domains checking the session's method**, as an email
  code or a provider, instead of a proved address kept. People who sign in
  with a password would be sent through a code at every link.
- **Trusting any address for links.** An open invitation elsewhere on the
  server lets its holder type an address of the domain that has no
  account yet.
- **Removing everyone outside the domains when they are set.** Setting a
  field would take people out of a workspace without a word; one step that
  says what it does, and is recorded, does it.

## Consequences

- **Every role check in core reads one function.** Comparing role names
  outside it is a review comment from now on.
- **A Viewer, a membership manager and a teamspace-only member** are each
  a custom role; a person's access is the most their roles and groups
  give.
- **Older apps** show bases and keep to levels, and are refused, with a
  reason, what a role takes away.
- **Turning the feature off** gives each custom role its base, and drops
  groups' grants and domains. The Features page says how many people that
  changes before it does.
- **`accessible()` joins the account's groups**, in the one query it makes
  today, plus one for its sources' settings. Sync's checks of a connection
  pay for it; the desktop app's idle load does not change.
- **Amended**: ADR 0042's guests become the built-in guest role's
  settings, and a custom role based on a guest may join teamspaces;
  ADR 0071's visits may belong to an account; ADR 0085's groups may be
  offered to a workspace, and give a custom role.
- **Interfaces shared with work in progress.**
  - The LDAP pull, ADR 0085's part 4, calls `groupChanged()` once part 4
    here is on main.
  - The mobile apps (ADR 0087) read `may` in `/api/me` with the web app.
  - `EnterpriseServices` gains `permissions`.
- **Revisit** custom roles for the whole instance if organizations with
  many workspaces ask; groups placing guests by grants once every node
  runs this release; and a finer level than edit, if one is asked for
  that the sync server can enforce.

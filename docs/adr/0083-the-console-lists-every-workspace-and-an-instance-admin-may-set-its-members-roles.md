# 0083. The console lists every workspace, and an instance admin may set its members' roles

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask the admin console for "usage analytics, workspace management, security
settings in one place".
[ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)
put the console's pages beyond its switches in the `admin` feature, and
named its second part: the Workspaces page, each workspace with its owners,
members and size.

What it has to live with:

- **Only a workspace's members see it.** Its owners change anyone's role,
  its admins change members and guests, and it always keeps an owner
  (`members.ts`). A change closes the account's sync connections, so its
  apps connect again and every document is checked anew.
- **A workspace can lose its owners' hands.** When its only owner leaves an
  organization, no one can change its roles or settings. The instance
  admin, who answers for the server, has no way in but the database.
  Provisioning (SCIM), a later item, will end accounts on its own.
- **An encrypted workspace's notes are not the server's to read**
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).
  A role gives no key: a member's app seals the workspace's key to a member
  who lacks it.
- **Attachments are kept once by their hash**, and a workspace's rows name
  them. Deleting a workspace means collecting the files no other workspace
  names.

## Decision

**The Workspaces page lists every workspace on the server**, for instance
admins, while the `admin` feature is on.

- 50 a page, by name, with **More** for the next. A search finds a
  workspace by its name, or by a member's name or email.
- Each shows its name, whether it is end-to-end encrypted, when it was
  made, its owners by name and email, its members by role, its notes, its
  size, and when a document in it last changed.
- **Notes** are counted where the server can read them. An encrypted
  workspace shows **Encrypted** instead.
- **Size** is the bytes of its documents, of their history and of its
  attachments, read from the rows' lengths without reading the documents.
  Like the Usage page, it is counted when the page asks.

**A workspace opens to its members**: each one's name, email, role and the
day they joined.

**An instance admin may set a member's role**, to any of the four, under the
workspace's own rule: it keeps at least one owner.

- It is the way to give a workspace whose owners are gone a new one.
- One core function sets a role, for the workspace's own route and for the
  console, so the rules live in one place, and the audit log (ADR 0081)
  can record both, each with who acted.
- The change closes the account's sync connections, as the workspace's own
  change does. What the server shares with every module,
  `EnterpriseServices`, gains `disconnect(userId)` for it; single sign-on's
  enforcement (ADR 0080) needs it too, and high availability (ADR 0082)
  carries it to every node.
- A role changes no key. An encrypted workspace's guests read all of it
  already
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)),
  so a new role changes what someone may do there, not what they can read.

**What the console does not do.** It does not add or remove members,
which invitations and the workspace's owners do, and provisioning will. It
does not make the instance admin a member. It shows no note's title or
text, and no workspace's settings beyond these.

## Alternatives

- **A page that only lists.** A workspace with no owner left would still
  need the database.
- **The instance admin joining a workspace as its owner.** They would read
  all of it to fix one role, and in an encrypted workspace they would get
  no key anyway. Setting a role of someone already in it is enough.
- **Deleting workspaces from the console.** It needs attachments collected
  across workspaces, and data policies, a later item, decide what is kept
  and for how long. It comes with them.
- **Counting sizes from the documents' contents.** Reading every document
  of a large workspace for a listing is slow; the rows' lengths say the
  same.

## Consequences

- Instance admins can raise any member of any workspace to owner. The
  audit log records it, with the instance admin as its actor.
- A workspace whose last owner is ended by provisioning, later, can be
  given an owner in the console.
- The page's queries read every workspace's rows when asked, as the Usage
  page's do. They count, and never lock a workspace's writes.

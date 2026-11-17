---
title: The admin console
description: How a server's admin turns Nether's enterprise features on and off, in the admin console or by the server's settings, and sees the server's usage.
---

Nether's enterprise features are free and open source, under the same
license as the rest of it: single sign-on, provisioning, audit logs, data
policies, the admin console's own pages and high availability. Every
server has them all, each off until you turn it on. There is no license
key, no seat limit, and nothing the server reports to anyone: they work
air-gapped.

## Opening it

The admin console is a page of your server's web app, at
`https://<your server>/admin`. It opens for the server's instance admins:
the account that set the server up is one. In the desktop app, **Servers
and signing in** shows **Admin console of** your server beside an
instance admin's account, which opens it in your browser; sign in to the
web app there first.

## Features

**Features** lists each enterprise feature with its switch. Turn one on
or off and it takes effect at once, on every node of the server within
a few seconds, with no restart.

A feature the server's settings set shows **Set by** its variable, as
`NETHER_ENTERPRISE_AUDIT`, and no switch: set it to `on` or `off` in the
server's settings to fix it there, or remove it to leave the switch to the
console. A feature this server's build of Nether does not have yet shows
**Not in this server's build of Nether yet.**

**High availability** is the server's settings' alone, read as the
server starts: `NETHER_ENTERPRISE_HA=on` on every node makes them one
server, and the console shows it as set there. It describes how the
server is deployed, as its database's address does, so the console has no
switch for it.

## Nodes

**Nodes** lists the server's nodes that wrote their heartbeat in the last
two minutes: each one's name, its version, and when it started, the one
that answered the page marked. A node's name is `NETHER_NODE_NAME`, or
its machine's, as a pod's is. It is in every server, beside the features.

A server running more than one node without high availability says so in
its log: their clients do not see each other's edits until they are
stored.

## Usage

With **The console's usage, workspaces and security pages** on, the
console shows the server's **Usage**, counted when you open it, or when
you choose **Count again**:

- **Accounts**, and those **signed in during the last 30 days**;
- **Workspaces**, and how many of them are end-to-end encrypted;
- **Notes the server can read**: an encrypted workspace's are not counted,
  since the server cannot read them;
- **Attachments**, and their size;
- **The server's version**.

## Workspaces

**Workspaces** lists every workspace on your server, 50 at a time, by
name; **More** shows the next 50. To find one, type part of its name, or
part of a member's name or email address, and choose **Find**.

Each workspace shows:

- its name, **End-to-end encrypted** when it is, and **No active owner**
  when its owners have left or been deactivated;
- its **Owners**, by name, each marked **(deactivated)** when their
  account is;
- how many **Members** it has, guests too;
- its **Notes**: **Encrypted** for an encrypted workspace, whose notes the
  server cannot read;
- its **Size**: its notes, their history and its attachments, as the
  server stores them;
- its **Last change**, when a note in it last changed on the server.

**Only those with no active owner** lists those alone, for you to give
each a new owner. The console never shows a note's title or text.

### Giving a workspace a new owner

Choose a workspace's name to see its members: each one's name, email,
role and the day they joined, and **Deactivated** beside an account that
signs in no way. Set a member's **Role** there, to owner,
admin, member or guest. This is how a workspace whose owners have left
gets a new one.

- A workspace keeps at least one active owner: make someone else an owner
  first, then change the last one's role. An owner whose account is
  deactivated does not count.
- The member's apps connect again at once, and work by the new role.
- The console does not add or remove members, and does not make you one.
  A workspace's owners invite and remove people, as before.

## Security

**Security** sets how people sign in to your server and how long they
stay signed in. Change any of these, then choose **Save**; they apply on
every node within a few seconds, with no restart.

**Sessions**

- **Days a session lasts unused**: 30 unless you change it, from 1 to 365.
- **Days a session lasts, however much it is used**: 90 unless you change
  it, from 1 to 3650.

A change applies to every session at once. Make either shorter, and
sessions past the new length end at their next request: their apps ask
people to sign in again. Make it longer, and sessions keep going.

**Signing in**

- **Sign-in tries per account, in 15 minutes**: 10 unless you change it,
  from 3 to 100. After that many, signing in to that account waits.
- **Sign-in tries per address, in 5 minutes**: 30 unless you change it,
  from 5 to 1000. It counts tries from one network address, with
  passwords and email codes alike.
- **Sign in with a code by email**: on unless you turn it off. Codes go
  out only when the server can send email. Turn it off to have people
  sign in with a password or your OpenID Connect provider alone.

**Ways to sign in now** lists what the server offers: a password, a code
by email, and your OpenID Connect provider, by name.

Your server's settings can set any of these instead, as
`NETHER_SESSION_IDLE_DAYS=7`. The console then shows **Set by** its
variable, and no control. The
[server's settings](https://github.com/fzn0x/nether/tree/main/apps/server#configuration)
list each variable and its range.

## Single sign-on

With **Single sign-on** on, the console's **Single sign-on** page adds
the providers people sign in through: SAML 2.0, or OpenID Connect. The
apps offer each by its name, as **Sign in with Corp SSO**, beside the
server's own ways in. The page needs `NETHER_PUBLIC_URL`, which providers
send people back to, and `NETHER_SECRET_KEY`, which seals each provider's
key and client secret on the server. A provider the server's settings set,
`NETHER_OIDC_ISSUER`, shows there as set by them and signs in as before.

### Adding a provider

Choose **Add a provider**, then:

- **Short name**: lowercase letters, digits and hyphens, as `corp`. It is
  part of the provider's addresses at Nether and does not change.
- **Name**: what the sign-in button shows.
- **Email domains**: the domains this provider is trusted for, one a line,
  as `corp.example`. A domain belongs to one provider at most.
- **Make an account on a first sign-in at these domains**: on, anyone the
  provider lets use Nether gets an account the first time; off, they need
  an account already, or an invitation.

For **SAML 2.0**, give the provider's metadata: its address, which the
server reads again each day, so a certificate the provider rolls over is
taken; or the metadata itself, pasted, for a server with no way to reach
it. Then open **What to give the provider** and set up Nether there:

| The provider asks for | Give it |
| --- | --- |
| Entity ID, audience or SP issuer | **Entity ID**, as `https://<your server>/api/sso/corp/saml/metadata` |
| Assertion Consumer Service, reply or single sign-on URL | **Assertion Consumer Service address**, as `https://<your server>/api/sso/corp/saml/acs` |
| Metadata, if it reads it | **Nether's metadata**, the same address as the entity ID |
| A certificate to check requests or encrypt to | **Nether's certificate** |

The provider must sign its assertions. Nether signs its requests, and
asks for no NameID format and no way of signing in, so the provider's own
policy, such as multi-factor sign-in, decides. Have the provider send the
person's email address as `email` or its usual names, and a NameID that
stays the same for each person; if it sends a transient one, name an
attribute that does, under **Attributes**. **Require encrypted
assertions** refuses an answer whose assertion the provider did not
encrypt to Nether's certificate.

- **Keycloak**: make a SAML client whose client ID is Nether's entity ID,
  with **Sign assertions** on and Nether's address as a valid redirect
  URI; give it Nether's certificate under **Keys** to check its requests
  and to encrypt.
- **Okta**: make a SAML app integration, with the Assertion Consumer
  Service address as its single sign-on URL, the entity ID as its
  audience, **Assertion Signature** signed, and an `email` attribute
  statement. Give Nether its metadata's address.
- **Microsoft Entra ID**: make an enterprise application with SAML single
  sign-on, the entity ID as its identifier and the address as its reply
  URL, and give Nether its **App Federation Metadata Url**. Name
  `http://schemas.microsoft.com/identity/claims/objectidentifier` under
  **Attributes**, as who each person is.

An app's tile at the provider should open Nether's sign-in, not post an
answer of its own: Nether takes answers only to the requests it made.

For **OpenID Connect**, give the provider's **Issuer**, its client's
**Client ID**, and its **Client secret**, none for a public client. The
provider sends people back to the **Redirect address** the page shows, as
`https://<your server>/api/sso/corp/oidc/callback`: register it there.
An issuer for every tenant at once, as Entra ID's `common`, is refused:
give your own tenant's.

- **Okta**: make an OIDC web app integration with the redirect address
  as its sign-in redirect URI, and give Nether its issuer, as
  `https://<your org>.okta.com`, with the client's ID and secret.
- **Microsoft Entra ID**: register an application with the redirect
  address as a web redirect URI, add a client secret, and give Nether
  `https://login.microsoftonline.com/<your tenant ID>/v2.0` as its
  issuer. Add the `email` optional claim: Entra ID says nothing of
  whether an address is verified, so Nether trusts one only at the
  provider's own domains.

### Who signs in

A provider's first sign-in for someone finds their account by the email
address it gives, when that address is at one of its domains, or, for an
OpenID Connect provider, when it says it verified the address. After that,
the provider's sign-in finds the account by who the provider says it is,
whatever address it gives later. An address at another domain links
nothing through SAML, whose answers cannot say they verified it.

### Requiring single sign-on

A provider can be required at its domains: change it, and turn on
**Require it: accounts at these domains sign in through it alone**.
Under **What single sign-on requires**, the page can also require it of
everyone:

- **Everyone signs in through a provider**: every account does. One at
  a provider's domains uses that provider; one at no provider's domain
  may use any provider it is linked to, the server's own
  `NETHER_OIDC_ISSUER` among them.
- **Instance admins too**: off, as it starts, instance admins keep their
  passwords and email codes, so one can sign in to fix a provider that
  breaks. The page warns when no instance admin has a password and the
  server sends no codes.

An account single sign-on covers cannot sign in with a password or a
code, join a workspace by setting a password, set one, or sign in
through another domain's provider. A sign-in through its provider in
the last ten minutes, not its password, lets it end its other sessions
or make a token. Its sessions and tokens that began another way end as
the page saves the change, its apps connect again, and any that remain
end at their next request; turning the requirement off later brings
none back. The page will not save a change that would end your own
session: sign in through the provider first.

The apps ask for the email address first, and go straight to its
domain's provider. Under **Everyone**, they offer the providers, and the
password and the code only behind **Sign in as an instance admin**. A
password at a required domain gets an answer naming its provider; under
**Everyone**, one elsewhere answers as a wrong password does. Neither
tells whether an account exists.

**If a provider breaks** and instance admins are covered too, set
`NETHER_SSO_ENFORCE=off` on the server and restart it: sign-in through
the providers goes on, and every other way in comes back until it is
unset. `NETHER_ENTERPRISE_SSO=off` turns single sign-on off altogether.

## Provisioning

With **Provisioning** on, the console's **Directories** page adds the
directories that make, change, deactivate and remove the server's
accounts: an identity provider that speaks SCIM 2.0, as Okta or Microsoft
Entra ID, for the people it assigns to Nether. The page needs
`NETHER_PUBLIC_URL`, the address a directory reaches the server at.

### Adding a directory

Choose **Add a directory**, then:

- **Short name**: lowercase letters, digits and hyphens, as `okta`. It is
  part of the directory's address and does not change.
- **Name**: what the console and the audit log call it.
- **Email domains**: the domains this directory speaks for, one a line.
  A domain belongs to one directory at most.
- **Make accounts at other domains too**: for a server with one
  organization, whose directory holds guests and contractors at their own
  addresses. Off by default.

Then **Make a token**. It lasts a year unless you pick another length,
two years at most, and is shown once: copy it into the directory now.
The page shows its last characters and when it ends, and warns a month
before; the server's log warns each day of its last week. **Make a new
token** replaces it at once, and **Revoke the token** ends it. A token
works only at its own directory's address.

Give the directory its **SCIM address**, as
`https://<your server>/api/scim/okta/v2`, and the token, as a bearer
token.

- **Okta**: in your app integration, turn on SCIM provisioning. Give it
  the SCIM address as its base URL, `userName` as the unique identifier
  for users, and the token as a bearer token in the HTTP header. Turn on
  pushing new users, profile updates and deactivating users.
- **Microsoft Entra ID**: in your enterprise application, set
  provisioning to automatic. Give it the SCIM address as its tenant URL
  and the token as its **Secret Token**, then **Test Connection**. Both
  of Entra ID's forms of requests are taken, with its
  `aadOptscim062020` flag or without it.

### What a directory does

- **It makes accounts** at its domains. An account it makes has no
  password: its person signs in through single sign-on, the server's
  OpenID Connect provider, or an email code. The page warns when none of
  these is set up. Its address is the directory's primary email, and its
  name the directory's display name.
- **It takes over an account** that already has the address, at one of
  its domains, when no other directory manages it: the account keeps its
  password, workspaces and sign-ins. It never takes an account at a
  domain it does not speak for.
- **It deactivates an account** when the person is unassigned or
  disabled: the account signs in no way, its sessions and API tokens
  end, and its apps are disconnected. It keeps its workspaces and roles,
  and comes back as it was when the directory turns it on again.
- **It removes an account**, as Entra ID does 30 days after a soft
  delete: the account is deactivated, leaves every workspace, and the
  directory lets it go. The account itself stays, deactivated, as a
  record. While a workspace it is in is on legal hold, it stays
  deactivated and in its workspaces, and the directory is told so; Entra
  ID tries the removal again in a later cycle. Okta never removes, only
  deactivates.
- **It never deactivates the server's last active instance admin.**

Nether keeps a person's name, addresses and whether they are active. What
else a directory sends, as phone numbers, a title or the enterprise
extension's fields, is taken and not kept, and a password never is.
Microsoft's SCIM validator reports those attributes missing after a
write; that is expected.

**Removing a directory** leaves its accounts as they are, active or not,
managed by no directory.

### Groups

A directory pushes its groups too: Okta through its group push, Entra ID
with the groups assigned to the app. A group's members are accounts the
same directory manages; a group is never a member of another. Open
**Groups and their places** under a directory to see its groups, each
with how many members it has.

- **Give a place**: choose a workspace and a role, owner, admin or
  member, and the group's members have that place there at once. A
  group never makes a guest.
- A member keeps the higher of its own role and the roles its groups
  give. When the group lets them go, or loses its place, they keep only
  their own role, or none: someone only a group placed leaves the
  workspace, and their apps connect again and are refused.
- **Take away** removes the group's place in that workspace, the same way.
- A workspace's owners may raise a member above what its groups give,
  which makes that role the member's own. They cannot lower it below its
  groups or remove it, and the member cannot leave: the members list says
  which group gives the place, and the directory changes it.
- Someone a group places in an end-to-end encrypted workspace waits for a
  member online to give them its key, as anyone new does.
- **Removing a directory** keeps each place its groups gave, as the
  member's own role.

Reading an LDAP directory comes next.

## AI endpoints

With **Data policies** on, the console shows **AI endpoints**: the
addresses every Nether app may send AI requests to, for every workspace on
your server. Use it to keep your organization's text on the models you
approve, such as your own at `https://llm.example.com/v1`.

Type the approved addresses, one a line, and choose **Save**. While the
list holds one:

- the desktop and web apps use only a provider at one of these addresses,
  or under one: `https://llm.example.com/v1` allows
  `https://llm.example.com/v1/team`, not `https://llm.example.com/v2`;
- people see which addresses you approved in their AI tab, and a provider
  elsewhere marked as not allowed;
- the server refuses to keep or relay to a provider elsewhere for the web
  app.

An empty list locks nothing, and so does turning **Data policies** off.
Your server's settings can set the list instead, as
`NETHER_AI_ENDPOINTS=https://llm.example.com/v1`, a comma between
addresses; the console then shows **Set by** that variable.

The lock keeps Nether's apps to your endpoints. It cannot stop another
program on someone's computer from reading their vault's files, or an app
older than this one, which does not know the lock. Network rules on your
organization's devices close that gap.

## Data policies

With **Data policies** on, the console also shows a **Data policies**
section: how far your workspaces are shared in public, whether their
text leaves the server by export, how long their history is kept, and
legal hold. Set a policy for **Every workspace**,
then set any workspace apart with its own: pick it under **Set a
workspace apart** and choose **Set apart**. It starts from every
workspace's policy. **Use every workspace's** puts it back. Each form saves
on its own.

| Setting | What it does |
| --- | --- |
| Share links | **Open at any level**, **View only**, or **Off** |
| Serve published sites | Off: no site of the workspace is served or published |
| Allow export | Off: the public API gives none of the workspace's text |
| Keep history, in days | How long the server keeps its notes' earlier states, 1 to 3650; empty for `NETHER_HISTORY_DAYS` |
| Keep the apps' trash, in days | How long its members' apps keep its vaults' trash, 1 to 3650; empty for each vault's own |
| Legal hold | Nothing of the workspace is deleted for good while it is on |

A workspace's owners keep their own switches, as publishing off; a policy
only narrows them, and they cannot change it.

- **Share links, View only.** A new link may only view, and a link made to
  comment or edit opens to view. People visiting by a link are
  disconnected when you save, and connect again only to view.
- **Share links, Off.** No new link, and every link of the workspace tells
  its visitor that the server's policy stops it. The links are kept, and
  open again when you allow them.
- **Published sites off.** The workspace's sites answer as not published,
  on your server's address and on their own domains, and no one publishes.
  The sites are kept, and come back when you allow them.
- **Export off.** The [public API](../api/) refuses a note's Markdown, a
  database's rows, and a search in the workspace, with 403. A search of
  every workspace leaves it out. Lists of notes' names and paths, and
  writes, go on.
- **History.** The server's hourly purge keeps each workspace's earlier
  states for its own days, longer or shorter than `NETHER_HISTORY_DAYS`.
- **Legal hold.** The server keeps every earlier state of the workspace's
  notes, whatever its days, and the audit log purges nothing while any
  workspace is on hold, as its purge cuts the oldest events of all.
  Putting a workspace on hold, and taking it off, is in the audit log, as
  every change of a policy is. People keep writing, moving and deleting
  notes: only deleting for good waits.

A change holds at once on the server you saved it on, and within five
seconds on the others. Turning **Data policies** off narrows nothing, and
keeps what you set for when it is on again.

The apps keep to it too. With export off, a vault linked to the
workspace offers no export: the **Export** dialog and a database's
**Export CSV** say that your server's policy keeps its notes. The app asks
your server as an export starts, and holds to its last answer while the
server cannot be reached. The **Share** dialog offers only view links
while links may only view, and says why it offers no link or site when
they are off.

The apps keep the trash to it too: a vault linked to the workspace keeps
its trash for the policy's days in place of its own, and, on legal hold,
deletes nothing in it for good and offers no **Delete for good** or
**Empty trash**, saying why. The app asks your server a little after the
vault opens, before it purges, and holds to its last answer while the
server cannot be reached. A desktop vault's files are on its device, the
person's own: no
policy stops another program from reading them. Device management on your
organization's computers is the tool for that.

## Audit logs

With **Audit logs** on, the server keeps a log of every sign-in, permission
change, share, export and deletion, and the console shows it under **Audit
log**, the newest first. Each event says who did it, what they did, in
which workspace, when, and from which address and client. It keeps IDs
and names, never what a note says, a search, a password or a token.

| Kind | What it records |
| --- | --- |
| Sign-ins | Signing in, by password, an emailed code, OpenID Connect, single sign-on, an invitation or setup, and each failure with why; signing out; sessions ended; a password changed; a share link opened, or refused |
| Permission changes | Members joined, removed or leaving, and their roles; a space's or a page's access given or taken; teamspaces, pages shared on their own, private spaces; a note moved where others may open it; an encrypted workspace's key given to a member; workspaces made or changed; API tokens made; enterprise features turned on or off; the security settings, single sign-on's providers and whether it is required, and the approved AI endpoints, each from and to; data policies changed, and legal hold set or taken off |
| Shares | Share links made and revoked; sites published, changed and taken down, and their domains; publishing allowed or not; invitations made, revoked and accepted; webhooks |
| Exports | Each request to the [REST API](../api/) that gives notes' text, rows or search results, naming up to 50 notes and counting the rest; each export the desktop and web apps make from a vault linked to a workspace, with what, in which format and how many notes; the server's backups |
| Deletions | Notes deleted, in the apps or through the API; API tokens revoked |

With **Provisioning** on, a directory's changes are recorded too, with the
directory as who made them: the accounts it makes, takes over, changes,
deactivates, reactivates and lets go, and the places they leave. The
console's changes to directories and their tokens are recorded as an
instance admin's, never with a token.

A change is recorded in the same step as the change itself: with the log
on, a change it cannot record does not happen. An end-to-end encrypted
workspace's notes are named by their IDs only, and its notes deleted in the
apps are not seen, since the server cannot read their list. The apps tell
the server of their exports as they make them: one made offline goes
untold, and the server can vouch only for what it serves.

### Finding events

Find events by **Email**, as an account had it or as someone typed it to
sign in; by **Kind**; by **Workspace**; by **Outcome**; and by the days
**From** and **To**. Fifty show at a time: **Older** shows the next. Each
event shows by its name, as **Signed in**, with its code beside it, as
`session.signed_in`, the name a SIEM sees. Each event's **Details** show
its address, client and what changed, as a role from and to. **Only
theirs** beside someone shows their events alone.

### Keeping the log

The log keeps its events 365 days. Change it under **Keep events for**,
from 30 days to ten years, or set `NETHER_AUDIT_RETENTION_DAYS` in the
server's settings to fix it there. Once an hour the server deletes the
events older than that, and records that it did.

The log is append-only: the server never changes or deletes an event but
by that hourly purge, and the database refuses anything else. Each event
is chained to the one before by a hash, under a key from
`NETHER_SECRET_KEY` when the server has one, so a changed, removed or added
event shows. **Check the log** checks the whole chain and names the first
event that does not hold. Once an hour the server also writes the chain's
last event to its own log, so events cut off the end show against those
lines. Changing settings, adding a destination and checking the log are
events too; searching is not.

### Sending to a SIEM

Under **Sending to a SIEM**, the log goes to up to five destinations as it
is written: a syslog server over TLS, or a webhook. Each gets every event,
in order. **Start with** sends the events from then on, or every event the
log keeps.

- **Syslog over TLS**: a host, with its port if not 6514. Each event is an
  RFC 5424 message, framed by its length as RFC 5425 has it, with facility
  13, log audit, the action as its `MSGID`, and the event as JSON. The
  server connects by TLS 1.2 or later, and checks the syslog server's
  certificate against the system's authorities, a certificate authority
  you paste in, or its SHA-256 fingerprint. For mutual TLS, set
  `NETHER_AUDIT_SYSLOG_CERT` and `NETHER_AUDIT_SYSLOG_KEY` to the files of
  the client certificate and its key. There is no plain TCP and no UDP.
- **Webhook**: an `https://` address, or `http://` to one on your own
  network, which a SIEM often is. Each `POST` holds up to 100 events, as
  `{"type": "audit.events", "timestamp": ..., "data": {"events": [...]}}`,
  signed as [Standard Webhooks](https://www.standardwebhooks.com) has it
  with a `whsec_` secret the console shows once, as you add it. A batch
  keeps its `webhook-id` on every try. Its events carry `hash` and
  `prevHash`, so the SIEM can check the chain too. The server keeps the
  secret sealed under `NETHER_SECRET_KEY`, so a webhook needs it set.

A destination that fails waits 30 seconds, then a minute, 2, 5 and 10,
then every 15 minutes for as long as it fails, and goes on from where it
stopped. It is never turned off on its own. The console shows each one's
last delivery, the events waiting and its last error, and the server's
log says so every hour while it fails. A syslog server may get an event
twice after a broken connection: drop it by its `id`. Nothing is lost but
what the hourly purge deletes first, and the purge records that as
**Events a SIEM never got**, `audit.export_gap`, with the events each
destination missed.

The server's settings can pin one destination of each kind, which the
console shows with no control:

| Setting | What it does |
| --- | --- |
| `NETHER_AUDIT_SYSLOG` | A syslog server, as `siem.example.org:6514` |
| `NETHER_AUDIT_SYSLOG_CA` | A file holding the certificate authority it is checked against, in PEM |
| `NETHER_AUDIT_SYSLOG_FINGERPRINT` | Or its certificate's SHA-256 fingerprint |
| `NETHER_AUDIT_WEBHOOK` | A webhook's address |
| `NETHER_AUDIT_WEBHOOK_SECRET` | Its `whsec_` secret, which you make, as `whsec_` and 32 random bytes in base64 |

A pinned destination starts with the events from then on. One set wrong
stops the server as it starts, naming the setting.

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

- its name, and **End-to-end encrypted** when it is;
- its **Owners**, by name;
- how many **Members** it has, guests too;
- its **Notes**: **Encrypted** for an encrypted workspace, whose notes the
  server cannot read;
- its **Size**: its notes, their history and its attachments, as the
  server stores them;
- its **Last change**, when a note in it last changed on the server.

The console never shows a note's title or text.

### Giving a workspace a new owner

Choose a workspace's name to see its members: each one's name, email,
role and the day they joined. Set a member's **Role** there, to owner,
admin, member or guest. This is how a workspace whose owners have left
gets a new one.

- A workspace keeps at least one owner: make someone else an owner first,
  then change the last one's role.
- The member's apps connect again at once, and work by the new role.
- The console does not add or remove members, and does not make you one.
  A workspace's owners invite and remove people, as before.

The console's security page comes in a later version.

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

### Who signs in

A provider's first sign-in for someone finds their account by the email
address it gives, when that address is at one of its domains, or, for an
OpenID Connect provider, when it says it verified the address. After that,
the provider's sign-in finds the account by who the provider says it is,
whatever address it gives later. An address at another domain links
nothing through SAML, whose answers cannot say they verified it.

Making people sign in only through single sign-on, refusing their
passwords and codes, comes in a later version.

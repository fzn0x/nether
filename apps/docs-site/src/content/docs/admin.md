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

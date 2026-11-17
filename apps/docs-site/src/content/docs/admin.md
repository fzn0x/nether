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

The console's workspaces and security pages come in a later version.

## Audit logs

With **Audit logs** on, the server keeps a log of every sign-in, permission
change, share, export and deletion, and the console shows it under **Audit
log**, the newest first. Each event says who did it, what they did, in
which workspace, when, and from which address and client. It keeps IDs
and names, never what a note says, a search, a password or a token.

| Kind | What it records |
| --- | --- |
| Sign-ins | Signing in, by password, an emailed code, OpenID Connect, an invitation or setup, and each failure with why; signing out; sessions ended; a password changed; a share link opened, or refused |
| Permission changes | Members joined, removed or leaving, and their roles; a space's or a page's access given or taken; teamspaces, pages shared on their own, private spaces; a note moved where others may open it; an encrypted workspace's key given to a member; workspaces made or changed; API tokens made; enterprise features turned on or off |
| Shares | Share links made and revoked; sites published, changed and taken down, and their domains; publishing allowed or not; invitations made, revoked and accepted; webhooks |
| Exports | Each request to the [REST API](../api/) that gives notes' text, rows or search results, naming up to 50 notes and counting the rest; the server's backups |
| Deletions | Notes deleted, in the apps or through the API; API tokens revoked |

A change is recorded in the same step as the change itself: with the log
on, a change it cannot record does not happen. An end-to-end encrypted
workspace's notes are named by their IDs only, and its notes deleted in the
apps are not seen, since the server cannot read their list.

### Finding events

Find events by **Email**, as an account had it or as someone typed it to
sign in; by **Kind**; by **Workspace**; by **Outcome**; and by the days
**From** and **To**. Fifty show at a time: **Older** shows the next. Each
event's **Details** show its address, client and what changed, as a role
from and to. **Only theirs** beside someone shows their events alone.

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

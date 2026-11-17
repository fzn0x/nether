---
title: Integrations
description: How to connect Nether to your other services, starting with calendars from ICS feeds, whose events show in your daily notes, with every secret kept in your system's keychain.
---

Nether's integrations bring what you keep at other services into your
notes. They start with calendars: the events of an ICS feed, such as
Google Calendar's secret address, show beside a note and in your daily
notes. CalDAV, GitHub, Google Drive and Slack come next, as the
[roadmap](https://github.com/fzn0x/nether/blob/main/docs/roadmap.md)
says.

Each integration is a plugin that comes with Nether, off until you turn
it on in a vault. It reaches a service only through a **connection**:
your account there, which the app keeps and uses for it. No plugin ever
sees a connection's password, token or secret address.

## Connections

Open the settings from the **Settings** menu and choose
**Connections**. The tab lists the connections kept on this computer.
Each vault on it can use them; a vault's integrations are its own to
turn on.

A connection's secret is kept in your system's keychain: the Keychain on
macOS, the Credential Manager on Windows, the Secret Service on Linux.
It is never written to a file or a vault, and never syncs. **Remove**
forgets a connection, and its secret leaves the keychain.

### An ICS feed

Most calendars give a feed of their events in iCal format. In Google
Calendar, it is a calendar's **Secret address in iCal format**, in its
settings; in Outlook, a published calendar's ICS link; in Apple's iCloud,
a public calendar's link. Click **Add an ICS feed**:

- **Feed address**: the feed's address, starting with `https://` or
  `webcal://`. A feed's address is often its secret, so only its host
  shows once it is added, as "ICS feed at calendar.google.com."; the whole
  address is kept in the keychain.
- **Name**: what the calendar is called here, as "Work". The feed's host
  if you leave it empty.
- **The feed asks for a user name and password**: for the few feeds
  behind a password.

**Check and add** reads the feed first, and adds it only if it gives a
calendar. In the desktop app, an address on your own network may start
with `http://`.

## Calendar

Turn on **Calendar** in the **Plugins** tab of a vault's settings, under
**Integrations**. It asks for your ICS feeds, and to read and change the
vault's notes, to add events to a note when you ask.

**Beside a note**, the **Events** panel shows the day's events from every
feed: a daily note's day, or today beside any other note. Each event
shows its time, its title and its place. **Add to the note** adds them to
the end of the note as a list any Markdown app reads:

```markdown
- All day: Release
- 09:00-09:30 Standup (Room 2)
```

**In a note**, a `calendar` code block shows the events of one day or
more. Type `/` and choose **Events**, or write it yourself:

````markdown
```calendar
day: 2026-11-17
days: 3
calendars: Work, Home
```
````

- `day`: the first day, as `2026-11-17`, or `today`. Without it, a daily
  note's block shows the note's day, so a daily note template can hold
  the block with nothing in it; any other note's shows today.
- `days`: how many days, from 1 to 31; 1 unless it says.
- `calendars`: the feeds it shows, by their names; every feed unless it
  says.

In Obsidian, or with the plugin off, the block stays readable text.

A block shows the events of whoever opens the note: in a shared daily
note, each member sees their own calendars. Only **Add to the note**
writes events where others can read them.

### When feeds are read

Nothing is read until a block or the panel shows. Then a feed is read
again when what was kept of it is older than the plugin's **Refresh
every** setting, 15 minutes unless you change it, and when you click
**Refresh** in the panel. A feed that has not changed sends nothing again.

The calendar keeps the events from a month back to a year ahead on this
computer, in the vault's index, outside its folder: it never syncs. A day
outside them is read when it is shown. Offline, the calendar shows what it
kept, and when it was read; a feed that could not be read says why.

Recurring events, the occurrences moved or left out of them, and time
zones are read as the feed writes them. Times show in your computer's
time zone.

## Where integrations run

Integrations run in the [sandbox](../plugins/#the-sandbox), apart from
the app, as a plugin from a vault does: what a feed says cannot reach the
app, and what the plugin draws is cleaned before it shows. Each one on
costs a few megabytes while you use it, and nothing while it is off.

The web app and the mobile apps have no integrations yet: the web app's
connections will be kept on its server, sealed, in a later part.

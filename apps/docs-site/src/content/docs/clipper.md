---
title: Web clipper
description: Save a page or a selection as Markdown to a note or a database on your own Nether server, from Chrome or Firefox.
---

The Nether web clipper is a browser extension for Chrome and Firefox. Its
button saves the page you are reading, or what you selected on it, as
Markdown: as a new note, added to a note, or as a row of a database, on
your own Nether server.

## Install it

The clipper is not in the browsers' stores yet. Until it is, build it from
the repository and load it yourself:

```sh
git clone https://github.com/fzn0x/nether.git
cd nether
pnpm install
pnpm --filter @nether/clipper build
```

- **Chrome**, and browsers built on Chromium, as Edge or Brave: open
  `chrome://extensions`, turn on **Developer mode**, choose **Load
  unpacked**, and pick `apps/clipper/dist/chrome`.
- **Firefox** 140 or later: open `about:debugging#/runtime/this-firefox`,
  choose **Load Temporary Add-on**, and pick
  `apps/clipper/dist/firefox/manifest.json`. Firefox keeps a temporary
  add-on until it closes.

## Connect it to your server

The clipper signs in with an API token that reads and writes. Make one in
Nether: open **Servers and signing in**, choose **API tokens on** your
server, and make a token with **Reads and writes**, for the one workspace
your clips go to, if you like. Copy it.

Then press the clipper's button. Type your server's address, such as
`nether.example.org`, paste the token, and choose **Connect**. The browser
asks to let the clipper reach that server; it asks for nothing else.

The clipper keeps the address and the token in the browser's own storage,
on this computer: the browser does not sync them. **Disconnect** forgets
both. To stop a token everywhere, revoke it in Nether.

## Clip a page

Press the button on the page to clip:

- **The selection**, when you selected something, is clipped as it is.
- **The whole page** is clipped as a reader view shows it: its article,
  without its menus, sidebars and footer.

The popup shows the clip as Markdown, to change before you save it. Links
and images keep their full addresses. Then choose a workspace, and how to
save it:

- **A new note**, in the folder you choose, `Clips` unless you change it,
  named by the page's title. Its properties say where it came from:
  `source`, the page's address; `clipped`, the day; and `author`, when the
  page names one.
- **Added to a note**: find the note by a word of its title or its text.
  The clip goes at its end, under a heading of the page's title, which
  links to the page. If someone changes the note while the clip is saved,
  the clipper reads it again, so nothing they wrote is lost.
- **A database row**: choose the database, and the clip becomes a row in
  its folder, with the same properties as a new note.

**Save the clip** says where it went. Your devices sync it, and someone
with the note open sees it arrive.

Encrypted workspaces take no clips: the server cannot read them, so it
cannot add to them. A page of the browser's own, as its settings or its
store, cannot be clipped.

## What it sends, and where

The clipper sends what you clip to your server, and only there: no
telemetry, no other address, and no code from anywhere else. It reads a
page only when you press its button, and only that page.

## For developers

The clipper is `apps/clipper` in the repository: a Manifest V3 extension
built with Vite, which saves clips through the server's
[REST API](../api/). Its
[README](https://github.com/fzn0x/nether/blob/main/apps/clipper/README.md)
covers building, loading and testing it.

---
title: Publishing
description: How to publish a page with its subpages, or a folder, as a public site your Nether server serves, on its address or a custom domain, with what search engines read.
---

A Nether server can publish a page, with its subpages, or a whole folder,
as a site anyone can open in a browser, with no account and no app. The
site is drawn from your notes as they are now: an edit shows on it a few
seconds after it syncs, and there is no step to publish changes.

## Publishing a site

With a note open in a vault that syncs, open **Share this page** from the
command palette or the **Sync** menu. Under **Publish to the web**:

1. Choose what to publish: **This page and its subpages**, or **Its
   folder**, the folder the note is in. A page's subpages are the notes in
   the folder beside it.
2. Give the site a **Site name**: 3 to 63 lowercase letters, digits and
   hyphens, unique on the server. The site's address ends with `/p/` and
   this name, as `https://nether.example.org/p/handbook/`.
3. Choose **Publish this page**, or **Publish the folder**. The site's
   address is copied.

The dialog then lists the sites the page is on. **Copy address** copies a
site's address again; **Unpublish** takes the site down, and its address
opens nothing at once.

A page's address on the site is its path under what was published,
without `.md`: `Setup.md` in the folder beside `Handbook.md` is at
`/p/handbook/Setup`. A page site opens at the page; a folder site opens at
a list of its pages.

## What a site shows

- **The notes you have full access to.** A site is published as you: it
  shows the notes under it that you can fully open when someone visits,
  not those of a page shared with you to view or edit only. If you lose
  access to a note, it leaves your sites; if you leave the workspace, your
  sites go with you.
- **Not a note marked private.** A note with `publish: false` in its
  properties is left out.
- **Links between its own pages only.** A link to a note on the same site
  leads to its page. A link to any other note is plain text, and the site
  gives nothing of that note away. Web addresses stay links.
- **Images and files** the pages show. Those kept in the vault are served
  by your server, and only on a site whose page links to them. An image
  from another site loads from that site, which then sees the addresses of
  the people who visit the page.
- **Text, headings, lists, tables, callouts, code with its colors and
  math.** Properties are not shown. A diagram or a plugin's block shows its
  code, and an embedded note shows as a link to its page.

Pages run no script: they are plain HTML, and load at once.

## Who publishes

- **Anyone with full access** where the page or folder is publishes it.
  They, and the workspace's owners and admins, unpublish it.
- **Owners and admins turn publishing off** for a workspace, under
  **Publish to the web** in the dialog. While it is off, its sites open
  nothing and no one publishes; turned on again, the sites come back.
- **An encrypted workspace publishes nothing**: the server cannot read its
  notes.
- **The server's admin may stop a workspace's sites** by a
  [data policy](../admin/#data-policies), over its owners' switch. Its
  sites then open nothing and no one publishes, until the policy allows
  them again.

A folder site follows the folder's path: renaming the folder takes its
pages down until it is published again under the new name. A page site
follows its page wherever it moves.

## A custom domain

A site can also open at a domain of your own, such as
`docs.example.org`, at `/` there:

1. In the site's entry under **Publish to the web**, type the domain in
   **Custom domain** and choose **Use this domain**.
2. At the domain's DNS provider, add the **TXT** record the dialog shows:
   its name is `_nether-site.` and the domain, and its value starts with
   `nether-site=`. It proves the domain is yours, so no one else can put
   their site on it.
3. Point the domain at your server, with an `A` or `CNAME` record, as for
   any website.
4. Choose **Check the record**. Once the server finds it, the site is on
   the domain, and its address in the dialog is the domain's.

DNS changes can take a few minutes to show; check again after. The site
stays at its `/p/` address on the server too. **Remove** the domain to take
the site off it; unpublishing the site does as well.

The server's admin sets up the certificates that custom domains need,
once for all of them, as the
[self-hosting guide](../self-hosting/#custom-domains-for-published-sites)
shows. A domain proven again for another site moves to that site: whoever
writes its DNS decides.

## Search engines

Each page tells search engines what it is:

- **Its description**: the note's `description` property, or else its
  first paragraph, up to 160 characters.
- **Its address**, on the site's domain once it has one, so the `/p/`
  address and the domain do not count twice.
- **A card** for links shared on social sites, with the page's title,
  description and an image: the note's `image` property, a web address or
  an image in the vault, or else the first image on the page.

The site lists its pages in a sitemap, at `sitemap.xml` under its address,
and on its domain answers `robots.txt` with the sitemap's address.

- **A note with `noindex: true`** in its properties asks search engines
  to leave it out, and is not in the sitemap.
- **Untick Let search engines index** a site, in its entry in the dialog,
  to ask it of every page. The site still opens for anyone with its
  address.

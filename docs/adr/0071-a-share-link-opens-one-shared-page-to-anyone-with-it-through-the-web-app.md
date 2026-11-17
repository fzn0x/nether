# 0071. A share link opens one shared page to anyone with it, through the web app

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#sharing-and-publishing) ask for
"share links with view, comment or edit access; optional expiry and
password". Sharing so far needs an account: members and guests are
given a page's unit at a level
([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)),
and a guest is invited by a link that makes one. A share link is for
someone with no account at all.

A page shared on its own is already a unit: its vault document lists its
notes and files, and the sync server opens its documents at a level,
read-only below edit. The web app is served by the server
([ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)),
signs in with an HttpOnly cookie, and takes links at its own paths, as
`/invite#…`, with what they carry after the `#`, which no request sends.
Attachments are fetched by their hash, from the workspace, by members.

## Decision

**A share link opens one page shared on its own, with its subpages, at
one level: view, comment or edit.** Making a link for a page that is not
shared on its own shares it on its own first, keeping the people of
where it sits. Those with full access to the page make, list, copy and
revoke its links, at most 20 to a page. An end-to-end encrypted
workspace has no links: its pages share the workspace's key.

**A link is `https://<server>/s#nether_link_<random>`**, opened in the web
app. The token is kept as it is, so whoever manages the page can copy
the link again: the server already holds the page's text, so its
database leaking would show the page either way. A link can expire, and
can have a password, kept as an argon2id hash as an account's is.

**Opening a link starts a visit.** The page posts the token, and the
password when the link has one, to `/api/links/open`. The server answers
with the page it opens and sets a visit's token in an HttpOnly cookie,
`nether_visit`, as signing in does, kept as its hash, until the link
expires or 30 days pass. Guessing is held back by address, as signing in
is. Revoking a link ends its visits.

**A visit opens only its link's unit**: the sync server takes its
cookie, after an account's, for that unit's documents alone, read-only
below edit; and the attachments of that workspace by their hash, as a
member does. A visitor is no member: no presence, no mentions, and none
of the workspace's other pages, not even their names.

**This comes in two parts**, one pull request each:

1. View links, made and revoked in the Share dialog, and the web app's
   page for a visitor: the page and its subpages, each shown read-only,
   with their images.
2. Comment and edit links: a visitor gives a name, which their comments
   and their caret carry.

## Alternatives

- **A link as an invitation**, which makes the visitor an account. The
  requirement is for people without one, and guests already exist.
- **Links to any page, in place.** A page in General or a teamspace is no
  unit; a link to it would open all of where it sits.
- **The token kept as a hash, shown once.** The link could not be copied
  again, which is what people do with a share link; and its page's text
  is on the server anyway.
- **The visit's token in the page, sent as a bearer token.** Images are
  loaded by the browser, which sends a cookie but no header; and the
  page's scripts would hold it.
- **The token in the URL's path.** It would be in the server's logs and
  any proxy's; after the `#` it is in neither.

## Consequences

- The server needs the web app to open links; a server without it says
  so when a link is made.
- A visit lasts as its link does: a link changed to a shorter expiry, or
  revoked, ends what it started.
- Encrypted workspaces wait for keys of their own for each unit before
  they can have links.

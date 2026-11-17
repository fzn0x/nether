# 0076. A published site is a note or a folder, drawn by the server as it is now, linking only to its own pages

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#sharing-and-publishing) ask to
"publish a note or a whole folder as a public site served by the user's
server; custom domain; SEO metadata; respects links between published
pages only". Phase 4's gate asks that "a published site loads on a custom
domain".

What the server has already:

- **Share links** ([ADR 0071](0071-a-share-link-opens-one-shared-page-to-anyone-with-it-through-the-web-app.md))
  open one page shared on its own, a unit
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)),
  in the web app, which syncs it for the visitor. Making a link makes the
  page a unit first.
- **Notes as Markdown** ([ADR 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md)):
  the server reads a note's document with the editor's schema, as a vault
  on disk has it.
- **The HTML export** ([ADR 0012](0012-export-from-the-page.md)) writes a
  page for each note with `blocksToHtml`, its links leading to the pages
  exported with it and to nothing else, math as MathML and code
  highlighted.
- **Files** are kept by their hash, and each unit's vault document lists
  them by path ([ADR 0040](0040-attachments-sync-by-path-and-hash-in-the-vault-document.md)).
- **An end-to-end encrypted workspace** reaches the server as ciphertext
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).

## Decision

### What is published

**A site is a note with its subpages, or a folder with everything in it**,
of a workspace the server can read. A note's subpages are the notes in
the folder beside it ([ADR 0013](0013-pages-in-the-folder-beside-a-note.md)).

- **A note's site follows its note** by ID, when it is moved or renamed.
- **A folder's site is its path.** Renaming the folder leaves the site
  with no pages, until it is published again at the new path.
- **Sites are not units.** A unit is a vault document of its own that
  every device of its people syncs, with notes moved into it. Publishing
  needs none of that: the server alone draws the pages. A folder is no
  unit either, unless it is a teamspace.

**A site is published as the one who published it.** Its pages are the
notes under its root that its publisher has full access to when a page is
asked for, as sync and the API check it.

- A note with `publish: false` in its frontmatter is left out.
- Publishing takes full access to where the root is: the note's unit, or
  the unit a new note in the folder would be in.
- Those with full access there, and the workspace's owners and admins,
  change and unpublish it.
- A publisher who leaves the workspace takes their sites with them.
- **A workspace's owners and admins can turn publishing off.** Its sites
  then answer as not there, until it is on again, and none is made.
- **An encrypted workspace publishes nothing.** The server cannot read it.

### Live, not a snapshot

**A page is drawn from its note as stored**, each time it is asked for, a
few seconds after an edit is stored. There is no "Publish changes" step
to forget. A draft belongs outside the published note or folder, or under
`publish: false`. **Unpublishing deletes the site**, and its addresses
answer as not there at once.

### How a page is drawn

**HTML the server writes, with no script**, so it loads at once and
indexes well:

- The note's document becomes Markdown, as the API gives it, which is
  then parsed as a file is, and written by `blocksToHtml`, the export's.
- Math is MathML and code is highlighted, as the export does them. A
  diagram or a plugin's block shows its code, since only the app draws
  them.
- Properties are not shown, as they are often a team's own fields.
- An embed of a published note shows as a link to it, for now.

**Links lead only between a site's pages.** A link is resolved as the app
resolves it, among the workspace's notes the publisher may open, aliases
too. It then leads to the page only if that note is published in the same
site. Otherwise it is its text, as the note writes it, with no address
and nothing of the other page. Markdown links to notes are treated the
same; web addresses stay as they are.

**Files go by their hash.** An image or another file a page shows is
served at `/p/<site>/.files/<hash>/<name>`, found as the app finds it among
the files of the units the publisher may open.

- Only files a page of the site showed are served: they are recorded in
  `site_files` as pages are drawn, and leave with the site.
- They are served as attachments are, with a policy that runs nothing.

### Addresses

- **The site's own address** is `https://<server>/p/<name>/`. The name is
  chosen when publishing: 3 to 63 lowercase letters, digits and hyphens,
  unique on the server. Changing it moves the site.
- **A page's address** is its path under the root without `.md`, each
  part encoded: `/p/<name>/Guides/Setup`.
- **A note's site** opens at the note. **A folder's site** opens at a list
  of its pages.

**A custom domain** maps to a site, in the second part:

- **The proof.** The site's publisher, or another with full access there,
  claims a domain by adding a TXT record at `_nether-site.<domain>` with a
  value the server gives. The server checks it with its resolver. One
  domain names one site, and no one can claim a domain whose DNS they do
  not control.
- **The routing.** A request whose host is a claimed domain is that
  site's, at `/`. Every other host is the server's own.
- **TLS stays the proxy's.** The self-hosting guide shows Caddy's
  on-demand TLS, which asks the server, at
  `GET /api/sites/domain?domain=`, whether a domain is claimed before it
  asks for a certificate.

### Safety

**Published pages have a policy of their own:** `default-src 'none'`,
images and media from the server, `https:` and `data:`, the server's own
stylesheet, and no scripts, frames, forms or base. They neither read nor
set cookies. On the server's origin, beside the web app, they so run
nothing.

- **Style attributes are let through, style elements are not**
  (`style-src 'self'; style-src-attr 'unsafe-inline'`). `blocksToHtml`
  writes two: a table cell's alignment and a column's width, from values
  it checks. A note's own HTML is written as text, so a note cannot add
  one. A browser without `style-src-attr` blocks them, and only the
  alignment is lost.
- **Files are under `.files/`**, so no note's path takes their address:
  a vault's hidden folders are not synced. The stylesheet is at
  `/p/.nether/site.css`, a name no site can have.

### SEO, in the second part

- **The page's title**, and its site's.
- **A description**: frontmatter `description`, else the first
  paragraph's text, cut at 160 characters.
- **The canonical address**: the domain's when there is one.
- **Open Graph and Twitter cards**, with frontmatter `image`, else the
  first image.
- **Per site**, `sitemap.xml` and `robots.txt`. A site can ask search
  engines not to index it, as can a page with `noindex: true`.

### Parts

1. Sites at the server's paths, published from the Share dialog: a page
   with its subpages, or the folder it is in. With links between
   published pages, files, the pages' policy, and the switch for
   workspaces in the API.
2. Custom domains with Caddy, SEO, and the gate's test: a site loading on
   a custom domain, settled in
   [ADR 0077](0077-a-site-holds-a-custom-domain-its-dns-proves-and-tells-search-engines-what-each-page-is.md).

## Alternatives

- **Units, as share links use.** A published page would become a vault
  document every device syncs, and a folder could not be published
  unless it was a teamspace.
- **A snapshot published on demand, as Obsidian Publish does.** Drafts
  stay private, but every page is kept twice and changes wait for a step
  people forget. Notion's sites are live. A site published as a snapshot
  could come later beside these.
- **The web app drawing the page for visitors**, as share links do. It
  makes the first paint slow, leaves search engines little to read, and
  puts the app's script on a public page.
- **Static files written when publishing**, for the proxy to serve. Every
  edit would write them again; the server already has the notes.
- **Domains mapped by the admin alone.** Simple, but every domain is a
  request to the admin. A DNS proof is what GitHub Pages and Netlify ask
  for.
- **Properties on the page.** They are often a team's own, such as an
  assignee; a site could choose to show them later.

## Consequences

- Each page asked for is read and drawn again, a few milliseconds for a
  note. A cache by the note's store number can come if sites draw much
  traffic.
- Published pages share the server's origin. They run no script, and
  their files run nothing.
- The pages of a site change as its publisher's access does: losing full
  access to a page unpublishes it from their sites.
- Renaming a published folder takes its site's pages down until it is
  published at the new path.

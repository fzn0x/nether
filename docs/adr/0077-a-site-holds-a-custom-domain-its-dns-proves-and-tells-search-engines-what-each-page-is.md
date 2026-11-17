# 0077. A site holds a custom domain its DNS proves, and tells search engines what each page is

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0076](0076-a-published-site-is-a-note-or-a-folder-drawn-by-the-server-as-it-is-now-linking-only-to-its-own-pages.md)
publishes a note or a folder at the server's `/p/<name>/` and left two
parts of the [requirement](../requirements.md#sharing-and-publishing) to
this record: a "custom domain" and "SEO metadata". Phase 4's gate asks
that "a published site loads on a custom domain".

It sketched how: a TXT record proves a claim, a request's host picks the
site, Caddy's on-demand TLS asks the server before it gets a certificate,
and pages carry what search engines read. This record settles the details.

## Decision

### Claiming a domain

**A site claims a domain, and holds it once its DNS proves the claim.**

- **Claiming.** Those who may change a site
  (`PUT /api/workspaces/:id/sites/:site/domain`) name a domain. The server
  gives a TXT record to add: `_nether-site.<domain>`, with the value
  `nether-site=<token>`, 144 random bits made for that claim. Naming the
  same domain again keeps the token; another domain gets a new one.
- **Proving.** `POST .../domain/check` looks the record up with the
  server's resolver. A record whose strings, joined, are the value proves
  the claim. No record yet is a 409, a lookup that fails is a 502, and the
  check is limited to 30 tries in 5 minutes per address.
- **Holding.** A domain names one site at a time, by a unique index on the
  domains held. A claim waits beside the site that holds the domain, and
  **whoever proves it last holds it**: the site that held it gives it up.
  The DNS's owner decides which site is theirs, and a domain bought from
  someone else can be claimed again.
- **What a site cannot hold:** an IP address, a single name such as
  `localhost`, a `.localhost` name, a name with a port or a path, and the
  host of the server's own `NETHER_PUBLIC_URL`, whose requests stay the
  web app's and the API's. Names are kept lowercase, in ASCII, without
  their final dot.
- **Giving it up**, `DELETE .../domain`, unpublishing, and turning
  publishing off take the domain from the site at once.
- **No later checks.** The server does not look the record up again once
  a domain is held. A record taken away leaves it held, until someone
  else proves a claim, or the site gives it up.

### Requests to a domain

**A request whose host is a domain a site holds is that site's, on any
path.** A hook before every route reads the request's host, as Fastify
gives it with the proxy trusted, without its port:

- `/` is the site's root, `/Setup` a page, `/.files/<hash>/<name>` a file,
  `/.nether/site.css` the stylesheet, and `/sitemap.xml` and
  `/robots.txt` what search engines read.
- **Nothing else answers there.** `/api/...`, the web app and `/p/...`
  answer with the site's 404 page. The domain's pages never reach the
  session cookies, which are the server's own host's.
- **Every other host is the server's own**, as before. A host found to be
  no site's is kept so for 5 seconds, so the server's own requests do not
  look it up each time; a site's change forgets them.
- The site still answers at `/p/<name>/` on the server.

### TLS stays the proxy's

**`GET /api/sites/domain?domain=<name>`** answers 200 for a domain a
published site holds, and 404 otherwise. Caddy's on-demand TLS asks it
before it gets a certificate for a name it has none for, so the proxy
gets certificates only for domains the server serves. The self-hosting
guide shows the `Caddyfile`. The server itself never handles TLS.

### What pages tell search engines

- **The title**, the page's and its site's, as part 1 has it.
- **A description**: the note's `description` property, or its first
  paragraph's text, cut at a word to 160 characters.
- **The canonical address**: on the site's domain once it holds one, and
  on `NETHER_PUBLIC_URL`, or the address asked, otherwise. A page at
  `/p/<name>/` names its domain's address as canonical, so the two do not
  compete.
- **Open Graph and a Twitter card**: type, site name, title, address,
  description, and an image: the `image` property's, a web address or a
  file of the vault, else the first image the page shows. A vault's image
  is given at its canonical address, and counts as shown by the site.
- **Not indexing.** A note with `noindex: true` asks not to be indexed,
  with `<meta name="robots" content="noindex">` and `X-Robots-Tag:
  noindex`, and is left out of the sitemap. A site whose publisher turns
  indexing off (`indexed: false`) asks it of every page and file.

**A sitemap per site**, at `sitemap.xml` under its base: the canonical
address of each page that may be indexed, with when its note was stored.
It is empty while the site is not indexed.

**`robots.txt` on a domain alone**, since search engines read it only at
a host's root: everything allowed, with the sitemap's address, or nothing
while the site is not indexed. On the server, a site's pages ask through
their tags and headers, and the server's own `/robots.txt` is left to the
admin's proxy.

## Alternatives

- **Domains set by the admin alone.** Every domain would be a request to
  the admin. A DNS proof is what GitHub Pages and Netlify ask for, and
  works for any member who controls a domain.
- **The first proof keeps the domain.** It would let a domain's former
  owner keep it on a site after selling it, against its new owner.
- **Checking records again on a schedule.** It adds a job and lookups for
  every site to catch a case the takeover already settles.
- **A CNAME or an A record as the proof.** Either shows where the domain
  points, not who asked: anyone could claim a domain pointed at a shared
  server. The TXT value is the claim's own.
- **The server getting certificates itself**, through ACME. Self-hosters
  already run a proxy for the server's own HTTPS; Caddy's on-demand TLS
  does it with one `ask`.
- **Redirecting `/p/<name>/` to the domain.** A domain whose DNS does not
  point at the server yet would leave the site unreachable; the
  canonical tag tells search engines which address to keep.

## Consequences

- Self-hosters who want custom domains add an on-demand block to their
  proxy; without one, a held domain is served only by whatever reaches
  the server with that host.
- Every request reads its host before its route. For the server's own
  hosts it costs a parse and, at most every 5 seconds, a lookup.
- A held domain whose record is later removed stays held: giving it up is
  the site's to do, or a new claim's.
- A site's description and card come from its notes: a `description` or
  `image` property changes them without a step of their own.

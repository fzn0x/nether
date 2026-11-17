// Published sites' pages for anyone (ADR 0076): /p/<name>/ and the pages
// under it, drawn as their notes are now; the files they show, by hash;
// the stylesheet they share; and each site's sitemap. A request whose host
// is a custom domain a site holds is that site's, at `/`, with its
// robots.txt (ADR 0077), and never the web app's or the API's. Every answer
// has a policy that runs nothing and loads only images, media and that
// stylesheet. What a site has is kept a few seconds, and forgotten at once
// when the site changes or goes, so a page follows its note's edits and
// unpublishing is at once.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BlobStore } from "./blobs.ts";
import { type Database, readText } from "./db.ts";
import { domainName, ownHost } from "./domains.ts";
import { limitByAddress } from "./http.ts";
import type { Drawn, SiteIndex, Where } from "./pages.ts";
import { siteStyle } from "./siteStyle.ts";
import { type Site, siteAtDomain, siteName, siteNamed } from "./sites.ts";

/**
 * A published page's policy: nothing runs, nothing is framed or sent, and
 * it loads only images and media, from the server or the web, and the
 * sites' stylesheet. The style attributes `blocksToHtml` writes, for a
 * table cell's alignment and a column's width, are let through; no style
 * element is.
 */
export const pagePolicy = [
  "default-src 'none'",
  "img-src 'self' https: data:",
  "media-src 'self' https: data:",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** A file's policy, as attachments have: it runs nothing and loads nothing. */
const filePolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Where the sites' stylesheet is: under /p/, at a name no site can have. */
export const stylesheetPath = "/p/.nether/site.css";

/** Where it is on a site's domain: in a hidden folder, as no note's page is. */
export const domainStylesheetPath = "/.nether/site.css";

const stylesheetTag = `"${createHash("sha256").update(siteStyle).digest("base64url").slice(0, 27)}"`;

/** How long what a site has is kept before it is read again, and a host found to be no site's. */
const keptFor = 5_000;
/** The most sites whose pages are kept at once. */
const keptSites = 32;
/** The most hosts kept as no site's, forgotten all at once past it. */
const keptHosts = 1_000;

type Pages = typeof import("./pages.ts");
let loading: Promise<Pages> | undefined;
/** The drawing, with the editor's schema, loaded when a page is first asked for. */
function pages(): Promise<Pages> {
  loading ??= import("./pages.ts");
  return loading;
}

/** The headers every answer of a site has. */
function guard(reply: FastifyReply, policy = pagePolicy): FastifyReply {
  return reply
    .header("content-security-policy", policy)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("x-frame-options", "DENY");
}

/** Whether the request already has what its entity tag names. */
function fresh(request: FastifyRequest, tag: string): boolean {
  const asked = request.headers["if-none-match"];
  return typeof asked === "string" && asked.split(",").some((part) => part.trim() === tag);
}

function tagOf(text: string): string {
  return `"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"`;
}

/** A page's parts, decoded; undefined for one that does not decode. */
function addressOf(rest: string): string | undefined {
  try {
    return rest
      .split("/")
      .filter((part) => part !== "")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return undefined;
  }
}

export interface PublishedOptions {
  /** Where files are kept; without a store, a site shows no files. */
  readonly blobs?: BlobStore | undefined;
  /** The server's own address, for sites' canonical addresses without a domain. */
  readonly publicUrl?: string | null;
}

/**
 * The public routes of published sites, and their domains' requests.
 * Returns `changed`, for the routes that change sites to say which one
 * changed or went.
 */
export function registerPublished(
  app: FastifyInstance,
  db: Database,
  options: PublishedOptions = {},
): { readonly changed: (site: string) => void } {
  const publicUrl = options.publicUrl ?? null;
  const own = ownHost(publicUrl);
  const kept = new Map<string, { readonly at: number; readonly index: Promise<SiteIndex> }>();
  /** Hosts found to be no site's, and when. */
  const unclaimed = new Map<string, number>();

  /** What a site has, as kept for a few seconds, read again after. */
  function indexOf(site: Site): Promise<SiteIndex> {
    const now = Date.now();
    const found = kept.get(site.id);
    // The site as found now, its name and title, with what was kept for it.
    if (found !== undefined && now - found.at < keptFor) {
      return found.index.then((index) => ({ ...index, site }));
    }
    const index = pages().then(({ siteIndex }) => siteIndex(db, site));
    kept.delete(site.id);
    kept.set(site.id, { at: now, index });
    // The oldest first: a map keeps its keys in the order they were set.
    for (const id of kept.keys()) {
      if (kept.size <= keptSites) break;
      kept.delete(id);
    }
    index.catch(() => {
      if (kept.get(site.id)?.index === index) kept.delete(site.id);
    });
    return index;
  }

  /** Where a site is for this request, on its domain or under /p/, and its canonical address. */
  function whereOf(request: FastifyRequest, site: Site | undefined, onDomain: boolean): Where {
    const server = (publicUrl ?? `${request.protocol}://${request.host}`).replace(/\/+$/, "");
    const base = onDomain ? "/" : site === undefined ? "/p/" : `/p/${site.name}/`;
    const canonical =
      site?.domain !== null && site?.domain !== undefined
        ? `https://${site.domain}/`
        : `${server}${base}`;
    return {
      base,
      stylesheet: onDomain ? domainStylesheetPath : stylesheetPath,
      canonical,
    };
  }

  const limit = limitByAddress(app, "published", 600, "1 minute");

  async function send(request: FastifyRequest, reply: FastifyReply, drawn: Drawn) {
    const tag = tagOf(drawn.html);
    guard(reply).header("cache-control", "no-cache").header("etag", tag);
    if (drawn.noindex) reply.header("x-robots-tag", "noindex");
    if (drawn.status === 200 && fresh(request, tag)) return reply.code(304).send();
    return reply.code(drawn.status).type("text/html; charset=utf-8").send(drawn.html);
  }

  async function notThere(
    request: FastifyRequest,
    reply: FastifyReply,
    site: Site | undefined,
    onDomain = false,
  ) {
    const { notPublished } = await pages();
    return send(request, reply, notPublished(whereOf(request, site, onDomain), site));
  }

  /** A text a site serves beside its pages, as its sitemap. */
  function text(
    request: FastifyRequest,
    reply: FastifyReply,
    type: string,
    body: string,
    noindex: boolean,
  ) {
    const tag = tagOf(body);
    guard(reply).header("cache-control", "no-cache").header("etag", tag);
    if (noindex) reply.header("x-robots-tag", "noindex");
    if (fresh(request, tag)) return reply.code(304).send();
    return reply.type(type).send(body);
  }

  function stylesheet(request: FastifyRequest, reply: FastifyReply) {
    guard(reply).header("cache-control", "no-cache").header("etag", stylesheetTag);
    if (fresh(request, stylesheetTag)) return reply.code(304).send();
    return reply.type("text/css; charset=utf-8").send(siteStyle);
  }

  /** Answers for the address `rest`, past the site's base, of a site on its domain or under /p/. */
  async function serve(
    request: FastifyRequest,
    reply: FastifyReply,
    site: Site,
    rest: string,
    onDomain: boolean,
  ) {
    if (onDomain && `/${rest}` === domainStylesheetPath) return stylesheet(request, reply);
    const where = whereOf(request, site, onDomain);
    const index = await indexOf(site);
    const { drawPage, filesFolder, robots, sitemap } = await pages();
    if (rest.startsWith(`${filesFolder}/`)) {
      const [hash = ""] = rest.slice(filesFolder.length + 1).split("/");
      return file(request, reply, index, hash, onDomain);
    }
    if (rest === "sitemap.xml") {
      const body = sitemap(index, where);
      return text(request, reply, "application/xml; charset=utf-8", body, !site.indexed);
    }
    // Search engines read robots.txt at a host's root alone: a domain's.
    if (onDomain && rest === "robots.txt") {
      return text(request, reply, "text/plain; charset=utf-8", robots(index, where), false);
    }
    const address = addressOf(rest);
    if (address === undefined) return notThere(request, reply, site, onDomain);
    const drawn = await drawPage(db, index, where, address);
    if (drawn.files.length > 0) {
      await db.query(
        `INSERT INTO site_files (site_id, hash)
         SELECT $1, hash FROM unnest($2::text[]) AS f(hash)
             ON CONFLICT DO NOTHING`,
        [site.id, drawn.files],
      );
    }
    return send(request, reply, drawn);
  }

  // A request to a domain a site holds is the site's, whatever its path:
  // nothing of the web app or the API answers there.
  app.addHook("onRequest", async (request, reply) => {
    const domain = domainName(request.hostname, own);
    if (domain === undefined) return;
    const seen = unclaimed.get(domain);
    if (seen !== undefined && Date.now() - seen < keptFor) return;
    const site = await siteAtDomain(db, domain);
    if (site === undefined) {
      if (unclaimed.size >= keptHosts) unclaimed.clear();
      unclaimed.set(domain, Date.now());
      return;
    }
    await limit(request, reply);
    if (reply.sent) return reply;
    if (request.method !== "GET" && request.method !== "HEAD") {
      await notThere(request, reply, site, true);
      return reply;
    }
    const pathname = request.url.split("?")[0] ?? "/";
    await serve(request, reply, site, pathname.slice(1), true);
    return reply;
  });

  app.get(stylesheetPath, { onRequest: limit }, (request, reply) => stylesheet(request, reply));

  // Under /p/ are only sites, not the web app.
  app.get("/p", { onRequest: limit }, (request, reply) => notThere(request, reply, undefined));
  app.get("/p/", { onRequest: limit }, (request, reply) => notThere(request, reply, undefined));

  // A site's address ends with a slash, so its own address is one.
  app.get<{ Params: { site: string } }>(
    "/p/:site",
    { onRequest: limit },
    async (request, reply) => {
      const name = request.params.site;
      if (!siteName.test(name)) return notThere(request, reply, undefined);
      return guard(reply).redirect(`/p/${name}/`, 308);
    },
  );

  app.get<{ Params: { site: string; "*": string } }>(
    "/p/:site/*",
    { onRequest: limit },
    async (request, reply) => {
      const name = request.params.site;
      const site = siteName.test(name) ? await siteNamed(db, name) : undefined;
      if (site === undefined) return notThere(request, reply, undefined);
      // The raw path, as the request names it, past `/p/<name>/`.
      const pathname = request.url.split("?")[0] ?? "";
      return serve(request, reply, site, pathname.slice(`/p/${name}/`.length), false);
    },
  );

  /**
   * A file a page of the site showed, while the publisher may still open
   * it, served as an attachment is: as its type, running nothing.
   */
  async function file(
    request: FastifyRequest,
    reply: FastifyReply,
    index: SiteIndex,
    hash: string,
    onDomain: boolean,
  ) {
    const { blobs } = options;
    const { site } = index;
    if (blobs === undefined) return notThere(request, reply, site, onDomain);
    const shown =
      /^[0-9a-f]{64}$/.test(hash) &&
      [...index.hashOf.values()].includes(hash) &&
      (await db.query("SELECT 1 FROM site_files WHERE site_id = $1 AND hash = $2", [site.id, hash]))
        .rows.length > 0;
    if (!shown) return notThere(request, reply, site, onDomain);
    const tag = `"${hash}"`;
    guard(reply, filePolicy).header("cache-control", "no-cache").header("etag", tag);
    if (!site.indexed) reply.header("x-robots-tag", "noindex");
    if (fresh(request, tag)) return reply.code(304).send();
    const { rows } = await db.query(
      "SELECT content_type FROM attachments WHERE workspace_id = $1 AND hash = $2",
      [site.workspace, hash],
    );
    const data = rows.length === 0 ? undefined : await blobs.get(`${site.workspace}/${hash}`);
    if (data === undefined) return notThere(request, reply, site, onDomain);
    const type =
      rows[0]?.content_type === null
        ? "application/octet-stream"
        : readText(rows[0], "content_type");
    return reply.header("content-type", type).send(Buffer.from(data));
  }

  return {
    changed(site) {
      kept.delete(site);
      unclaimed.clear();
    },
  };
}

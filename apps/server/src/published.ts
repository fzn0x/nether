// Published sites' pages for anyone (ADR 0076): /p/<name>/ and the pages
// under it, drawn as their notes are now; the files they show, by hash;
// and the stylesheet they share. Every answer has a policy that runs
// nothing and loads only images, media and that stylesheet. What a site
// has is kept a few seconds, and forgotten at once when the site changes
// or goes, so a page follows its note's edits and unpublishing is at once.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BlobStore } from "./blobs.ts";
import { type Database, readText } from "./db.ts";
import { limitByAddress } from "./http.ts";
import type { Drawn, SiteIndex, Where } from "./pages.ts";
import { siteStyle } from "./siteStyle.ts";
import { type Site, siteName, siteNamed } from "./sites.ts";

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

const stylesheetTag = `"${createHash("sha256").update(siteStyle).digest("base64url").slice(0, 27)}"`;

/** How long what a site has is kept before it is read again. */
const keptFor = 5_000;
/** The most sites whose pages are kept at once. */
const keptSites = 32;

type Pages = typeof import("./pages.ts");
let loading: Promise<Pages> | undefined;
/** The drawing, with the editor's schema, loaded when a page is first asked for. */
function pages(): Promise<Pages> {
  loading ??= import("./pages.ts");
  return loading;
}

/** The headers every answer under /p/ has. */
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
}

/**
 * The public routes of published sites. Returns `changed`, for the routes
 * that change sites to say which one changed or went.
 */
export function registerPublished(
  app: FastifyInstance,
  db: Database,
  options: PublishedOptions = {},
): { readonly changed: (site: string) => void } {
  const kept = new Map<string, { readonly at: number; readonly index: Promise<SiteIndex> }>();

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

  const limit = limitByAddress(app, "published", 600, "1 minute");

  async function send(request: FastifyRequest, reply: FastifyReply, drawn: Drawn) {
    const tag = `"${createHash("sha256").update(drawn.html).digest("base64url").slice(0, 27)}"`;
    guard(reply).header("cache-control", "no-cache").header("etag", tag);
    if (drawn.status === 200 && fresh(request, tag)) return reply.code(304).send();
    return reply.code(drawn.status).type("text/html; charset=utf-8").send(drawn.html);
  }

  async function notThere(request: FastifyRequest, reply: FastifyReply, site?: Site) {
    const { notPublished } = await pages();
    const base = site === undefined ? "/p/" : `/p/${site.name}/`;
    return send(request, reply, notPublished({ base, stylesheet: stylesheetPath }, site));
  }

  app.get(stylesheetPath, { onRequest: limit }, (request, reply) => {
    guard(reply).header("cache-control", "no-cache").header("etag", stylesheetTag);
    if (fresh(request, stylesheetTag)) return reply.code(304).send();
    return reply.type("text/css; charset=utf-8").send(siteStyle);
  });

  // A site's address ends with a slash, so its own address is one.
  app.get<{ Params: { site: string } }>(
    "/p/:site",
    { onRequest: limit },
    async (request, reply) => {
      const name = request.params.site;
      if (!siteName.test(name)) return notThere(request, reply);
      return guard(reply).redirect(`/p/${name}/`, 308);
    },
  );

  app.get<{ Params: { site: string; "*": string } }>(
    "/p/:site/*",
    { onRequest: limit },
    async (request, reply) => {
      const name = request.params.site;
      const site = siteName.test(name) ? await siteNamed(db, name) : undefined;
      if (site === undefined) return notThere(request, reply);
      // The raw path, as the request names it, past `/p/<name>/`.
      const pathname = request.url.split("?")[0] ?? "";
      const rest = pathname.slice(`/p/${name}/`.length);
      const index = await indexOf(site);
      const { drawPage, filesFolder } = await pages();

      if (rest.startsWith(`${filesFolder}/`)) {
        const [hash = ""] = rest.slice(filesFolder.length + 1).split("/");
        return file(request, reply, index, hash);
      }
      const address = addressOf(rest);
      if (address === undefined) return notThere(request, reply, site);
      const where: Where = { base: `/p/${site.name}/`, stylesheet: stylesheetPath };
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
  ) {
    const { blobs } = options;
    const workspace = index.site.workspace;
    if (blobs === undefined) return notThere(request, reply, index.site);
    const shown =
      /^[0-9a-f]{64}$/.test(hash) &&
      [...index.hashOf.values()].includes(hash) &&
      (
        await db.query("SELECT 1 FROM site_files WHERE site_id = $1 AND hash = $2", [
          index.site.id,
          hash,
        ])
      ).rows.length > 0;
    if (!shown) return notThere(request, reply, index.site);
    const tag = `"${hash}"`;
    guard(reply, filePolicy).header("cache-control", "no-cache").header("etag", tag);
    if (fresh(request, tag)) return reply.code(304).send();
    const { rows } = await db.query(
      "SELECT content_type FROM attachments WHERE workspace_id = $1 AND hash = $2",
      [workspace, hash],
    );
    const data = rows.length === 0 ? undefined : await blobs.get(`${workspace}/${hash}`);
    if (data === undefined) return notThere(request, reply, index.site);
    const type =
      rows[0]?.content_type === null
        ? "application/octet-stream"
        : readText(rows[0], "content_type");
    return reply.header("content-type", type).send(Buffer.from(data));
  }

  return {
    changed(site) {
      kept.delete(site);
    },
  };
}

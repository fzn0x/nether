// Published sites, as the Share dialog asks the server for them (ADR 0076):
// a page with its subpages, or a folder, drawn by the server for anyone at
// /p/<name>/. Loaded with the dialog.
import { request } from "./server.ts";

type Fetch = typeof fetch;

/** A site, as those who may change it see it. */
export interface PublishedSite {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** The note it publishes with its subpages, or null for a folder's site. */
  readonly note: string | null;
  /** The folder it publishes, or null for a note's site. */
  readonly folder: string | null;
  readonly url: string;
  readonly publishedBy: string;
}

/** A workspace's sites the account may change, and its switch. */
export interface Sites {
  readonly publishing: boolean;
  /** Whether the account turns publishing on and off: an owner or an admin. */
  readonly manages: boolean;
  readonly sites: readonly PublishedSite[];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function siteOf(value: unknown): PublishedSite {
  const site = record(value);
  return {
    id: text(site.id),
    name: text(site.name),
    title: text(site.title),
    note: typeof site.note === "string" ? site.note : null,
    folder: typeof site.folder === "string" ? site.folder : null,
    url: text(site.url),
    publishedBy: text(record(site.publishedBy).name),
  };
}

/** The sites of a workspace the account may change. */
export async function listSites(
  fetcher: Fetch,
  base: string,
  token: string,
  workspaceId: string,
): Promise<Sites> {
  const answer = record(
    await request(fetcher, base, `/api/workspaces/${workspaceId}/sites`, { token }),
  );
  return {
    publishing: answer.publishing === true,
    manages: answer.manages === true,
    sites: (Array.isArray(answer.sites) ? answer.sites : []).map(siteOf),
  };
}

/** Publishes a note with its subpages, or a folder, under a name. */
export async function publishSite(
  fetcher: Fetch,
  base: string,
  token: string,
  workspaceId: string,
  site: { readonly name: string } & ({ readonly note: string } | { readonly folder: string }),
): Promise<PublishedSite> {
  return siteOf(
    await request(fetcher, base, `/api/workspaces/${workspaceId}/sites`, { token, body: site }),
  );
}

/** Unpublishes a site: its addresses answer as not there at once. */
export async function unpublishSite(
  fetcher: Fetch,
  base: string,
  token: string,
  workspaceId: string,
  site: string,
): Promise<void> {
  await request(fetcher, base, `/api/workspaces/${workspaceId}/sites/${site}`, {
    token,
    method: "DELETE",
  });
}

/** Turns publishing on or off for a workspace, as its owners and admins do. */
export async function switchPublishing(
  fetcher: Fetch,
  base: string,
  token: string,
  workspaceId: string,
  enabled: boolean,
): Promise<void> {
  await request(fetcher, base, `/api/workspaces/${workspaceId}/publishing`, {
    token,
    method: "PUT",
    body: { enabled },
  });
}

/** The folder a note is in, "" at the vault's top. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Whether a site shows a note: it is the site's root, or in the folder it publishes. */
export function showsNote(
  site: PublishedSite,
  note: { readonly id: string; readonly path: string },
) {
  if (site.note !== null) return site.note === note.id;
  return site.folder !== null && note.path.startsWith(`${site.folder}/`);
}

/**
 * A site's name made from a title: lowercase letters, digits and hyphens,
 * 3 to 63 of them, as the server takes; "site" when the title has none.
 */
export function siteNameFor(title: string): string {
  const name = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
  return name.length >= 3 ? name : name === "" ? "site" : `${name}-site`;
}

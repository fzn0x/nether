// Publishing from the Share dialog (ADR 0076): this page with its
// subpages, or the folder it is in, as a site anyone opens at its address
// on the server, drawn from the notes as they are now. Those with full
// access publish under a name and unpublish, give a site a custom domain
// and let search engines index it or not (ADR 0077); a workspace's owners
// and admins turn publishing on and off for it.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import type { NoteEntry } from "@nether/storage";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import {
  type PublishedSite,
  type Sites,
  folderOf,
  listSites,
  publishSite,
  showsNote,
  siteNameFor,
  switchPublishing,
  unpublishSite,
} from "./sites.ts";
import { SiteDomain } from "./SiteDomain.tsx";
import type { VaultLink } from "./sync.ts";

type Scope = "page" | "folder";

export function SharePublish(props: {
  readonly link: VaultLink;
  readonly note: NoteEntry;
  readonly onStatus: (status: string) => void;
  readonly onError: (error: string) => void;
}) {
  const { link, note, onStatus, onError } = props;
  const { server, workspaceId } = link;
  const folder = folderOf(note.path);
  const [sites, setSites] = useState<Sites | undefined>();
  const [scope, setScope] = useState<Scope>("page");
  const [name, setName] = useState(() => siteNameFor(note.title));
  const [busy, setBusy] = useState(false);

  const session = useCallback(async () => {
    const found = await backend.serverToken(server);
    if (found === undefined) throw new Error(t("syncSignedOut", { server }));
    return found;
  }, [server]);

  const report = useCallback(
    (reason: unknown) => {
      onError(reason instanceof Error ? reason.message : String(reason));
    },
    [onError],
  );

  const load = useCallback(async () => {
    setSites(await listSites(backend.serverFetch, server, await session(), workspaceId));
  }, [server, session, workspaceId]);

  useEffect(() => {
    if (link.encrypted === true) return;
    load().catch(report);
  }, [link.encrypted, load, report]);

  const act = (work: (token: string) => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    session()
      .then(async (token) => {
        const said = await work(token);
        await load();
        onStatus(said);
      })
      .catch(report)
      .finally(() => {
        setBusy(false);
      });
  };

  const shown = sites?.sites.filter((site) => showsNote(site, note)) ?? [];
  const pagePublished = shown.some((site) => site.note === note.id);
  const folderPublished = folder === "" || shown.some((site) => site.folder === folder);
  const scopes: readonly Scope[] = [
    ...(pagePublished ? [] : (["page"] as const)),
    ...(folderPublished ? [] : (["folder"] as const)),
  ];
  const chosen = scopes.includes(scope) ? scope : scopes[0];

  const publish = (event: SyntheticEvent) => {
    event.preventDefault();
    if (chosen === undefined) return;
    act(async (token) => {
      const made = await publishSite(backend.serverFetch, server, token, workspaceId, {
        name: name.trim(),
        ...(chosen === "page" ? { note: note.id } : { folder }),
      });
      await navigator.clipboard.writeText(made.url).catch(() => undefined);
      return t("publishDone", { title: made.title });
    });
  };

  const unpublish = (site: PublishedSite) => {
    act(async (token) => {
      await unpublishSite(backend.serverFetch, server, token, workspaceId, site.id);
      return t("publishUnpublished", { title: site.title });
    });
  };

  return (
    <section className="share-links share-publish" aria-labelledby="share-publish-title">
      <h3 id="share-publish-title">{t("publishTitle")}</h3>
      {link.encrypted === true ? (
        <p className="hint">{t("publishEncrypted")}</p>
      ) : sites === undefined ? null : (
        <>
          <p className="hint">{t("publishIntro")}</p>
          {sites.manages ? (
            <label className="field-check">
              <input
                type="checkbox"
                checked={sites.publishing}
                disabled={busy}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  act(async (token) => {
                    await switchPublishing(
                      backend.serverFetch,
                      server,
                      token,
                      workspaceId,
                      enabled,
                    );
                    return enabled ? t("publishNowOn") : t("publishNowOff");
                  });
                }}
              />
              {t("publishAllow", { workspace: link.workspaceName })}
            </label>
          ) : sites.publishing ? null : (
            <p role="status">{t("publishOff")}</p>
          )}
          {shown.length === 0 ? null : (
            <ul className="plugin-list">
              {shown.map((site) => (
                <li key={site.id} className="share-link">
                  <p>
                    {site.note !== null
                      ? t("publishSiteOfPage", { title: site.title })
                      : t("publishSiteOfFolder", {
                          title: site.title,
                          folder: site.folder ?? "",
                        })}{" "}
                    {t("publishSiteBy", { name: site.publishedBy })}
                  </p>
                  <input
                    type="text"
                    readOnly
                    value={site.url}
                    aria-label={t("publishAddress", { title: site.title })}
                    onFocus={(event) => {
                      event.target.select();
                    }}
                  />
                  <div className="share-link-actions">
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      onClick={() => {
                        navigator.clipboard.writeText(site.url).then(() => {
                          onStatus(t("publishCopied"));
                        }, report);
                      }}
                    >
                      {t("publishCopy")}
                    </button>
                    <button
                      type="button"
                      className="quiet danger"
                      disabled={busy}
                      onClick={() => {
                        unpublish(site);
                      }}
                    >
                      {t("publishUnpublish", { title: site.title })}
                    </button>
                  </div>
                  <SiteDomain
                    link={link}
                    site={site}
                    busy={busy}
                    act={act}
                    onStatus={onStatus}
                    onError={onError}
                  />
                </li>
              ))}
            </ul>
          )}
          {chosen === undefined || !sites.publishing ? null : (
            <form className="share-link-new" onSubmit={publish}>
              {scopes.length < 2 ? null : (
                <fieldset disabled={busy}>
                  <legend>{t("publishWhat")}</legend>
                  <label className="field-check">
                    <input
                      type="radio"
                      name="publish-scope"
                      checked={chosen === "page"}
                      onChange={() => {
                        setScope("page");
                      }}
                    />
                    {t("publishPage")}
                  </label>
                  <label className="field-check">
                    <input
                      type="radio"
                      name="publish-scope"
                      checked={chosen === "folder"}
                      onChange={() => {
                        setScope("folder");
                      }}
                    />
                    {t("publishFolder", { folder })}
                  </label>
                </fieldset>
              )}
              <label className="field">
                {t("publishName")}
                <input
                  type="text"
                  value={name}
                  required
                  minLength={3}
                  maxLength={63}
                  pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
                  spellCheck={false}
                  aria-describedby="publish-name-hint"
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </label>
              <p className="hint" id="publish-name-hint">
                {t("publishNameHint")}
              </p>
              <button type="submit" disabled={busy}>
                {chosen === "page" ? t("publishPageAction") : t("publishFolderAction")}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

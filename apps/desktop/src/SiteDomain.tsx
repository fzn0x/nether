// A published site's custom domain and its indexing, in the Share dialog
// (ADR 0077). Those who may change the site name a domain, add the TXT
// record the server gives at its DNS provider, and check it, when the site
// holds the domain; they give it up, and let search engines index the site
// or ask them not to.
import { type SyntheticEvent, useState } from "react";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import {
  type PublishedSite,
  checkDomain,
  claimDomain,
  giveUpDomain,
  setSiteIndexed,
} from "./sites.ts";
import type { VaultLink } from "./sync.ts";

export function SiteDomain(props: {
  readonly link: VaultLink;
  readonly site: PublishedSite;
  readonly busy: boolean;
  readonly act: (work: (token: string) => Promise<string>) => void;
  readonly onStatus: (status: string) => void;
  readonly onError: (error: string) => void;
}) {
  const { link, site, busy, act, onStatus, onError } = props;
  const { server, workspaceId } = link;
  const [domain, setDomain] = useState("");
  const { domain: held } = site;
  const field = `site-domain-${site.id}`;

  const claim = (event: SyntheticEvent) => {
    event.preventDefault();
    act(async (token) => {
      const claimed = await claimDomain(
        backend.serverFetch,
        server,
        token,
        workspaceId,
        site.id,
        domain.trim(),
      );
      setDomain("");
      return t("domainClaimed", { domain: claimed.domain?.name ?? domain.trim() });
    });
  };

  return (
    <div className="site-domain">
      <label className="field-check">
        <input
          type="checkbox"
          checked={site.indexed}
          disabled={busy}
          onChange={(event) => {
            const indexed = event.target.checked;
            act(async (token) => {
              await setSiteIndexed(
                backend.serverFetch,
                server,
                token,
                workspaceId,
                site.id,
                indexed,
              );
              return indexed
                ? t("publishIndexedOn", { title: site.title })
                : t("publishIndexedOff", { title: site.title });
            });
          }}
        />
        {t("publishIndexed", { title: site.title })}
      </label>
      {held === null ? (
        <form className="share-link-new" onSubmit={claim}>
          <label className="field" htmlFor={field}>
            {t("domainLabel", { title: site.title })}
          </label>
          <input
            id={field}
            type="text"
            value={domain}
            required
            maxLength={253}
            spellCheck={false}
            autoComplete="off"
            placeholder="docs.example.org"
            aria-describedby={`${field}-hint`}
            onChange={(event) => {
              setDomain(event.target.value);
            }}
          />
          <p className="hint" id={`${field}-hint`}>
            {t("domainHint")}
          </p>
          <button type="submit" disabled={busy}>
            {t("domainUse")}
          </button>
        </form>
      ) : (
        <>
          {held.verified ? (
            <p>{t("domainOn", { domain: held.name })}</p>
          ) : (
            <>
              <p>{t("domainRecordIntro", { domain: held.name })}</p>
              <dl className="site-domain-record">
                <dt>{t("domainRecordType")}</dt>
                <dd>
                  <code>{held.record.type}</code>
                </dd>
                <dt>{t("domainRecordName")}</dt>
                <dd>
                  <code>{held.record.name}</code>
                </dd>
                <dt>{t("domainRecordValue")}</dt>
                <dd>
                  <code>{held.record.value}</code>
                </dd>
              </dl>
            </>
          )}
          <div className="share-link-actions">
            {held.verified ? null : (
              <>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    navigator.clipboard.writeText(held.record.value).then(
                      () => {
                        onStatus(t("domainValueCopied"));
                      },
                      (reason: unknown) => {
                        onError(reason instanceof Error ? reason.message : String(reason));
                      },
                    );
                  }}
                >
                  {t("domainCopyValue")}
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    act(async (token) => {
                      await checkDomain(backend.serverFetch, server, token, workspaceId, site.id);
                      return t("domainHeld", { domain: held.name });
                    });
                  }}
                >
                  {t("domainCheck", { domain: held.name })}
                </button>
              </>
            )}
            <button
              type="button"
              className="quiet danger"
              disabled={busy}
              onClick={() => {
                act(async (token) => {
                  await giveUpDomain(backend.serverFetch, server, token, workspaceId, site.id);
                  return t("domainRemoved", { domain: held.name });
                });
              }}
            >
              {t("domainRemove", { domain: held.name })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

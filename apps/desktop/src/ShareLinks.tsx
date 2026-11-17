// A shared page's links, in its Share dialog (ADR 0071): each opens the
// page and its subpages to anyone with it, in the web app, to read, to
// comment on or to edit. Those with full access make one, with an expiry
// and a password if they want, copy it again, and revoke it, which ends
// the visits it started.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { backend } from "./backend.ts";
import { language, t } from "./messages.ts";
import { type ShareLink, levelName, makeShareLink, revokeShareLink, shareLinks } from "./server.ts";
import type { VaultLink } from "./sync.ts";

/** The levels a link can open its page at. */
const linkLevels = ["view", "comment", "edit"] as const;

/** What a link lets anyone with it do, said in its list. */
function letsOf(level: string): string {
  if (level === "edit") return t("shareLinkToEdit");
  if (level === "comment") return t("shareLinkToComment");
  return t("shareLinkToRead");
}

/** A link's expiry, as the end of the day it names, in this device's time. */
function endOf(day: string): string {
  return new Date(`${day}T23:59:59`).toISOString();
}

export function ShareLinks(props: {
  readonly link: VaultLink;
  readonly unit: string;
  readonly onStatus: (status: string) => void;
  readonly onError: (error: string) => void;
}) {
  const { link, unit, onStatus, onError } = props;
  const { server, workspaceId } = link;
  const [links, setLinks] = useState<readonly ShareLink[]>([]);
  const [level, setLevel] = useState<(typeof linkLevels)[number]>("view");
  const [expires, setExpires] = useState("");
  const [password, setPassword] = useState("");
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
    setLinks(await shareLinks(backend.serverFetch, server, await session(), workspaceId, unit));
  }, [server, session, workspaceId, unit]);

  useEffect(() => {
    load().catch(report);
  }, [load, report]);

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

  const make = (event: SyntheticEvent) => {
    event.preventDefault();
    act(async (token) => {
      const made = await makeShareLink(backend.serverFetch, server, token, workspaceId, unit, {
        level,
        ...(expires === "" ? {} : { expiresAt: endOf(expires) }),
        ...(password === "" ? {} : { password }),
      });
      setLevel("view");
      setExpires("");
      setPassword("");
      await navigator.clipboard.writeText(made.url).catch(() => undefined);
      return t("shareLinkMade");
    });
  };

  const dates = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
  return (
    <section className="share-links" aria-labelledby="share-links-title">
      <h3 id="share-links-title">{t("shareLinks")}</h3>
      <p className="hint">{t("shareLinksIntro")}</p>
      {links.length === 0 ? null : (
        <ul className="plugin-list">
          {links.map((each) => (
            <li key={each.id} className="share-link">
              <p>
                {letsOf(each.level)}
                {each.expiresAt === null
                  ? null
                  : ` ${t("shareLinkUntil", { date: dates.format(new Date(each.expiresAt)) })}`}
                {each.password ? ` ${t("shareLinkWithPassword")}` : null}
              </p>
              <input
                type="text"
                readOnly
                value={each.url}
                aria-label={t("shareLinkAddress")}
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
                    navigator.clipboard.writeText(each.url).then(() => {
                      onStatus(t("shareLinkCopied"));
                    }, report);
                  }}
                >
                  {t("shareLinkCopy")}
                </button>
                <button
                  type="button"
                  className="quiet danger"
                  disabled={busy}
                  onClick={() => {
                    act(async (token) => {
                      await revokeShareLink(
                        backend.serverFetch,
                        server,
                        token,
                        workspaceId,
                        unit,
                        each.id,
                      );
                      return t("shareLinkRevoked");
                    });
                  }}
                >
                  {t("shareLinkRevoke")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="share-link-new" onSubmit={make}>
        <label className="field">
          {t("accessLevel")}
          <select
            value={level}
            onChange={(event) => {
              const chosen = linkLevels.find((each) => each === event.target.value);
              if (chosen !== undefined) setLevel(chosen);
            }}
          >
            {linkLevels.map((each) => (
              <option key={each} value={each}>
                {levelName(each)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("shareLinkExpires")}
          <input
            type="date"
            value={expires}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(event) => {
              setExpires(event.target.value);
            }}
          />
        </label>
        <label className="field">
          {t("shareLinkPassword")}
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          {t("shareLinkMake")}
        </button>
      </form>
    </section>
  );
}

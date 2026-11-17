// The console's Directories page (ADR 0085), while the `scim` feature is
// on: the directories that provision the server's accounts, each with the
// email domains it speaks for, its SCIM address and its token, and a form
// to add or change one. A token is shown once, when it is made; the page
// shows its last characters and when it ends, and warns a month before.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { t } from "./messages.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

interface TokenView {
  readonly hint: string;
  readonly expiresAt: string;
  readonly ended: boolean;
  readonly endsSoon: boolean;
}

interface DirectoryView {
  readonly id: string;
  readonly kind: "scim" | "ldap";
  readonly name: string;
  readonly domains: readonly string[];
  readonly otherDomains: boolean;
  readonly accounts: number;
  readonly deactivated: number;
  readonly scimUrl: string | null;
  readonly token: TokenView | null;
}

interface DirectoriesState {
  readonly directories: readonly DirectoryView[];
  readonly publicUrl: string | null;
  readonly signIn: { readonly providers: number; readonly oidc: boolean; readonly codes: boolean };
}

/** A token just made, shown once. */
interface MadeToken {
  readonly id: string;
  readonly token: string;
}

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** How long a new token lasts: a year unless the admin picks another, two at most. */
const lengths = [90, 180, 365, 730] as const;

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  const answer = await webFetch(`${webServer}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!answer.ok) throw new Error(await messageOf(answer));
  return answer;
}

/** Domains as typed: one a line, or separated by commas or spaces. */
function domainList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter((domain) => domain !== "");
}

function DirectoryForm(props: {
  readonly directory: DirectoryView | undefined;
  readonly busy: boolean;
  readonly onSave: (body: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}) {
  const { directory, busy, onSave, onCancel } = props;
  const editing = directory !== undefined;
  const [id, setId] = useState(directory?.id ?? "");
  const [name, setName] = useState(directory?.name ?? "");
  const [domains, setDomains] = useState(directory?.domains.join("\n") ?? "");
  const [otherDomains, setOtherDomains] = useState(directory?.otherDomains ?? false);
  const prefix = editing ? `directory-${directory.id}` : "directory-new";

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    onSave({
      ...(editing ? {} : { id: id.trim() }),
      name: name.trim(),
      domains: domainList(domains),
      otherDomains,
    });
  };

  return (
    <form className="admin-directory-form" onSubmit={submit}>
      {editing ? null : (
        <div className="field">
          <label htmlFor={`${prefix}-id`}>{t("adminDirectoriesId")}</label>
          <input
            id={`${prefix}-id`}
            value={id}
            required
            pattern="[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?"
            aria-describedby={`${prefix}-id-hint`}
            onChange={(event) => {
              setId(event.target.value);
            }}
          />
          <p className="hint" id={`${prefix}-id-hint`}>
            {t("adminDirectoriesIdHint")}
          </p>
        </div>
      )}
      <label className="field">
        {t("adminDirectoriesName")}
        <input
          value={name}
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <div className="field">
        <label htmlFor={`${prefix}-domains`}>{t("adminDirectoriesDomains")}</label>
        <textarea
          id={`${prefix}-domains`}
          rows={3}
          value={domains}
          aria-describedby={`${prefix}-domains-hint`}
          onChange={(event) => {
            setDomains(event.target.value);
          }}
        />
        <p className="hint" id={`${prefix}-domains-hint`}>
          {t("adminDirectoriesDomainsHint")}
        </p>
      </div>
      <div className="field">
        <label className="field-check">
          <input
            type="checkbox"
            checked={otherDomains}
            aria-describedby={`${prefix}-other-hint`}
            onChange={(event) => {
              setOtherDomains(event.target.checked);
            }}
          />
          {t("adminDirectoriesOtherDomains")}
        </label>
        <p className="hint" id={`${prefix}-other-hint`}>
          {t("adminDirectoriesOtherDomainsHint")}
        </p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {t(editing ? "adminDirectoriesSave" : "adminDirectoriesAdd")}
        </button>
      </div>
    </form>
  );
}

/** What the page says of a directory's token, by its last characters and its end. */
function tokenText(token: TokenView | null): string {
  if (token === null) return t("adminDirectoriesNoToken");
  return t(token.ended ? "adminDirectoriesTokenEnded" : "adminDirectoriesTokenEnds", {
    hint: token.hint,
    date: day.format(new Date(token.expiresAt)),
  });
}

/** A warning a month before the token ends, and a token just made, shown once. */
function TokenNotes(props: {
  readonly directory: DirectoryView;
  readonly made: MadeToken | undefined;
}) {
  const { directory, made } = props;
  const { token } = directory;
  const [copied, setCopied] = useState(false);
  return (
    <>
      {token !== null && !token.ended && token.endsSoon ? (
        <p role="alert">{t("adminDirectoriesTokenSoon")}</p>
      ) : null}
      {made?.id !== directory.id ? null : (
        <div className="field">
          <label htmlFor={`directory-${directory.id}-made`}>{t("adminDirectoriesMadeToken")}</label>
          <span className="field-actions">
            <input
              id={`directory-${directory.id}-made`}
              className="admin-directory-value"
              readOnly
              value={made.token}
              aria-describedby={`directory-${directory.id}-made-hint`}
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(made.token).then(() => {
                  setCopied(true);
                });
              }}
            >
              {t("copy")}
            </button>
          </span>
          <p className="hint" id={`directory-${directory.id}-made-hint`}>
            {copied ? t("adminDirectoriesCopied") : t("adminDirectoriesMadeTokenHint")}
          </p>
        </div>
      )}
    </>
  );
}

export function DirectoriesPage() {
  const [state, setState] = useState<DirectoriesState | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [removing, setRemoving] = useState<string | undefined>();
  const [made, setMade] = useState<MadeToken | undefined>();
  const [days, setDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const load = useCallback(async () => {
    const answer = await send("/api/admin/directories", "GET");
    setState((await answer.json()) as DirectoriesState);
  }, []);

  useEffect(() => {
    load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [load]);

  const act = (work: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    work()
      .then(async (done) => {
        await load();
        setStatus(done);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const save = (directory: DirectoryView | undefined, body: Record<string, unknown>) => {
    act(async () => {
      if (directory === undefined) await send("/api/admin/directories", "POST", body);
      else await send(`/api/admin/directories/${directory.id}`, "PATCH", body);
      setEditing(undefined);
      return t(directory === undefined ? "adminDirectoriesAdded" : "adminDirectoriesSaved", {
        name: String(body.name),
      });
    });
  };

  const noWayIn = state?.signIn.providers === 0 && !state.signIn.oidc && !state.signIn.codes;

  return (
    <section className="admin-section" aria-labelledby="admin-directories">
      <h2 id="admin-directories">{t("adminDirectories")}</h2>
      <p className="hint">{t("adminDirectoriesIntro")}</p>
      {state === undefined ? null : (
        <>
          {state.publicUrl === null ? <p role="alert">{t("adminDirectoriesNoPublicUrl")}</p> : null}
          {noWayIn ? <p role="alert">{t("adminDirectoriesNoWayIn")}</p> : null}
          {state.directories.length === 0 ? <p>{t("adminDirectoriesNone")}</p> : null}
          <ul className="admin-directories">
            {state.directories.map((directory) => (
              <li key={directory.id} aria-labelledby={`directory-${directory.id}-name`}>
                <h3 id={`directory-${directory.id}-name`}>
                  {directory.name} <span className="hint">{directory.id}</span>
                </h3>
                {editing === directory.id ? (
                  <DirectoryForm
                    directory={directory}
                    busy={busy}
                    onSave={(body) => {
                      save(directory, body);
                    }}
                    onCancel={() => {
                      setEditing(undefined);
                    }}
                  />
                ) : (
                  <>
                    <dl className="admin-usage">
                      <div>
                        <dt>{t("adminDirectoriesDomains")}</dt>
                        <dd>
                          {directory.domains.length === 0
                            ? t("adminDirectoriesNoDomains")
                            : directory.domains.join(", ")}
                          {directory.otherDomains ? (
                            <span className="hint"> {t("adminDirectoriesAndOthers")}</span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("adminDirectoriesAccounts")}</dt>
                        <dd>
                          {t("adminDirectoriesAccountsCount", {
                            count: directory.accounts,
                            deactivated: directory.deactivated,
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("adminDirectoriesAddress")}</dt>
                        <dd className="admin-directory-value">
                          {directory.scimUrl ?? t("adminDirectoriesNoAddress")}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("adminDirectoriesToken")}</dt>
                        <dd>{tokenText(directory.token)}</dd>
                      </div>
                    </dl>
                    <TokenNotes directory={directory} made={made} />
                    <div className="dialog-actions">
                      {removing === directory.id ? (
                        <>
                          <span>{t("adminDirectoriesRemoveAsk", { name: directory.name })}</span>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setRemoving(undefined);
                            }}
                          >
                            {t("adminDirectoriesKeep")}
                          </button>
                          <button
                            type="button"
                            className="quiet danger"
                            disabled={busy}
                            onClick={() => {
                              act(async () => {
                                await send(`/api/admin/directories/${directory.id}`, "DELETE");
                                setRemoving(undefined);
                                return t("adminDirectoriesRemoved", { name: directory.name });
                              });
                            }}
                          >
                            {t("adminDirectoriesRemove")}
                          </button>
                        </>
                      ) : (
                        <>
                          <label className="admin-directory-lasts">
                            {t("adminDirectoriesLasts")}
                            <select
                              value={days}
                              onChange={(event) => {
                                setDays(Number(event.target.value));
                              }}
                            >
                              {lengths.map((length) => (
                                <option key={length} value={length}>
                                  {t("adminDirectoriesDays", { days: length })}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            disabled={busy || directory.kind !== "scim"}
                            onClick={() => {
                              act(async () => {
                                const answer = await send(
                                  `/api/admin/directories/${directory.id}/token`,
                                  "POST",
                                  { days },
                                );
                                const { token } = (await answer.json()) as {
                                  readonly token: string;
                                };
                                setMade({ id: directory.id, token });
                                return t("adminDirectoriesTokenMade", { name: directory.name });
                              });
                            }}
                          >
                            {t(
                              directory.token === null
                                ? "adminDirectoriesMakeToken"
                                : "adminDirectoriesNewToken",
                            )}
                          </button>
                          {directory.token === null ? null : (
                            <button
                              type="button"
                              className="quiet"
                              disabled={busy}
                              onClick={() => {
                                act(async () => {
                                  await send(
                                    `/api/admin/directories/${directory.id}/token`,
                                    "DELETE",
                                  );
                                  setMade(undefined);
                                  return t("adminDirectoriesTokenRevoked", {
                                    name: directory.name,
                                  });
                                });
                              }}
                            >
                              {t("adminDirectoriesRevoke")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setRemoving(directory.id);
                            }}
                          >
                            {t("adminDirectoriesRemove")}
                          </button>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setEditing(directory.id);
                            }}
                          >
                            {t("adminDirectoriesChange")}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          {editing === "" ? (
            <DirectoryForm
              directory={undefined}
              busy={busy}
              onSave={(body) => {
                save(undefined, body);
              }}
              onCancel={() => {
                setEditing(undefined);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditing("");
              }}
            >
              {t("adminDirectoriesAddDirectory")}
            </button>
          )}
        </>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

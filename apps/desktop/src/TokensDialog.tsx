// An account's personal access tokens on a server (ADR 0059): the list,
// each with what it reaches, when it expires and when it was last used;
// making one, with the password again or a recent sign-in, its secret shown
// once with a button to copy it; and revoking one, at once.
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiToken, apiTokens, makeApiToken, revokeApiToken } from "./apiTokens.ts";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import { type Workspace, account } from "./server.ts";
import { hostOf } from "./sync.ts";
import { useModal } from "./useModal.ts";

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a token reaches, when it expires and when it was last used, in a line. */
function details(token: ApiToken): string[] {
  const expires = token.expiresAt === null ? undefined : Date.parse(token.expiresAt);
  return [
    t("apiTokenScope", {
      access: t(token.access === "write" ? "apiTokenWrites" : "apiTokenReads"),
      workspace: token.workspace?.name ?? t("apiTokenEveryWorkspace"),
    }),
    t("apiTokenEnds", { hint: token.hint }),
    expires === undefined
      ? t("apiTokenNeverExpires")
      : t(expires < Date.now() ? "apiTokenExpired" : "apiTokenExpires", {
          date: day.format(expires),
        }),
    token.usedAt === null
      ? t("apiTokenNeverUsed")
      : t("apiTokenUsed", { date: day.format(Date.parse(token.usedAt)) }),
  ];
}

export function TokensDialog(props: { readonly server: string; readonly onClose: () => void }) {
  const { server, onClose } = props;
  const [tokens, setTokens] = useState<readonly ApiToken[] | undefined>();
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [workspace, setWorkspace] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const dialog = useRef<HTMLDivElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  useModal(dialog);

  const session = useCallback(async () => {
    const found = await backend.serverToken(server);
    if (found === undefined) throw new Error(t("syncSignedOut", { server: hostOf(server) }));
    return found;
  }, [server]);

  const load = useCallback(async () => {
    const token = await session();
    setTokens(await apiTokens(backend.serverFetch, server, token));
    setWorkspaces((await account(backend.serverFetch, server, token)).workspaces);
  }, [session, server]);

  useEffect(() => {
    load().catch((reason: unknown) => {
      setError(messageOf(reason));
    });
  }, [load]);

  const act = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    work()
      .catch((reason: unknown) => {
        setError(messageOf(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="switcher dialog members-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tokens-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="tokens-title">{t("apiTokensOf", { server: hostOf(server) })}</h2>
        <p className="hint">{t("apiTokensHint")}</p>
        {tokens === undefined ? null : tokens.length === 0 ? (
          <p className="hint">{t("apiTokensNone")}</p>
        ) : (
          <ul className="member-list" aria-label={t("apiTokensList")}>
            {tokens.map((token) => (
              <li key={token.id}>
                <span className="member-name">{token.name}</span>
                {details(token).map((line) => (
                  <span key={line} className="hint">
                    {line}
                  </span>
                ))}
                <button
                  type="button"
                  className="quiet danger"
                  disabled={busy}
                  onClick={() => {
                    act(async () => {
                      await revokeApiToken(backend.serverFetch, server, await session(), token.id);
                      await load();
                      setStatus(t("apiTokenRevoked", { name: token.name }));
                    });
                  }}
                >
                  {t("apiTokenRevoke", { name: token.name })}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="member-invite"
          onSubmit={(event) => {
            event.preventDefault();
            act(async () => {
              const made = await makeApiToken(backend.serverFetch, server, await session(), {
                name: name.trim(),
                access,
                ...(workspace === "" ? {} : { workspace }),
                ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
                password,
              });
              setSecret(made.secret);
              setStatus(t("apiTokenMade", { name: made.token.name }));
              setName("");
              setPassword("");
              await load();
            });
          }}
        >
          <fieldset disabled={busy}>
            <legend>{t("apiTokenMake")}</legend>
            <label className="field">
              {t("apiTokenName")}
              <input
                type="text"
                required
                maxLength={200}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <label className="field">
              {t("apiTokenAccess")}
              <select
                value={access}
                onChange={(event) => {
                  setAccess(event.target.value === "write" ? "write" : "read");
                }}
              >
                <option value="read">{t("apiTokenReads")}</option>
                <option value="write">{t("apiTokenWrites")}</option>
              </select>
            </label>
            <label className="field">
              {t("apiTokenWorkspace")}
              <select
                value={workspace}
                onChange={(event) => {
                  setWorkspace(event.target.value);
                }}
              >
                <option value="">{t("apiTokenAllWorkspaces")}</option>
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t("apiTokenExpiry")}
              <select
                value={expiry}
                onChange={(event) => {
                  setExpiry(event.target.value);
                }}
              >
                <option value="30">{t("apiTokenInDays", { days: 30 })}</option>
                <option value="90">{t("apiTokenInDays", { days: 90 })}</option>
                <option value="365">{t("apiTokenInAYear")}</option>
                <option value="never">{t("apiTokenNever")}</option>
              </select>
            </label>
            <label className="field">
              {t("apiTokenPassword")}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                aria-describedby="token-password-hint"
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
              <span id="token-password-hint" className="hint">
                {t("apiTokenPasswordHint")}
              </span>
            </label>
            <button type="submit">{t("apiTokenMakeButton")}</button>
          </fieldset>
          {secret === undefined ? null : (
            <div className="field">
              <label htmlFor="token-secret">{t("apiTokenSecret")}</label>
              <span className="field-actions">
                <input
                  id="token-secret"
                  ref={secretField}
                  type="text"
                  readOnly
                  value={secret}
                  onFocus={(event) => {
                    event.target.select();
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(secret).then(
                      () => {
                        setStatus(t("apiTokenCopied"));
                      },
                      () => {
                        secretField.current?.focus();
                        setStatus(t("apiTokenCopyYourself"));
                      },
                    );
                  }}
                >
                  {t("copy")}
                </button>
              </span>
            </div>
          )}
        </form>
        {status === undefined ? null : <p role="status">{status}</p>}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

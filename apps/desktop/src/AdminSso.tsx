// The console's Single sign-on page (ADR 0080), while the `sso` feature is
// on: the server's SAML and OpenID Connect providers, the email domains
// each is trusted for, what to give each provider, and a form to add or
// change one; and what single sign-on requires: each provider's domains,
// everyone, and instance admins too. Secrets go to the server, sealed
// there, and never come back.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { t } from "./messages.ts";
import { webFetch, webServer } from "./web.ts";

interface SamlView {
  readonly metadataUrl: string | null;
  readonly readAt: string;
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly requireEncryption: boolean;
  readonly subjectAttribute: string | null;
  readonly emailAttribute: string | null;
  readonly nameAttribute: string | null;
  readonly nether: {
    readonly entityId: string;
    readonly acsUrl: string;
    readonly metadataUrl: string;
    readonly certificate: string;
  } | null;
}

interface OidcView {
  readonly issuer: string;
  readonly clientId: string;
  readonly secret: boolean;
  readonly callbackUrl: string | null;
}

interface ProviderView {
  readonly id: string;
  readonly kind: "saml" | "oidc";
  readonly name: string;
  readonly makeAccounts: boolean;
  readonly required: boolean;
  readonly domains: readonly string[];
  readonly saml?: SamlView;
  readonly oidc?: OidcView;
}

interface SsoState {
  readonly providers: readonly ProviderView[];
  readonly publicUrl: string | null;
  readonly secretKey: boolean;
  readonly privateSetting: string;
  readonly environment: { readonly name: string; readonly issuer: string } | null;
  readonly enforcement: Enforcement;
}

interface Enforcement {
  readonly everyone: boolean;
  readonly admins: boolean;
  /** The variable that pins enforcement off, when it does. */
  readonly pinnedBy: string | null;
  /** Whether an instance admin has a password, or the server sends codes. */
  readonly adminWayIn: boolean;
}

async function messageOf(answer: Response): Promise<string> {
  try {
    const body = (await answer.json()) as { readonly message?: unknown };
    return typeof body.message === "string" ? body.message : answer.statusText;
  } catch {
    return answer.statusText;
  }
}

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

const optional = (text: string) => (text.trim() === "" ? null : text.trim());

function ProviderForm(props: {
  readonly provider: ProviderView | undefined;
  readonly busy: boolean;
  readonly onSave: (body: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}) {
  const { provider, busy, onSave, onCancel } = props;
  const editing = provider !== undefined;
  const [kind, setKind] = useState<"saml" | "oidc">(provider?.kind ?? "saml");
  const [id, setId] = useState(provider?.id ?? "");
  const [name, setName] = useState(provider?.name ?? "");
  const [domains, setDomains] = useState(provider?.domains.join("\n") ?? "");
  const [makeAccounts, setMakeAccounts] = useState(provider?.makeAccounts ?? true);
  const [required, setRequired] = useState(provider?.required ?? false);
  const [metadataUrl, setMetadataUrl] = useState(provider?.saml?.metadataUrl ?? "");
  const [metadataXml, setMetadataXml] = useState("");
  const [requireEncryption, setRequireEncryption] = useState(
    provider?.saml?.requireEncryption ?? false,
  );
  const [subjectAttribute, setSubjectAttribute] = useState(provider?.saml?.subjectAttribute ?? "");
  const [emailAttribute, setEmailAttribute] = useState(provider?.saml?.emailAttribute ?? "");
  const [nameAttribute, setNameAttribute] = useState(provider?.saml?.nameAttribute ?? "");
  const [issuer, setIssuer] = useState(provider?.oidc?.issuer ?? "");
  const [clientId, setClientId] = useState(provider?.oidc?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const prefix = editing ? `sso-${provider.id}` : "sso-new";

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const common = {
      name: name.trim(),
      domains: domainList(domains),
      makeAccounts,
      required,
    };
    if (kind === "saml") {
      const keptUrl = provider?.saml?.metadataUrl ?? "";
      const metadata =
        metadataXml.trim() !== ""
          ? { metadataXml }
          : metadataUrl.trim() !== "" && (!editing || metadataUrl.trim() !== keptUrl)
            ? { metadataUrl: metadataUrl.trim() }
            : {};
      onSave({
        ...(editing ? {} : { id: id.trim() }),
        ...common,
        saml: {
          ...metadata,
          requireEncryption,
          subjectAttribute: optional(subjectAttribute),
          emailAttribute: optional(emailAttribute),
          nameAttribute: optional(nameAttribute),
        },
      });
    } else {
      onSave({
        ...(editing ? {} : { id: id.trim() }),
        ...common,
        oidc: {
          issuer: issuer.trim(),
          clientId: clientId.trim(),
          // Left empty while changing one, the secret kept stays.
          ...(clientSecret.trim() === ""
            ? editing
              ? {}
              : { clientSecret: null }
            : { clientSecret }),
        },
      });
    }
  };

  return (
    <form className="admin-sso-form" onSubmit={submit}>
      {editing ? null : (
        <fieldset>
          <legend>{t("adminSsoKind")}</legend>
          <label className="field-check">
            <input
              type="radio"
              name="sso-kind"
              checked={kind === "saml"}
              onChange={() => {
                setKind("saml");
              }}
            />
            {t("adminSsoSaml")}
          </label>
          <label className="field-check">
            <input
              type="radio"
              name="sso-kind"
              checked={kind === "oidc"}
              onChange={() => {
                setKind("oidc");
              }}
            />
            {t("adminSsoOidc")}
          </label>
        </fieldset>
      )}
      {editing ? null : (
        <div className="field">
          <label htmlFor={`${prefix}-id`}>{t("adminSsoId")}</label>
          <input
            id={`${prefix}-id`}
            required
            pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?"
            aria-describedby={`${prefix}-id-hint`}
            value={id}
            onChange={(event) => {
              setId(event.target.value);
            }}
          />
          <p className="hint" id={`${prefix}-id-hint`}>
            {t("adminSsoIdHint")}
          </p>
        </div>
      )}
      <label className="field">
        {t("adminSsoName")}
        <input
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <div className="field">
        <label htmlFor={`${prefix}-domains`}>{t("adminSsoDomains")}</label>
        <textarea
          id={`${prefix}-domains`}
          rows={2}
          aria-describedby={`${prefix}-domains-hint`}
          value={domains}
          onChange={(event) => {
            setDomains(event.target.value);
          }}
        />
        <p className="hint" id={`${prefix}-domains-hint`}>
          {t("adminSsoDomainsHint")}
        </p>
      </div>
      <label className="field-check">
        <input
          type="checkbox"
          checked={makeAccounts}
          onChange={(event) => {
            setMakeAccounts(event.target.checked);
          }}
        />
        {t("adminSsoMakeAccounts")}
      </label>
      <label className="field-check">
        <input
          type="checkbox"
          checked={required}
          onChange={(event) => {
            setRequired(event.target.checked);
          }}
        />
        {t("adminSsoRequire")}
      </label>
      {kind === "saml" ? (
        <>
          <label className="field">
            {t("adminSsoMetadataUrl")}
            <input
              type="url"
              value={metadataUrl}
              onChange={(event) => {
                setMetadataUrl(event.target.value);
              }}
            />
          </label>
          <div className="field">
            <label htmlFor={`${prefix}-xml`}>{t("adminSsoMetadataXml")}</label>
            <textarea
              id={`${prefix}-xml`}
              rows={4}
              aria-describedby={`${prefix}-xml-hint`}
              value={metadataXml}
              onChange={(event) => {
                setMetadataXml(event.target.value);
              }}
            />
            <p className="hint" id={`${prefix}-xml-hint`}>
              {t("adminSsoMetadataHint")}
            </p>
          </div>
          <label className="field-check">
            <input
              type="checkbox"
              checked={requireEncryption}
              onChange={(event) => {
                setRequireEncryption(event.target.checked);
              }}
            />
            {t("adminSsoRequireEncryption")}
          </label>
          <details>
            <summary>{t("adminSsoAttributes")}</summary>
            <p className="hint">{t("adminSsoAttributesHint")}</p>
            <label className="field">
              {t("adminSsoSubjectAttribute")}
              <input
                value={subjectAttribute}
                onChange={(event) => {
                  setSubjectAttribute(event.target.value);
                }}
              />
            </label>
            <label className="field">
              {t("adminSsoEmailAttribute")}
              <input
                value={emailAttribute}
                onChange={(event) => {
                  setEmailAttribute(event.target.value);
                }}
              />
            </label>
            <label className="field">
              {t("adminSsoNameAttribute")}
              <input
                value={nameAttribute}
                onChange={(event) => {
                  setNameAttribute(event.target.value);
                }}
              />
            </label>
          </details>
        </>
      ) : (
        <>
          <label className="field">
            {t("adminSsoIssuer")}
            <input
              type="url"
              required
              value={issuer}
              onChange={(event) => {
                setIssuer(event.target.value);
              }}
            />
          </label>
          <label className="field">
            {t("adminSsoClientId")}
            <input
              required
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value);
              }}
            />
          </label>
          <div className="field">
            <label htmlFor={`${prefix}-secret`}>{t("adminSsoClientSecret")}</label>
            <input
              id={`${prefix}-secret`}
              type="password"
              autoComplete="off"
              aria-describedby={`${prefix}-secret-hint`}
              value={clientSecret}
              onChange={(event) => {
                setClientSecret(event.target.value);
              }}
            />
            <p className="hint" id={`${prefix}-secret-hint`}>
              {t(editing ? "adminSsoClientSecretKept" : "adminSsoClientSecretHint")}
            </p>
          </div>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" className="quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {t(editing ? "adminSsoSave" : "adminSsoAdd")}
        </button>
      </div>
    </form>
  );
}

/** What to give a provider, and what it gave. */
function ProviderDetails(props: { readonly provider: ProviderView }) {
  const { provider } = props;
  const rows: [string, string][] = [
    [t("adminSsoDomains"), provider.domains.join(", ") || t("adminSsoNoDomains")],
    [t("adminSsoMakeAccounts"), t(provider.makeAccounts ? "adminSsoYes" : "adminSsoNo")],
    [t("adminSsoRequired"), t(provider.required ? "adminSsoYes" : "adminSsoNo")],
  ];
  if (provider.saml !== undefined) {
    const { saml } = provider;
    rows.push([t("adminSsoEntityId"), saml.entityId]);
    rows.push([
      t("adminSsoMetadataRead"),
      t(saml.metadataUrl === null ? "adminSsoPasted" : "adminSsoReadFrom", {
        url: saml.metadataUrl ?? "",
        date: new Date(saml.readAt).toLocaleString(),
      }),
    ]);
    rows.push([
      t("adminSsoRequireEncryption"),
      t(saml.requireEncryption ? "adminSsoYes" : "adminSsoNo"),
    ]);
  }
  if (provider.oidc !== undefined) {
    rows.push([t("adminSsoIssuer"), provider.oidc.issuer]);
    rows.push([t("adminSsoClientId"), provider.oidc.clientId]);
  }
  const give: [string, string][] =
    provider.saml?.nether != null
      ? [
          [t("adminSsoNetherEntityId"), provider.saml.nether.entityId],
          [t("adminSsoNetherAcs"), provider.saml.nether.acsUrl],
          [t("adminSsoNetherMetadata"), provider.saml.nether.metadataUrl],
        ]
      : provider.oidc?.callbackUrl != null
        ? [[t("adminSsoNetherCallback"), provider.oidc.callbackUrl]]
        : [];
  return (
    <>
      <dl className="admin-usage">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {give.length === 0 ? null : (
        <details>
          <summary>{t("adminSsoGive")}</summary>
          <dl className="admin-usage">
            {give.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd className="admin-sso-value">{value}</dd>
              </div>
            ))}
          </dl>
          {provider.saml?.nether == null ? null : (
            <div className="field">
              <label htmlFor={`sso-${provider.id}-certificate`}>{t("adminSsoCertificate")}</label>
              {/* Read only, to select and copy; it scrolls, and takes the focus to. */}
              <textarea
                id={`sso-${provider.id}-certificate`}
                className="admin-sso-certificate"
                readOnly
                rows={8}
                value={provider.saml.nether.certificate}
              />
            </div>
          )}
        </details>
      )}
    </>
  );
}

/** What single sign-on requires beside each provider: everyone, and instance admins too. */
function EnforcementForm(props: {
  readonly enforcement: Enforcement;
  readonly busy: boolean;
  readonly onSave: (body: { everyone: boolean; admins: boolean }) => void;
}) {
  const { enforcement, busy, onSave } = props;
  const [everyone, setEveryone] = useState(enforcement.everyone);
  const [admins, setAdmins] = useState(enforcement.admins);
  const pinned = enforcement.pinnedBy !== null;
  return (
    <form
      className="admin-sso-form"
      aria-labelledby="admin-sso-enforcement"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ everyone, admins });
      }}
    >
      <h3 id="admin-sso-enforcement">{t("adminSsoEnforcement")}</h3>
      <p className="hint">{t("adminSsoEnforcementIntro")}</p>
      {enforcement.pinnedBy === null ? null : (
        <p role="note">{t("adminSsoPinned", { variable: enforcement.pinnedBy })}</p>
      )}
      <div className="field">
        <label className="field-check">
          <input
            type="checkbox"
            disabled={pinned}
            aria-describedby="admin-sso-everyone-hint"
            checked={everyone}
            onChange={(event) => {
              setEveryone(event.target.checked);
            }}
          />
          {t("adminSsoEveryone")}
        </label>
        <p className="hint" id="admin-sso-everyone-hint">
          {t("adminSsoEveryoneHint")}
        </p>
      </div>
      <div className="field">
        <label className="field-check">
          <input
            type="checkbox"
            disabled={pinned}
            aria-describedby="admin-sso-admins-hint"
            checked={admins}
            onChange={(event) => {
              setAdmins(event.target.checked);
            }}
          />
          {t("adminSsoAdmins")}
        </label>
        <p className="hint" id="admin-sso-admins-hint">
          {t("adminSsoAdminsHint")}
        </p>
      </div>
      {enforcement.admins ? <p role="note">{t("adminSsoAdminsCovered")}</p> : null}
      {!enforcement.admins && !enforcement.adminWayIn ? (
        <p role="note">{t("adminSsoNoAdminWayIn")}</p>
      ) : null}
      <div className="dialog-actions">
        <button type="submit" disabled={busy || pinned}>
          {t("adminSsoSave")}
        </button>
      </div>
    </form>
  );
}

export function SsoPage() {
  const [state, setState] = useState<SsoState | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [removing, setRemoving] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const load = useCallback(async () => {
    const answer = await send("/api/admin/sso", "GET");
    setState((await answer.json()) as SsoState);
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

  const save = (provider: ProviderView | undefined, body: Record<string, unknown>) => {
    act(async () => {
      if (provider === undefined) await send("/api/admin/sso/providers", "POST", body);
      else await send(`/api/admin/sso/providers/${provider.id}`, "PUT", body);
      setEditing(undefined);
      return t(provider === undefined ? "adminSsoAdded" : "adminSsoSaved", {
        name: String(body.name),
      });
    });
  };

  return (
    <section className="admin-section" aria-labelledby="admin-sso">
      <h2 id="admin-sso">{t("adminSso")}</h2>
      <p className="hint">{t("adminSsoIntro")}</p>
      {state === undefined ? null : (
        <>
          {state.publicUrl === null ? <p role="alert">{t("adminSsoNoPublicUrl")}</p> : null}
          {state.secretKey ? null : <p role="alert">{t("adminSsoNoSecretKey")}</p>}
          {state.environment === null ? null : (
            <p className="hint">
              {t("adminSsoEnvironment", {
                name: state.environment.name,
                issuer: state.environment.issuer,
              })}
            </p>
          )}
          {state.providers.length === 0 ? <p>{t("adminSsoNone")}</p> : null}
          <ul className="admin-sso-providers">
            {state.providers.map((provider) => (
              <li key={provider.id} aria-labelledby={`sso-${provider.id}-name`}>
                <h3 id={`sso-${provider.id}-name`}>
                  {provider.name}{" "}
                  <span className="hint">
                    {t(provider.kind === "saml" ? "adminSsoSaml" : "adminSsoOidc")}, {provider.id}
                  </span>
                </h3>
                {editing === provider.id ? (
                  <ProviderForm
                    provider={provider}
                    busy={busy}
                    onSave={(body) => {
                      save(provider, body);
                    }}
                    onCancel={() => {
                      setEditing(undefined);
                    }}
                  />
                ) : (
                  <>
                    <ProviderDetails provider={provider} />
                    <div className="dialog-actions">
                      {removing === provider.id ? (
                        <>
                          <span>{t("adminSsoRemoveAsk", { name: provider.name })}</span>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setRemoving(undefined);
                            }}
                          >
                            {t("adminSsoKeep")}
                          </button>
                          <button
                            type="button"
                            className="quiet danger"
                            disabled={busy}
                            onClick={() => {
                              act(async () => {
                                await send(`/api/admin/sso/providers/${provider.id}`, "DELETE");
                                setRemoving(undefined);
                                return t("adminSsoRemoved", { name: provider.name });
                              });
                            }}
                          >
                            {t("adminSsoRemove")}
                          </button>
                        </>
                      ) : (
                        <>
                          {provider.saml?.metadataUrl == null ? null : (
                            <button
                              type="button"
                              className="quiet"
                              disabled={busy}
                              onClick={() => {
                                act(async () => {
                                  await send(
                                    `/api/admin/sso/providers/${provider.id}/metadata`,
                                    "POST",
                                  );
                                  return t("adminSsoReadAgain", { name: provider.name });
                                });
                              }}
                            >
                              {t("adminSsoReadMetadata")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => {
                              setRemoving(provider.id);
                            }}
                          >
                            {t("adminSsoRemove")}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(provider.id);
                            }}
                          >
                            {t("adminSsoChange")}
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
            <ProviderForm
              provider={undefined}
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
              disabled={!state.secretKey || state.publicUrl === null}
              onClick={() => {
                setEditing("");
              }}
            >
              {t("adminSsoAddProvider")}
            </button>
          )}
          <EnforcementForm
            // Made again from what the server keeps after each save.
            key={JSON.stringify(state.enforcement)}
            enforcement={state.enforcement}
            busy={busy}
            onSave={(body) => {
              act(async () => {
                const answer = await send("/api/admin/sso/enforcement", "PUT", body);
                const { ended } = (await answer.json()) as {
                  readonly ended: { readonly sessions: number; readonly tokens: number };
                };
                return t("adminSsoEnforcementSaved", {
                  sessions: ended.sessions,
                  tokens: ended.tokens,
                });
              });
            }}
          />
        </>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

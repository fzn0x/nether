// The admin console's pages of the `policies` feature. The AI endpoints
// (ADR 0086): the addresses every Nether app sends AI requests to for this
// server's workspaces, while the list holds one. One address a line; the
// environment may pin the list, which then shows with no control. The data
// policies (ADR 0088): public sharing and export, for every workspace and
// for each one set apart.
import { type ReactNode, type SyntheticEvent, useEffect, useState } from "react";
import { type MessageKey, t } from "./messages.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

interface EndpointsState {
  readonly endpoints: readonly string[];
  readonly pinnedBy: string | null;
}

async function answered(answer: Response): Promise<EndpointsState> {
  if (!answer.ok) throw new Error(await messageOf(answer));
  return (await answer.json()) as EndpointsState;
}

export function AiEndpointsPage() {
  const [state, setState] = useState<EndpointsState | undefined>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const show = (found: EndpointsState) => {
    setState(found);
    setDraft(found.endpoints.join("\n"));
  };

  useEffect(() => {
    webFetch(`${webServer}/api/admin/ai-endpoints`)
      .then(answered)
      .then(show)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    webFetch(`${webServer}/api/admin/ai-endpoints`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoints: draft.split(/[\n,]/) }),
    })
      .then(answered)
      .then((found) => {
        show(found);
        setStatus(
          found.endpoints.length === 0 ? t("adminEndpointsUnlocked") : t("adminEndpointsSaved"),
        );
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section className="admin-section" aria-labelledby="admin-endpoints">
      <h2 id="admin-endpoints">{t("adminEndpoints")}</h2>
      <p className="hint">{t("adminEndpointsIntro")}</p>
      {state === undefined ? (
        error === undefined ? (
          <p role="status">{t("adminOpening")}</p>
        ) : null
      ) : state.pinnedBy !== null ? (
        <>
          <ul aria-label={t("adminEndpointsList")}>
            {state.endpoints.map((endpoint) => (
              <li key={endpoint}>{endpoint}</li>
            ))}
          </ul>
          <p className="hint">{t("adminPinned", { variable: state.pinnedBy })}</p>
        </>
      ) : (
        <form className="admin-endpoints" onSubmit={save}>
          <label className="field">
            {t("adminEndpointsList")}
            <textarea
              rows={4}
              value={draft}
              disabled={busy}
              spellCheck={false}
              aria-describedby="hint-endpoints"
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <span id="hint-endpoints" className="hint">
              {t("adminEndpointsHint")}
            </span>
          </label>
          <button type="submit" disabled={busy}>
            {t("adminSave")}
          </button>
        </form>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

type ShareLinks = "on" | "view" | "off";

interface DataPolicy {
  readonly shareLinks: ShareLinks;
  readonly sites: boolean;
  readonly export: boolean;
}

interface PoliciesState {
  readonly every: DataPolicy;
  readonly apart: readonly {
    readonly workspace: string;
    readonly name: string;
    readonly policy: DataPolicy;
  }[];
  readonly others: readonly { readonly workspace: string; readonly name: string }[];
}

const linkChoices: readonly { readonly value: ShareLinks; readonly label: MessageKey }[] = [
  { value: "on", label: "adminLinksOn" },
  { value: "view", label: "adminLinksView" },
  { value: "off", label: "adminLinksOff" },
];

async function answeredState(answer: Response): Promise<PoliciesState> {
  if (!answer.ok) throw new Error(await messageOf(answer));
  return (await answer.json()) as PoliciesState;
}

/** One policy's settings, saved together. */
function PolicyForm(props: {
  readonly id: string;
  readonly legend: string;
  readonly policy: DataPolicy;
  readonly busy: boolean;
  readonly onSave: (policy: DataPolicy) => void;
  readonly children?: ReactNode;
}) {
  const { id, legend, policy, busy, onSave, children } = props;
  const [draft, setDraft] = useState(policy);
  useEffect(() => {
    setDraft(policy);
  }, [policy]);
  return (
    <form
      className="admin-policy"
      onSubmit={(event: SyntheticEvent) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <fieldset>
        <legend>{legend}</legend>
        <label className="field">
          {t("adminLinks")}
          <select
            value={draft.shareLinks}
            disabled={busy}
            onChange={(event) => {
              setDraft({ ...draft, shareLinks: event.target.value as ShareLinks });
            }}
          >
            {linkChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {t(choice.label)}
              </option>
            ))}
          </select>
        </label>
        <div>
          <label className="field-check">
            <input
              type="checkbox"
              checked={draft.sites}
              disabled={busy}
              aria-describedby={`${id}-sites`}
              onChange={(event) => {
                setDraft({ ...draft, sites: event.target.checked });
              }}
            />
            {t("adminSites")}
          </label>
          <span id={`${id}-sites`} className="hint">
            {t("adminSitesHint")}
          </span>
        </div>
        <div>
          <label className="field-check">
            <input
              type="checkbox"
              checked={draft.export}
              disabled={busy}
              aria-describedby={`${id}-export`}
              onChange={(event) => {
                setDraft({ ...draft, export: event.target.checked });
              }}
            />
            {t("adminExport")}
          </label>
          <span id={`${id}-export`} className="hint">
            {t("adminExportHint")}
          </span>
        </div>
      </fieldset>
      <div className="admin-policy-actions">
        <button type="submit" disabled={busy}>
          {t("adminSave")}
        </button>
        {children}
      </div>
    </form>
  );
}

/**
 * The console's data policies (ADR 0088): public sharing and export for
 * every workspace, and for each workspace set apart from it. Owners' own
 * switches stay; a policy only narrows them.
 */
export function DataPoliciesPage() {
  const [state, setState] = useState<PoliciesState | undefined>();
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  useEffect(() => {
    webFetch(`${webServer}/api/admin/data-policies`)
      .then(answeredState)
      .then(setState)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const send = (path: string, method: "PUT" | "DELETE", saved: string, policy?: DataPolicy) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    webFetch(`${webServer}/api/admin/data-policies${path}`, {
      method,
      ...(policy === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(policy) }),
    })
      .then(answeredState)
      .then((found) => {
        setState(found);
        setStatus(saved);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const others = state?.others ?? [];
  const picked = others.some((each) => each.workspace === chosen) ? chosen : "";

  return (
    <section className="admin-section" aria-labelledby="admin-data-policies">
      <h2 id="admin-data-policies">{t("adminDataPolicies")}</h2>
      <p className="hint">{t("adminDataPoliciesIntro")}</p>
      {state === undefined ? (
        error === undefined ? (
          <p role="status">{t("adminOpening")}</p>
        ) : null
      ) : (
        <>
          <PolicyForm
            id="policy-every"
            legend={t("adminEveryWorkspace")}
            policy={state.every}
            busy={busy}
            onSave={(policy) => {
              send("", "PUT", t("adminPolicySaved", { name: t("adminEveryWorkspace") }), policy);
            }}
          />
          {state.apart.map((apart) => (
            <PolicyForm
              key={apart.workspace}
              id={`policy-${apart.workspace}`}
              legend={apart.name}
              policy={apart.policy}
              busy={busy}
              onSave={(policy) => {
                send(
                  `/workspaces/${apart.workspace}`,
                  "PUT",
                  t("adminPolicySaved", { name: apart.name }),
                  policy,
                );
              }}
            >
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  send(
                    `/workspaces/${apart.workspace}`,
                    "DELETE",
                    t("adminPolicyJoined", { name: apart.name }),
                  );
                }}
              >
                {t("adminUseEvery")}
              </button>
            </PolicyForm>
          ))}
          {others.length === 0 ? null : (
            <form
              className="admin-find"
              onSubmit={(event: SyntheticEvent) => {
                event.preventDefault();
                const name = others.find((each) => each.workspace === picked)?.name;
                if (name === undefined) return;
                send(
                  `/workspaces/${picked}`,
                  "PUT",
                  t("adminPolicySetApart", { name }),
                  state.every,
                );
              }}
            >
              <label className="field">
                {t("adminSetApartWhich")}
                <select
                  value={picked}
                  disabled={busy}
                  onChange={(event) => {
                    setChosen(event.target.value);
                  }}
                >
                  <option value="">{t("adminChooseWorkspace")}</option>
                  {others.map((each) => (
                    <option key={each.workspace} value={each.workspace}>
                      {each.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={busy || picked === ""}>
                {t("adminSetApart")}
              </button>
            </form>
          )}
        </>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

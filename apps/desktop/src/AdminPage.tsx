// The admin console, in the web app at /admin (ADR 0079), for the server's
// instance admins. Its Features page is in every build: each enterprise
// feature's switch, with why it is set as it is. The `admin` feature adds
// the server's usage, counted when the page asks, its workspaces (ADR
// 0083) and its security settings (ADR 0084). Only its own code loads, as
// a share link's page does.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AiEndpointsPage } from "./AdminPolicies.tsx";
import { SecurityPage } from "./AdminSecurity.tsx";
import { WorkspacesPage } from "./AdminWorkspaces.tsx";
import { t } from "./messages.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

type Feature = "sso" | "scim" | "audit" | "policies" | "admin" | "ha";

interface FeatureState {
  readonly feature: Feature;
  readonly on: boolean;
  readonly pinned: "on" | "off" | null;
  readonly available: boolean;
}

interface Usage {
  readonly version: string;
  readonly accounts: number;
  readonly activeAccounts: number;
  readonly workspaces: number;
  readonly encryptedWorkspaces: number;
  readonly notes: number;
  readonly attachments: number;
  readonly attachmentBytes: number;
}

const names = {
  sso: "adminFeatureSso",
  scim: "adminFeatureScim",
  audit: "adminFeatureAudit",
  policies: "adminFeaturePolicies",
  admin: "adminFeatureAdmin",
  ha: "adminFeatureHa",
} as const;

const numbers = new Intl.NumberFormat();
const bytes = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "megabyte",
  maximumFractionDigits: 1,
});

function isFeatureState(value: unknown): value is FeatureState {
  const state = value as Partial<FeatureState> | null;
  return (
    typeof state?.feature === "string" &&
    state.feature in names &&
    typeof state.on === "boolean" &&
    (state.pinned === null || state.pinned === "on" || state.pinned === "off") &&
    typeof state.available === "boolean"
  );
}

type Step =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "open"; readonly features: readonly FeatureState[] };

/** The variable the environment pins a feature with. */
function variableOf(feature: Feature): string {
  return `NETHER_ENTERPRISE_${feature.toUpperCase()}`;
}

function UsagePage(props: { readonly usage: Usage | undefined; readonly onCount: () => void }) {
  const { usage, onCount } = props;
  const rows: [string, ReactNode][] =
    usage === undefined
      ? []
      : [
          [t("adminAccounts"), numbers.format(usage.accounts)],
          [t("adminActiveAccounts"), numbers.format(usage.activeAccounts)],
          [
            t("adminWorkspaces"),
            usage.encryptedWorkspaces === 0
              ? numbers.format(usage.workspaces)
              : t("adminWorkspacesEncrypted", {
                  count: numbers.format(usage.workspaces),
                  encrypted: numbers.format(usage.encryptedWorkspaces),
                }),
          ],
          [t("adminNotes"), numbers.format(usage.notes)],
          [
            t("adminAttachments"),
            t("adminAttachmentsSize", {
              count: numbers.format(usage.attachments),
              size: bytes.format(usage.attachmentBytes / 1_000_000),
            }),
          ],
          [t("adminVersion"), usage.version],
        ];
  return (
    <section className="admin-section" aria-labelledby="admin-usage">
      <h2 id="admin-usage">{t("adminUsage")}</h2>
      {usage === undefined ? (
        <p role="status">{t("adminCounting")}</p>
      ) : (
        <dl className="admin-usage">
          {rows.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <button type="button" className="quiet" onClick={onCount}>
        {t("adminCountAgain")}
      </button>
    </section>
  );
}

export function AdminPage() {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [usage, setUsage] = useState<Usage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const answer = await webFetch(`${webServer}/api/instance/features`);
    if (answer.status === 401) {
      setStep({ kind: "refused", message: t("adminSignIn") });
      return;
    }
    if (!answer.ok) {
      setStep({ kind: "refused", message: await messageOf(answer) });
      return;
    }
    const body = (await answer.json()) as { readonly features?: unknown };
    const features = Array.isArray(body.features) ? body.features.filter(isFeatureState) : [];
    setStep({ kind: "open", features });
  }, []);

  useEffect(() => {
    load().catch((reason: unknown) => {
      setStep({ kind: "refused", message: String(reason) });
    });
  }, [load]);

  const consoleOn =
    step.kind === "open" && step.features.some((state) => state.feature === "admin" && state.on);
  const policiesOn =
    step.kind === "open" && step.features.some((state) => state.feature === "policies" && state.on);

  const count = useCallback(() => {
    setUsage(undefined);
    webFetch(`${webServer}/api/admin/usage`)
      .then(async (answer) => {
        if (!answer.ok) throw new Error(await messageOf(answer));
        setUsage((await answer.json()) as Usage);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    if (consoleOn) count();
  }, [consoleOn, count]);

  const turn = (state: FeatureState, on: boolean) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    // The switch moves at once, and back if the server refuses.
    const shown = (value: boolean) => {
      setStep((current) =>
        current.kind === "open"
          ? {
              kind: "open",
              features: current.features.map((each) =>
                each.feature === state.feature ? { ...each, on: value } : each,
              ),
            }
          : current,
      );
    };
    shown(on);
    webFetch(`${webServer}/api/instance/features/${state.feature}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(await messageOf(answer));
        await load();
        setStatus(t(on ? "adminTurnedOn" : "adminTurnedOff", { feature: t(names[state.feature]) }));
      })
      .catch((reason: unknown) => {
        shown(!on);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <main className="admin">
      <header className="admin-header">
        <h1>{t("adminTitle")}</h1>
        <a href="/">{t("adminBack")}</a>
      </header>
      {step.kind === "loading" ? <p role="status">{t("adminOpening")}</p> : null}
      {step.kind === "refused" ? <p role="alert">{step.message}</p> : null}
      {step.kind === "open" ? (
        <>
          <section className="admin-section" aria-labelledby="admin-features">
            <h2 id="admin-features">{t("adminFeatures")}</h2>
            <p className="hint">{t("adminFeaturesIntro")}</p>
            <ul className="admin-features">
              {step.features.map((state) => {
                const name = t(names[state.feature]);
                const why =
                  state.pinned !== null
                    ? t("adminPinned", { variable: variableOf(state.feature) })
                    : state.available
                      ? undefined
                      : t("adminUnavailable");
                return (
                  <li key={state.feature}>
                    <label className="field-check">
                      <input
                        type="checkbox"
                        checked={state.on}
                        disabled={busy || why !== undefined}
                        aria-describedby={why === undefined ? undefined : `why-${state.feature}`}
                        onChange={(event) => {
                          turn(state, event.target.checked);
                        }}
                      />
                      {name}
                    </label>
                    {why === undefined ? null : (
                      <p className="hint" id={`why-${state.feature}`}>
                        {why}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          {consoleOn ? (
            <>
              <UsagePage usage={usage} onCount={count} />
              <WorkspacesPage />
              <SecurityPage />
            </>
          ) : (
            <p className="hint">{t("adminConsoleOff")}</p>
          )}
          {policiesOn ? <AiEndpointsPage /> : null}
        </>
      ) : null}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </main>
  );
}

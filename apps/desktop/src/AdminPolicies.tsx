// The admin console's AI endpoints (ADR 0086), the `policies` feature's
// first page: the addresses every Nether app sends AI requests to for this
// server's workspaces, while the list holds one. One address a line; the
// environment may pin the list, which then shows with no control.
import { type SyntheticEvent, useEffect, useState } from "react";
import { t } from "./messages.ts";
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

// The admin console's Security page (ADR 0084): how long sessions last,
// how many sign-in tries an account and an address get, and whether a code
// by email signs in. A setting the environment pins shows its variable and
// no control. Saving sends what changed, all or none; beside it, the ways
// this server signs people in now.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { type MessageKey, t } from "./messages.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

type Name =
  | "sessionIdleDays"
  | "sessionLifetimeDays"
  | "signInTriesAccount"
  | "signInTriesAddress"
  | "emailCodes";

interface Setting {
  readonly name: Name;
  readonly value: number | boolean;
  readonly pinnedBy: string | null;
  readonly min?: number;
  readonly max?: number;
}

interface Methods {
  readonly password: boolean;
  readonly emailCode: boolean;
  readonly oidc: { readonly name: string } | null;
}

const labels: Readonly<Record<Name, MessageKey>> = {
  sessionIdleDays: "adminSessionIdleDays",
  sessionLifetimeDays: "adminSessionLifetimeDays",
  signInTriesAccount: "adminTriesAccount",
  signInTriesAddress: "adminTriesAddress",
  emailCodes: "adminEmailCodes",
};

/** What the form holds: a number's text as typed, or a switch. */
type Draft = Readonly<Partial<Record<Name, string | boolean>>>;

function draftOf(settings: readonly Setting[]): Draft {
  return Object.fromEntries(
    settings.map((setting) => [
      setting.name,
      typeof setting.value === "number" ? String(setting.value) : setting.value,
    ]),
  );
}

async function answered<T>(answer: Response): Promise<T> {
  if (!answer.ok) throw new Error(await messageOf(answer));
  return (await answer.json()) as T;
}

/** The changes to send, or why one cannot go: a number out of its range. */
function changesOf(
  settings: readonly Setting[],
  draft: Draft,
): Record<string, number | boolean> | string {
  const changes: Record<string, number | boolean> = {};
  for (const setting of settings) {
    if (setting.pinnedBy !== null) continue;
    const typed = draft[setting.name];
    if (typeof setting.value === "boolean") {
      if (typeof typed === "boolean" && typed !== setting.value) changes[setting.name] = typed;
      continue;
    }
    const text = typeof typed === "string" ? typed.trim() : "";
    const value = Number(text);
    const min = setting.min ?? 1;
    const max = setting.max ?? Number.MAX_SAFE_INTEGER;
    if (!/^\d+$/.test(text) || value < min || value > max) {
      return t("adminNotInRange", { setting: t(labels[setting.name]), min, max });
    }
    if (value !== setting.value) changes[setting.name] = value;
  }
  return changes;
}

function NumberField(props: {
  readonly setting: Setting;
  readonly draft: Draft;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { setting, draft, busy, onChange } = props;
  const hint = `hint-${setting.name}`;
  const typed = draft[setting.name];
  return (
    <label className="field">
      {t(labels[setting.name])}
      <input
        type="number"
        inputMode="numeric"
        min={setting.min}
        max={setting.max}
        step={1}
        value={typeof typed === "string" ? typed : ""}
        disabled={busy || setting.pinnedBy !== null}
        aria-describedby={hint}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <span id={hint} className="hint">
        {setting.pinnedBy === null
          ? t("adminRange", { min: setting.min ?? 1, max: setting.max ?? "" })
          : t("adminPinned", { variable: setting.pinnedBy })}
      </span>
    </label>
  );
}

export function SecurityPage() {
  const [settings, setSettings] = useState<readonly Setting[] | undefined>();
  const [draft, setDraft] = useState<Draft>({});
  const [methods, setMethods] = useState<Methods | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const show = useCallback((found: readonly Setting[]) => {
    setSettings(found);
    setDraft(draftOf(found));
  }, []);

  const loadMethods = useCallback(() => {
    webFetch(`${webServer}/api/sign-in-methods`)
      .then((answer) => answered<Methods>(answer))
      .then(setMethods)
      .catch(() => {
        setMethods(undefined);
      });
  }, []);

  useEffect(() => {
    webFetch(`${webServer}/api/admin/security`)
      .then((answer) => answered<{ settings: Setting[] }>(answer))
      .then((body) => {
        show(body.settings);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    loadMethods();
  }, [show, loadMethods]);

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (settings === undefined) return;
    setError(undefined);
    setStatus(undefined);
    const changes = changesOf(settings, draft);
    if (typeof changes === "string") {
      setError(changes);
      return;
    }
    if (Object.keys(changes).length === 0) {
      setStatus(t("adminNothingChanged"));
      return;
    }
    setBusy(true);
    webFetch(`${webServer}/api/admin/security`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    })
      .then((answer) => answered<{ settings: Setting[] }>(answer))
      .then((body) => {
        show(body.settings);
        setStatus(t("adminSaved"));
        loadMethods();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const setting = (name: Name) => settings?.find((each) => each.name === name);
  const field = (name: Name) => {
    const found = setting(name);
    return found === undefined ? null : (
      <NumberField
        setting={found}
        draft={draft}
        busy={busy}
        onChange={(value) => {
          setDraft((current) => ({ ...current, [name]: value }));
        }}
      />
    );
  };
  const codes = setting("emailCodes");

  return (
    <section className="admin-section" aria-labelledby="admin-security">
      <h2 id="admin-security">{t("adminSecurity")}</h2>
      {settings === undefined ? (
        error === undefined ? (
          <p role="status">{t("adminOpening")}</p>
        ) : null
      ) : (
        // The page checks each range itself, to say so in an alert in its own words.
        <form className="admin-security" noValidate onSubmit={save}>
          <fieldset>
            <legend>{t("adminSessions")}</legend>
            {field("sessionIdleDays")}
            {field("sessionLifetimeDays")}
            <p className="hint">{t("adminSessionsHint")}</p>
          </fieldset>
          <fieldset>
            <legend>{t("adminSigningIn")}</legend>
            {field("signInTriesAccount")}
            {field("signInTriesAddress")}
            {codes === undefined ? null : (
              <div className="field">
                <label className="field-check">
                  <input
                    type="checkbox"
                    checked={draft.emailCodes === true}
                    disabled={busy || codes.pinnedBy !== null}
                    aria-describedby="hint-emailCodes"
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, emailCodes: event.target.checked }));
                    }}
                  />
                  {t("adminEmailCodes")}
                </label>
                <span id="hint-emailCodes" className="hint">
                  {codes.pinnedBy === null
                    ? t("adminEmailCodesHint")
                    : t("adminPinned", { variable: codes.pinnedBy })}
                </span>
              </div>
            )}
          </fieldset>
          <button type="submit" disabled={busy}>
            {t("adminSave")}
          </button>
        </form>
      )}
      {methods === undefined ? null : (
        <>
          <h3 id="admin-methods">{t("adminMethods")}</h3>
          <ul aria-labelledby="admin-methods">
            {methods.password ? <li>{t("adminMethodPassword")}</li> : null}
            {methods.emailCode ? <li>{t("adminMethodCode")}</li> : null}
            {methods.oidc === null ? null : (
              <li>{t("adminMethodOidc", { name: methods.oidc.name })}</li>
            )}
          </ul>
        </>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

// The Audit log page's destinations (ADR 0081): where the log is sent, by
// syslog over TLS or by a webhook, each with its last delivery, the events
// waiting and its last error; up to five added here, and those the
// server's environment pins, shown with no control. A webhook's secret is
// shown once, as it is made.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { t } from "./messages.ts";
import { webFetch, webServer } from "./web.ts";

interface Destination {
  readonly id: string;
  readonly kind: "syslog" | "webhook";
  readonly name: string;
  readonly address: string;
  readonly ca: boolean;
  readonly fingerprint: string | null;
  readonly pinnedBy: string | null;
  readonly deliveredAt: string | null;
  readonly waiting: number;
  readonly failures: number;
  readonly lastError: string | null;
  readonly failedAt: string | null;
  readonly nextTryAt: string | null;
}

interface Listed {
  readonly destinations: readonly Destination[];
  readonly max: number;
  readonly sealing: boolean;
}

type Trust = "system" | "ca" | "fingerprint";

interface Form {
  readonly kind: "syslog" | "webhook";
  readonly name: string;
  readonly address: string;
  readonly trust: Trust;
  readonly ca: string;
  readonly fingerprint: string;
  readonly from: "newest" | "oldest";
}

const emptyForm: Form = {
  kind: "syslog",
  name: "",
  address: "",
  trust: "system",
  ca: "",
  fingerprint: "",
  from: "newest",
};

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const numbers = new Intl.NumberFormat();

async function json<T>(answer: Promise<Response>): Promise<T> {
  const got = await answer;
  if (!got.ok) {
    let message = got.statusText;
    try {
      const body = (await got.json()) as { readonly message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      // The status says it.
    }
    throw new Error(message);
  }
  return got.status === 204 ? (undefined as T) : ((await got.json()) as T);
}

/**
 * What a form sends: the trust a syslog destination keeps, nothing for a
 * webhook. A change that leaves a certificate authority empty keeps the one
 * set, which the server never sends back.
 */
function bodyOf(form: Form, adding: boolean) {
  const keepsCa = !adding && form.trust === "ca" && form.ca.trim() === "";
  return {
    ...(adding ? { kind: form.kind, from: form.from } : {}),
    name: form.name.trim(),
    address: form.address.trim(),
    ...(form.kind === "syslog" && !keepsCa
      ? {
          ca: form.trust === "ca" ? form.ca : "",
          fingerprint: form.trust === "fingerprint" ? form.fingerprint : "",
        }
      : {}),
  };
}

function DestinationFields(props: {
  readonly form: Form;
  readonly adding: boolean;
  readonly disabled: boolean;
  readonly onChange: (form: Form) => void;
}) {
  const { form, adding, disabled, onChange } = props;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    onChange({ ...form, [key]: value });
  };
  return (
    <>
      {adding ? (
        <label>
          {t("adminAuditSiemKind")}
          <select
            value={form.kind}
            disabled={disabled}
            onChange={(event) => {
              set("kind", event.target.value === "webhook" ? "webhook" : "syslog");
            }}
          >
            <option value="syslog">{t("adminAuditSiemSyslog")}</option>
            <option value="webhook">{t("adminAuditSiemWebhook")}</option>
          </select>
        </label>
      ) : null}
      <label>
        {t("adminAuditSiemName")}
        <input
          value={form.name}
          required
          maxLength={100}
          disabled={disabled}
          onChange={(event) => {
            set("name", event.target.value);
          }}
        />
      </label>
      <label>
        {t("adminAuditSiemAddress")}
        <input
          value={form.address}
          required
          disabled={disabled}
          placeholder={
            form.kind === "syslog" ? "siem.example.org:6514" : "https://siem.example.org/nether"
          }
          onChange={(event) => {
            set("address", event.target.value);
          }}
        />
      </label>
      {form.kind === "syslog" ? (
        <>
          <label>
            {t("adminAuditSiemTrust")}
            <select
              value={form.trust}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value;
                set("trust", value === "ca" || value === "fingerprint" ? value : "system");
              }}
            >
              <option value="system">{t("adminAuditSiemTrustSystem")}</option>
              <option value="ca">{t("adminAuditSiemTrustCa")}</option>
              <option value="fingerprint">{t("adminAuditSiemTrustFingerprint")}</option>
            </select>
          </label>
          {form.trust === "ca" ? (
            <label className="audit-siem-wide">
              {t("adminAuditSiemCa")}
              <textarea
                value={form.ca}
                rows={4}
                required={adding}
                placeholder={adding ? "-----BEGIN CERTIFICATE-----" : t("adminAuditSiemCaKept")}
                disabled={disabled}
                onChange={(event) => {
                  set("ca", event.target.value);
                }}
              />
            </label>
          ) : null}
          {form.trust === "fingerprint" ? (
            <label className="audit-siem-wide">
              {t("adminAuditSiemFingerprint")}
              <input
                value={form.fingerprint}
                required
                disabled={disabled}
                onChange={(event) => {
                  set("fingerprint", event.target.value);
                }}
              />
            </label>
          ) : null}
        </>
      ) : null}
      {adding ? (
        <label>
          {t("adminAuditSiemFrom")}
          <select
            value={form.from}
            disabled={disabled}
            onChange={(event) => {
              set("from", event.target.value === "oldest" ? "oldest" : "newest");
            }}
          >
            <option value="newest">{t("adminAuditSiemFromNewest")}</option>
            <option value="oldest">{t("adminAuditSiemFromOldest")}</option>
          </select>
        </label>
      ) : null}
    </>
  );
}

/** How a destination fares: its last delivery, what waits, and why it fails. */
function stateOf(destination: Destination): string[] {
  const lines = [
    destination.deliveredAt === null
      ? t("adminAuditSiemNever")
      : t("adminAuditSiemDelivered", { when: when.format(new Date(destination.deliveredAt)) }),
    t("adminAuditSiemWaiting", { count: numbers.format(destination.waiting) }),
  ];
  if (destination.failures > 0 && destination.lastError !== null) {
    lines.push(
      t("adminAuditSiemFailing", {
        count: numbers.format(destination.failures),
        error: destination.lastError,
        when: when.format(new Date(destination.nextTryAt ?? Date.now())),
      }),
    );
  }
  return lines;
}

export function AdminAuditSiem() {
  const [listed, setListed] = useState<Listed | undefined>();
  const [form, setForm] = useState<Form>(emptyForm);
  const [editing, setEditing] = useState<{ readonly id: string; readonly form: Form } | null>(null);
  const [secret, setSecret] = useState<{ readonly name: string; readonly value: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const failed = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const load = useCallback(() => {
    json<Listed>(webFetch(`${webServer}/api/audit/destinations`)).then(setListed, failed);
  }, []);

  useEffect(load, [load]);

  const run = (work: Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    work
      .then(() => {
        setStatus(done);
        load();
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
      });
  };

  const add = (event: SyntheticEvent) => {
    event.preventDefault();
    setSecret(null);
    const name = form.name.trim();
    run(
      json<{ secret: string | null }>(
        webFetch(`${webServer}/api/audit/destinations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyOf(form, true)),
        }),
      ).then((made) => {
        if (made.secret !== null) setSecret({ name, value: made.secret });
        setForm(emptyForm);
      }),
      t("adminAuditSiemAdded", { name }),
    );
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (editing === null) return;
    run(
      json(
        webFetch(`${webServer}/api/audit/destinations/${editing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyOf(editing.form, false)),
        }),
      ).then(() => {
        setEditing(null);
      }),
      t("adminAuditSiemChanged", { name: editing.form.name.trim() }),
    );
  };

  const remove = (destination: Destination) => {
    run(
      json(
        webFetch(`${webServer}/api/audit/destinations/${destination.id}`, { method: "DELETE" }),
      ).then(() => {
        setRemoving(undefined);
      }),
      t("adminAuditSiemRemoved", { name: destination.name }),
    );
  };

  const added = listed?.destinations.filter((each) => each.pinnedBy === null).length ?? 0;
  return (
    <section aria-labelledby="audit-siem">
      <h3 id="audit-siem">{t("adminAuditSiem")}</h3>
      <p className="hint">{t("adminAuditSiemIntro")}</p>
      {listed === undefined ? null : listed.destinations.length === 0 ? (
        <p className="hint">{t("adminAuditSiemNone")}</p>
      ) : (
        <ul className="audit-siem">
          {listed.destinations.map((destination) => (
            <li key={destination.id}>
              <p>
                <strong>{destination.name}</strong>{" "}
                {t(
                  destination.kind === "syslog" ? "adminAuditSiemSyslog" : "adminAuditSiemWebhook",
                )}{" "}
                <code>{destination.address}</code>
              </p>
              {stateOf(destination).map((line) => (
                <p key={line} className={destination.failures > 0 ? "audit-reason" : "hint"}>
                  {line}
                </p>
              ))}
              {destination.pinnedBy === null ? (
                editing?.id === destination.id ? (
                  <form className="audit-filters" onSubmit={save}>
                    <DestinationFields
                      form={editing.form}
                      adding={false}
                      disabled={busy}
                      onChange={(changed) => {
                        setEditing({ id: destination.id, form: changed });
                      }}
                    />
                    <button type="submit" className="primary" disabled={busy}>
                      {t("adminAuditSave")}
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setEditing(null);
                      }}
                    >
                      {t("adminAuditSiemCancel")}
                    </button>
                  </form>
                ) : removing === destination.id ? (
                  <p>
                    <span>{t("adminAuditSiemRemoveConfirm", { name: destination.name })}</span>{" "}
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setRemoving(undefined);
                      }}
                    >
                      {t("adminAuditSiemKeep")}
                    </button>{" "}
                    <button
                      type="button"
                      className="quiet danger"
                      disabled={busy}
                      onClick={() => {
                        remove(destination);
                      }}
                    >
                      {t("adminAuditSiemRemove")}
                    </button>
                  </p>
                ) : (
                  <p>
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      aria-label={t("adminAuditSiemChangeLabel", { name: destination.name })}
                      onClick={() => {
                        setEditing({
                          id: destination.id,
                          form: {
                            ...emptyForm,
                            kind: destination.kind,
                            name: destination.name,
                            address: destination.address,
                            trust:
                              destination.fingerprint !== null
                                ? "fingerprint"
                                : destination.ca
                                  ? "ca"
                                  : "system",
                            fingerprint: destination.fingerprint ?? "",
                          },
                        });
                      }}
                    >
                      {t("adminAuditSiemChange")}
                    </button>{" "}
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      aria-label={t("adminAuditSiemRemoveLabel", { name: destination.name })}
                      onClick={() => {
                        setRemoving(destination.id);
                      }}
                    >
                      {t("adminAuditSiemRemove")}
                    </button>
                  </p>
                )
              ) : (
                <p className="hint">
                  {t("adminAuditSiemPinned", { variable: destination.pinnedBy })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {secret === null ? null : (
        <div className="audit-siem-secret" role="status">
          <p>{t("adminAuditSiemSecret", { name: secret.name })}</p>
          <code>{secret.value}</code>
        </div>
      )}
      {listed === undefined || added >= listed.max ? null : (
        <form className="audit-filters" onSubmit={add} aria-label={t("adminAuditSiemAdd")}>
          <DestinationFields form={form} adding disabled={busy} onChange={setForm} />
          <button
            type="submit"
            className="primary"
            disabled={busy || (form.kind === "webhook" && !listed.sealing)}
          >
            {t("adminAuditSiemAdd")}
          </button>
          {form.kind === "webhook" && !listed.sealing ? (
            <p className="hint">{t("adminAuditSiemNoKey")}</p>
          ) : null}
        </form>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

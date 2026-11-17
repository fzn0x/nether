// The admin console's Audit log (ADR 0081), while the `audit` feature is on:
// the server's events, newest first, found by who by email or account, by
// kind, workspace, outcome and time, 50 at a time; how long the log keeps
// them; and a check of its chain. Only IDs and names, never contents.
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { type MessageKey, t } from "./messages.ts";
import { webFetch, webServer } from "./web.ts";

const groups = ["signIns", "permissions", "shares", "exports", "deletions", "log"] as const;
type Group = (typeof groups)[number];

interface AuditEvent {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly outcome: "success" | "failure";
  readonly reason: string | null;
  readonly actor: {
    readonly type: "account" | "visitor" | "anonymous" | "system";
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
    readonly token: { readonly id: string; readonly name: string | null } | null;
  };
  readonly workspace: { readonly id: string; readonly name: string | null } | null;
  readonly target: {
    readonly type: string;
    readonly id: string | null;
    readonly name: string | null;
  } | null;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

interface Settings {
  readonly retentionDays: number;
  readonly pinned: boolean;
  readonly keyed: boolean;
  readonly events: number;
}

interface CheckResult {
  readonly checked: number;
  readonly broken: { readonly seq: number; readonly problem: string } | null;
}

interface Filters {
  readonly email: string;
  readonly group: Group | "";
  readonly workspace: string;
  readonly outcome: "" | "success" | "failure";
  readonly from: string;
  readonly to: string;
  /** An account's or a link's ID, chosen from an event. */
  readonly actor: { readonly id: string; readonly name: string } | null;
}

const noFilters: Filters = {
  email: "",
  group: "",
  workspace: "",
  outcome: "",
  from: "",
  to: "",
  actor: null,
};

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const numbers = new Intl.NumberFormat();

async function messageOf(answer: Response): Promise<string> {
  try {
    const body = (await answer.json()) as { readonly message?: unknown };
    return typeof body.message === "string" ? body.message : answer.statusText;
  } catch {
    return answer.statusText;
  }
}

async function json<T>(answer: Promise<Response>): Promise<T> {
  const got = await answer;
  if (!got.ok) throw new Error(await messageOf(got));
  return (await got.json()) as T;
}

/** The search's query: the filters set, and where the page starts. */
function queryOf(filters: Filters, before: number | null): string {
  const query = new URLSearchParams();
  if (filters.email.trim() !== "") query.set("email", filters.email.trim());
  if (filters.group !== "") query.set("group", filters.group);
  if (filters.workspace !== "") query.set("workspace", filters.workspace);
  if (filters.outcome !== "") query.set("outcome", filters.outcome);
  // A day from its start, to the end of the last day asked for.
  if (filters.from !== "") query.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to !== "") {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.set("to", end.toISOString());
  }
  if (filters.actor !== null) query.set("actor", filters.actor.id);
  if (before !== null) query.set("before", String(before));
  return query.toString();
}

/** Who did it, as the log names them. */
function whoOf(event: AuditEvent): string {
  const { actor } = event;
  if (actor.type === "system") return t("adminAuditSystem");
  if (actor.type === "visitor") return actor.name ?? t("adminAuditVisitor");
  if (actor.type === "anonymous") return actor.email ?? t("adminAuditAnonymous");
  const name = actor.name ?? actor.id ?? "";
  return actor.email === null ? name : `${name} <${actor.email}>`;
}

function EventRow(props: {
  readonly event: AuditEvent;
  readonly onOnly: (actor: { readonly id: string; readonly name: string }) => void;
}) {
  const { event, onOnly } = props;
  const { actor, target } = event;
  const who = whoOf(event);
  return (
    <tr className={event.outcome === "failure" ? "audit-failure" : undefined}>
      <td>
        <time dateTime={event.at}>{when.format(new Date(event.at))}</time>
      </td>
      <td>
        {who}
        {actor.token === null ? null : (
          <span className="hint">
            {" "}
            {t("adminAuditVia", { token: actor.token.name ?? actor.token.id })}
          </span>
        )}
        {actor.id === null ? null : (
          <button
            type="button"
            className="quiet"
            aria-label={t("adminAuditOnlyLabel", { name: who })}
            onClick={() => {
              onOnly({ id: actor.id ?? "", name: who });
            }}
          >
            {t("adminAuditOnlyThem")}
          </button>
        )}
      </td>
      <td>
        <code>{event.action}</code>
        {target === null ? null : <span> {target.name ?? target.id}</span>}
        {event.outcome === "failure" ? (
          <p className="audit-reason">
            {t("adminAuditFailedBecause", { reason: event.reason ?? "" })}
          </p>
        ) : null}
        <details>
          <summary>{t("adminAuditDetails")}</summary>
          <dl className="admin-usage">
            {event.address === null ? null : (
              <div>
                <dt>{t("adminAuditAddress")}</dt>
                <dd>{event.address}</dd>
              </div>
            )}
            {event.userAgent === null ? null : (
              <div>
                <dt>{t("adminAuditClient")}</dt>
                <dd>{event.userAgent}</dd>
              </div>
            )}
            {target === null ? null : (
              <div>
                <dt>{t("adminAuditTarget")}</dt>
                <dd>
                  {target.type} {target.id}
                </dd>
              </div>
            )}
            {Object.entries(event.details).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
            <div>
              <dt>{t("adminAuditEvent")}</dt>
              <dd>
                {numbers.format(event.seq)} {event.id}
              </dd>
            </div>
          </dl>
        </details>
      </td>
      <td>{event.workspace?.name ?? event.workspace?.id ?? ""}</td>
    </tr>
  );
}

export function AdminAudit() {
  const [form, setForm] = useState<Filters>(noFilters);
  const [shown, setShown] = useState<Filters>(noFilters);
  const [events, setEvents] = useState<readonly AuditEvent[] | undefined>();
  const [next, setNext] = useState<number | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly { id: string; name: string }[]>([]);
  const [settings, setSettings] = useState<Settings | undefined>();
  const [days, setDays] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const failed = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  /** A page of events for the filters, the first, or the next after those shown. */
  const search = useCallback((filters: Filters, before: number | null) => {
    setError(undefined);
    if (before === null) setEvents(undefined);
    json<{ events: AuditEvent[]; next: number | null }>(
      webFetch(`${webServer}/api/audit/events?${queryOf(filters, before)}`),
    )
      .then((page) => {
        setShown(filters);
        setEvents((current) =>
          before === null ? page.events : [...(current ?? []), ...page.events],
        );
        setNext(page.next);
      })
      .catch(failed);
  }, []);

  const loadSettings = useCallback(() => {
    json<Settings>(webFetch(`${webServer}/api/audit/settings`))
      .then((read) => {
        setSettings(read);
        setDays(String(read.retentionDays));
      })
      .catch(failed);
  }, []);

  useEffect(() => {
    search(noFilters, null);
    loadSettings();
    json<{ workspaces: { id: string; name: string }[] }>(
      webFetch(`${webServer}/api/audit/workspaces`),
    )
      .then((read) => {
        setWorkspaces(read.workspaces);
      })
      .catch(failed);
  }, [search, loadSettings]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    search(form, null);
  };

  const only = (actor: Filters["actor"]) => {
    const filters = { ...form, actor };
    setForm(filters);
    search(filters, null);
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(undefined);
    json<{ retentionDays: number }>(
      webFetch(`${webServer}/api/audit/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retentionDays: Number(days) }),
      }),
    )
      .then((saved) => {
        setStatus(t("adminAuditSaved", { days: numbers.format(saved.retentionDays) }));
        loadSettings();
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
      });
  };

  const check = () => {
    setBusy(true);
    setStatus(t("adminAuditChecking"));
    json<CheckResult>(webFetch(`${webServer}/api/audit/check`, { method: "POST" }))
      .then((result) => {
        setStatus(
          result.broken === null
            ? t("adminAuditHolds", { count: numbers.format(result.checked) })
            : t("adminAuditBroken", {
                seq: numbers.format(result.broken.seq),
                problem: result.broken.problem,
              }),
        );
        // The check is an event of its own.
        search(shown, null);
        loadSettings();
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
      });
  };

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="admin-section" aria-labelledby="admin-audit">
      <h2 id="admin-audit">{t("adminAudit")}</h2>
      <p className="hint">{t("adminAuditIntro")}</p>
      <form className="audit-filters" aria-label={t("adminAuditFilters")} onSubmit={submit}>
        <label>
          {t("adminAuditEmail")}
          <input
            type="search"
            value={form.email}
            onChange={(event) => {
              set("email", event.target.value);
            }}
          />
        </label>
        <label>
          {t("adminAuditGroup")}
          <select
            value={form.group}
            onChange={(event) => {
              set("group", event.target.value as Group | "");
            }}
          >
            <option value="">{t("adminAuditGroupAll")}</option>
            {groups.map((group) => (
              <option key={group} value={group}>
                {t(`adminAuditGroup_${group}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("adminAuditWorkspace")}
          <select
            value={form.workspace}
            onChange={(event) => {
              set("workspace", event.target.value);
            }}
          >
            <option value="">{t("adminAuditAnyWorkspace")}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("adminAuditOutcome")}
          <select
            value={form.outcome}
            onChange={(event) => {
              set("outcome", event.target.value as Filters["outcome"]);
            }}
          >
            <option value="">{t("adminAuditAnyOutcome")}</option>
            <option value="success">{t("adminAuditSucceeded")}</option>
            <option value="failure">{t("adminAuditFailed")}</option>
          </select>
        </label>
        <label>
          {t("adminAuditFrom")}
          <input
            type="date"
            value={form.from}
            onChange={(event) => {
              set("from", event.target.value);
            }}
          />
        </label>
        <label>
          {t("adminAuditTo")}
          <input
            type="date"
            value={form.to}
            onChange={(event) => {
              set("to", event.target.value);
            }}
          />
        </label>
        <button type="submit" className="primary">
          {t("adminAuditSearch")}
        </button>
      </form>
      {form.actor === null ? null : (
        <p className="audit-only">
          {t("adminAuditOnly", { name: form.actor.name })}{" "}
          <button
            type="button"
            className="quiet"
            onClick={() => {
              only(null);
            }}
          >
            {t("adminAuditOnlyClear")}
          </button>
        </p>
      )}
      {events === undefined ? (
        <p role="status">{t("adminAuditSearching")}</p>
      ) : events.length === 0 ? (
        <p className="hint">{t("adminAuditNone")}</p>
      ) : (
        <div className="audit-table">
          <table>
            <caption className="visually-hidden">{t("adminAudit")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("adminAuditWhen")}</th>
                <th scope="col">{t("adminAuditWho")}</th>
                <th scope="col">{t("adminAuditWhat")}</th>
                <th scope="col">{t("adminAuditWhere")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} onOnly={only} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next === null ? null : (
        <button
          type="button"
          className="quiet"
          onClick={() => {
            search(shown, next);
          }}
        >
          {t("adminAuditOlder")}
        </button>
      )}
      <h3>{t("adminAuditKeeping")}</h3>
      {settings === undefined ? null : (
        <>
          <p className="hint">
            {t("adminAuditCount", { count: numbers.format(settings.events) })}{" "}
            {t(settings.keyed ? "adminAuditKeyed" : "adminAuditNotKeyed")}
          </p>
          <form className="audit-filters" onSubmit={save}>
            <label>
              {t("adminAuditKeep")}
              <input
                type="number"
                min={30}
                max={3650}
                value={days}
                disabled={settings.pinned || busy}
                aria-describedby={settings.pinned ? "audit-pinned" : undefined}
                onChange={(event) => {
                  setDays(event.target.value);
                }}
              />
              {t("adminAuditDays")}
            </label>
            <button type="submit" className="quiet" disabled={settings.pinned || busy}>
              {t("adminAuditSave")}
            </button>
          </form>
          {settings.pinned ? (
            <p className="hint" id="audit-pinned">
              {t("adminAuditPinned")}
            </p>
          ) : null}
          <button type="button" className="quiet" disabled={busy} onClick={check}>
            {t("adminAuditCheck")}
          </button>
        </>
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

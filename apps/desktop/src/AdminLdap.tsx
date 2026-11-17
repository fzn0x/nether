// An LDAP directory on the console's Directories page (ADR 0085): the form
// part with its address, certificate, bind DN and password, where its
// people and groups are and how they read, started from a preset; and,
// once added, Test the connection, Sync now, the first run's preview to
// apply, a run held back to run anyway, and how the last run went.
import { useState } from "react";
import { t } from "./messages.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

/** Where a group's members are read. */
const memberships = ["memberOf", "member", "uniqueMember", "memberUid"] as const;

/** How often a directory runs, in minutes. */
const schedules = [15, 30, 60, 120, 240, 480, 720, 1440] as const;

/** An LDAP directory's settings as the server shows and takes them. */
export interface LdapSettingsView {
  readonly url: string;
  readonly ca: string | null;
  readonly fingerprint: string | null;
  readonly bindDn: string;
  readonly peopleBase: string;
  readonly peopleFilter: string;
  readonly groupsBase: string;
  readonly groupsFilter: string;
  readonly idAttribute: string;
  readonly idIsGuid: boolean;
  readonly userNameAttribute: string;
  readonly emailAttribute: string;
  readonly nameAttributes: readonly string[];
  readonly groupNameAttribute: string;
  readonly membership: string;
  readonly everyMinutes: number;
  readonly holdPercent: number;
}

interface Named {
  readonly name: string;
  readonly email: string;
}

/** How a run went, as the server keeps it. */
export interface RunView {
  readonly outcome: "applied" | "preview" | "held" | "failed";
  readonly at: string;
  readonly seconds: number;
  readonly counts: Readonly<Record<string, number>> | null;
  readonly failure: string | null;
  readonly skipped: readonly { readonly dn: string; readonly reason: string }[];
  readonly preview: {
    readonly made: readonly Named[];
    readonly changed: readonly Named[];
    readonly reactivated: readonly Named[];
    readonly deactivated: readonly Named[];
    readonly groupsMade: readonly string[];
    readonly groupsRemoved: readonly string[];
  } | null;
}

/** An LDAP directory's settings and runs, as the page shows them. */
export interface LdapView extends LdapSettingsView {
  readonly passwordSet: boolean;
  readonly running: boolean;
  readonly confirmed: boolean;
  readonly nextAt: string | null;
  readonly last: RunView | null;
}

export type LdapPresets = Readonly<Record<string, Partial<LdapSettingsView>>>;

/** The form's fields, as typed. */
export interface LdapForm {
  readonly url: string;
  readonly trust: "system" | "ca" | "fingerprint";
  readonly ca: string;
  readonly fingerprint: string;
  readonly bindDn: string;
  readonly password: string;
  readonly peopleBase: string;
  readonly peopleFilter: string;
  readonly groupsBase: string;
  readonly groupsFilter: string;
  readonly idAttribute: string;
  readonly idIsGuid: boolean;
  readonly userNameAttribute: string;
  readonly emailAttribute: string;
  readonly nameAttributes: string;
  readonly groupNameAttribute: string;
  readonly membership: string;
  readonly everyMinutes: number;
  readonly holdPercent: number;
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The form for a directory kept, or a new one from OpenLDAP's preset. */
export function ldapForm(kept: LdapView | null, presets: LdapPresets): LdapForm {
  const start: Partial<LdapSettingsView> = kept ?? presets.openLdap ?? {};
  return {
    url: kept?.url ?? "",
    trust:
      kept?.fingerprint !== null && kept?.fingerprint !== undefined
        ? "fingerprint"
        : kept?.ca !== null && kept?.ca !== undefined
          ? "ca"
          : "system",
    ca: kept?.ca ?? "",
    fingerprint: kept?.fingerprint ?? "",
    bindDn: kept?.bindDn ?? "",
    password: "",
    peopleBase: kept?.peopleBase ?? "",
    peopleFilter: start.peopleFilter ?? "",
    groupsBase: kept?.groupsBase ?? "",
    groupsFilter: start.groupsFilter ?? "",
    idAttribute: start.idAttribute ?? "",
    idIsGuid: start.idIsGuid ?? false,
    userNameAttribute: start.userNameAttribute ?? "",
    emailAttribute: start.emailAttribute ?? "",
    nameAttributes: (start.nameAttributes ?? []).join(", "),
    groupNameAttribute: start.groupNameAttribute ?? "",
    membership: start.membership ?? "memberOf",
    everyMinutes: kept?.everyMinutes ?? 60,
    holdPercent: kept?.holdPercent ?? 10,
  };
}

/** What the server takes of the form: the password only when typed. */
export function ldapBody(form: LdapForm): Record<string, unknown> {
  return {
    url: form.url.trim(),
    ca: form.trust === "ca" ? form.ca : null,
    fingerprint: form.trust === "fingerprint" ? form.fingerprint : null,
    bindDn: form.bindDn.trim(),
    ...(form.password === "" ? {} : { password: form.password }),
    peopleBase: form.peopleBase.trim(),
    peopleFilter: form.peopleFilter.trim(),
    groupsBase: form.groupsBase.trim(),
    groupsFilter: form.groupsFilter.trim(),
    idAttribute: form.idAttribute.trim(),
    idIsGuid: form.idIsGuid,
    userNameAttribute: form.userNameAttribute.trim(),
    emailAttribute: form.emailAttribute.trim(),
    nameAttributes: form.nameAttributes
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    groupNameAttribute: form.groupNameAttribute.trim(),
    membership: form.membership,
    everyMinutes: form.everyMinutes,
    holdPercent: form.holdPercent,
  };
}

function membershipName(membership: string): string {
  switch (membership) {
    case "member":
      return t("adminLdapMembershipMember");
    case "uniqueMember":
      return t("adminLdapMembershipUniqueMember");
    case "memberUid":
      return t("adminLdapMembershipMemberUid");
    default:
      return t("adminLdapMembershipMemberOf");
  }
}

function scheduleName(minutes: number): string {
  if (minutes % 1440 === 0) return t("adminLdapEveryDay");
  if (minutes % 60 === 0) return t("adminLdapEveryHours", { hours: minutes / 60 });
  return t("adminLdapEveryMinutes", { minutes });
}

/** A text field with its hint, as the form lays each out. */
function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly type?: string;
  readonly autoComplete?: string;
  readonly onChange: (value: string) => void;
}) {
  const { id, label, value, hint, required, type, autoComplete, onChange } = props;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type ?? "text"}
        value={value}
        required={required ?? false}
        spellCheck={false}
        autoComplete={autoComplete ?? "off"}
        {...(hint === undefined ? {} : { "aria-describedby": `${id}-hint` })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint === undefined ? null : (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** The LDAP part of a directory's form. */
export function LdapFields(props: {
  readonly prefix: string;
  readonly form: LdapForm;
  readonly editing: boolean;
  readonly presets: LdapPresets;
  readonly onChange: (form: LdapForm) => void;
}) {
  const { prefix, form, editing, presets, onChange } = props;
  const set =
    <K extends keyof LdapForm>(key: K) =>
    (value: LdapForm[K]) => {
      onChange({ ...form, [key]: value });
    };
  const fill = (name: string) => {
    const preset = presets[name];
    if (preset === undefined) return;
    onChange({
      ...form,
      peopleFilter: preset.peopleFilter ?? form.peopleFilter,
      groupsFilter: preset.groupsFilter ?? form.groupsFilter,
      idAttribute: preset.idAttribute ?? form.idAttribute,
      idIsGuid: preset.idIsGuid ?? form.idIsGuid,
      userNameAttribute: preset.userNameAttribute ?? form.userNameAttribute,
      emailAttribute: preset.emailAttribute ?? form.emailAttribute,
      nameAttributes: (preset.nameAttributes ?? []).join(", ") || form.nameAttributes,
      groupNameAttribute: preset.groupNameAttribute ?? form.groupNameAttribute,
      membership: preset.membership ?? form.membership,
    });
  };
  return (
    <>
      <div className="admin-ldap-presets" role="group" aria-label={t("adminLdapPresets")}>
        <span>{t("adminLdapPresets")}</span>
        <button
          type="button"
          onClick={() => {
            fill("activeDirectory");
          }}
        >
          {t("adminLdapActiveDirectory")}
        </button>
        <button
          type="button"
          onClick={() => {
            fill("openLdap");
          }}
        >
          {t("adminLdapOpenLdap")}
        </button>
      </div>
      <fieldset>
        <legend>{t("adminLdapReaching")}</legend>
        <Field
          id={`${prefix}-url`}
          label={t("adminLdapUrl")}
          value={form.url}
          required
          hint={t("adminLdapUrlHint")}
          onChange={set("url")}
        />
        <fieldset className="admin-ldap-trust">
          <legend>{t("adminLdapTrust")}</legend>
          {(["system", "ca", "fingerprint"] as const).map((trust) => (
            <label className="field-check" key={trust}>
              <input
                type="radio"
                name={`${prefix}-trust`}
                checked={form.trust === trust}
                onChange={() => {
                  set("trust")(trust);
                }}
              />
              {t(
                trust === "system"
                  ? "adminLdapTrustSystem"
                  : trust === "ca"
                    ? "adminLdapTrustCa"
                    : "adminLdapTrustFingerprint",
              )}
            </label>
          ))}
        </fieldset>
        {form.trust === "ca" ? (
          <div className="field">
            <label htmlFor={`${prefix}-ca`}>{t("adminLdapCa")}</label>
            <textarea
              id={`${prefix}-ca`}
              rows={4}
              required
              spellCheck={false}
              className="admin-directory-value"
              value={form.ca}
              onChange={(event) => {
                set("ca")(event.target.value);
              }}
            />
          </div>
        ) : null}
        {form.trust === "fingerprint" ? (
          <Field
            id={`${prefix}-fingerprint`}
            label={t("adminLdapFingerprint")}
            value={form.fingerprint}
            required
            hint={t("adminLdapFingerprintHint")}
            onChange={set("fingerprint")}
          />
        ) : null}
        <Field
          id={`${prefix}-bind`}
          label={t("adminLdapBindDn")}
          value={form.bindDn}
          required
          onChange={set("bindDn")}
        />
        <Field
          id={`${prefix}-password`}
          label={t("adminLdapPassword")}
          type="password"
          autoComplete="new-password"
          value={form.password}
          required={!editing}
          hint={t(editing ? "adminLdapPasswordKept" : "adminLdapPasswordHint")}
          onChange={set("password")}
        />
      </fieldset>
      <fieldset>
        <legend>{t("adminLdapReading")}</legend>
        <Field
          id={`${prefix}-people-base`}
          label={t("adminLdapPeopleBase")}
          value={form.peopleBase}
          required
          onChange={set("peopleBase")}
        />
        <Field
          id={`${prefix}-people-filter`}
          label={t("adminLdapPeopleFilter")}
          value={form.peopleFilter}
          required
          onChange={set("peopleFilter")}
        />
        <Field
          id={`${prefix}-groups-base`}
          label={t("adminLdapGroupsBase")}
          value={form.groupsBase}
          required
          onChange={set("groupsBase")}
        />
        <Field
          id={`${prefix}-groups-filter`}
          label={t("adminLdapGroupsFilter")}
          value={form.groupsFilter}
          required
          hint={t("adminLdapGroupsFilterHint")}
          onChange={set("groupsFilter")}
        />
        <Field
          id={`${prefix}-id-attribute`}
          label={t("adminLdapIdAttribute")}
          value={form.idAttribute}
          required
          hint={t("adminLdapIdAttributeHint")}
          onChange={set("idAttribute")}
        />
        <label className="field-check">
          <input
            type="checkbox"
            checked={form.idIsGuid}
            onChange={(event) => {
              set("idIsGuid")(event.target.checked);
            }}
          />
          {t("adminLdapIdIsGuid")}
        </label>
        <Field
          id={`${prefix}-user-name`}
          label={t("adminLdapUserName")}
          value={form.userNameAttribute}
          required
          onChange={set("userNameAttribute")}
        />
        <Field
          id={`${prefix}-email`}
          label={t("adminLdapEmail")}
          value={form.emailAttribute}
          required
          onChange={set("emailAttribute")}
        />
        <Field
          id={`${prefix}-names`}
          label={t("adminLdapNames")}
          value={form.nameAttributes}
          required
          hint={t("adminLdapNamesHint")}
          onChange={set("nameAttributes")}
        />
        <Field
          id={`${prefix}-group-name`}
          label={t("adminLdapGroupName")}
          value={form.groupNameAttribute}
          required
          onChange={set("groupNameAttribute")}
        />
        <label className="field">
          {t("adminLdapMembership")}
          <select
            value={form.membership}
            onChange={(event) => {
              set("membership")(event.target.value);
            }}
          >
            {memberships.map((each) => (
              <option key={each} value={each}>
                {membershipName(each)}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t("adminLdapRunning")}</legend>
        <label className="field">
          {t("adminLdapEvery")}
          <select
            value={form.everyMinutes}
            onChange={(event) => {
              set("everyMinutes")(Number(event.target.value));
            }}
          >
            {schedules.map((minutes) => (
              <option key={minutes} value={minutes}>
                {scheduleName(minutes)}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <label htmlFor={`${prefix}-hold`}>{t("adminLdapHold")}</label>
          <input
            id={`${prefix}-hold`}
            type="number"
            min={1}
            max={100}
            required
            value={form.holdPercent}
            aria-describedby={`${prefix}-hold-hint`}
            onChange={(event) => {
              set("holdPercent")(Number(event.target.value));
            }}
          />
          <p className="hint" id={`${prefix}-hold-hint`}>
            {t("adminLdapHoldHint")}
          </p>
        </div>
      </fieldset>
    </>
  );
}

async function post(path: string, body?: unknown): Promise<Response> {
  const answer = await webFetch(`${webServer}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!answer.ok) throw new Error(await messageOf(answer));
  return answer;
}

interface Sample {
  readonly people: readonly {
    readonly dn: string;
    readonly userName: string | null;
    readonly email: string | null;
    readonly name: string | null;
  }[];
  readonly groups: readonly { readonly dn: string; readonly name: string | null }[];
}

/** What the last run did, or would do, in a line. */
function runText(run: RunView): string {
  const counts = run.counts ?? {};
  const count = (key: string) => counts[key] ?? 0;
  const at = when.format(new Date(run.at));
  switch (run.outcome) {
    case "failed":
      return t("adminLdapRunFailed", { at, failure: run.failure ?? "" });
    case "held":
      return t("adminLdapRunHeld", { at, deactivated: count("deactivated") });
    case "preview":
      return t("adminLdapRunPreview", {
        at,
        people: count("people"),
        made: count("made"),
        changed: count("changed") + count("reactivated"),
        deactivated: count("deactivated"),
        groups: count("groupsMade"),
      });
    default:
      return t("adminLdapRunApplied", {
        at,
        seconds: run.seconds,
        made: count("made") + count("linked"),
        changed: count("changed") + count("reactivated"),
        deactivated: count("deactivated"),
        skipped: count("skipped"),
      });
  }
}

/** A list of people a run makes or deactivates, shown when opened. */
function PeopleList(props: { readonly label: string; readonly people: readonly Named[] }) {
  const { label, people } = props;
  if (people.length === 0) return null;
  return (
    <details>
      <summary>{label}</summary>
      <ul className="admin-ldap-list">
        {people.map((each) => (
          <li key={each.email}>
            {each.name} <span className="hint">{each.email}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * An LDAP directory's runs: Test the connection, Sync now, the last run,
 * and what it asks of an instance admin, a preview to apply or a run held
 * back to run anyway.
 */
export function LdapRuns(props: {
  readonly id: string;
  readonly name: string;
  readonly ldap: LdapView;
  readonly onChanged: () => Promise<void>;
}) {
  const { id, name, ldap, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState<Sample | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const last = ldap.last;

  const act = (work: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    work()
      .then(async (done) => {
        await onChanged();
        setStatus(done);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const run = (body: Record<string, boolean>, done: string) => {
    act(async () => {
      await post(`/api/admin/directories/${id}/sync`, body);
      return done;
    });
  };

  return (
    <div className="admin-ldap-runs">
      <dl className="admin-usage">
        <div>
          <dt>{t("adminLdapLastRun")}</dt>
          <dd>{last === null ? t("adminLdapNoRun") : runText(last)}</dd>
        </div>
        <div>
          <dt>{t("adminLdapNextRun")}</dt>
          <dd>
            {ldap.running
              ? t("adminLdapRunOn")
              : ldap.nextAt === null
                ? t("adminLdapNotYet")
                : t("adminLdapNextAt", {
                    at: when.format(new Date(ldap.nextAt)),
                    every: scheduleName(ldap.everyMinutes),
                  })}
          </dd>
        </div>
      </dl>
      {last?.preview === null || last?.preview === undefined ? null : (
        <>
          <PeopleList label={t("adminLdapWouldMake")} people={last.preview.made} />
          <PeopleList label={t("adminLdapWouldDeactivate")} people={last.preview.deactivated} />
        </>
      )}
      {last === null || last.skipped.length === 0 ? null : (
        <details>
          <summary>
            {t("adminLdapSkipped", { count: last.counts?.skipped ?? last.skipped.length })}
          </summary>
          <ul className="admin-ldap-list">
            {last.skipped.map((each) => (
              <li key={each.dn}>
                <span className="admin-directory-value">{each.dn}</span>: {each.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {sample === undefined ? null : (
        <div role="region" aria-label={t("adminLdapSample")}>
          <p>
            {t("adminLdapSampleRead", {
              people: sample.people.length,
              groups: sample.groups.length,
            })}
          </p>
          <ul className="admin-ldap-list">
            {sample.people.map((each) => (
              <li key={each.dn}>
                {each.name ?? each.userName ?? each.dn}{" "}
                <span className="hint">{each.email ?? t("adminLdapNoAddress")}</span>
              </li>
            ))}
            {sample.groups.map((each) => (
              <li key={each.dn}>{t("adminLdapSampleGroup", { name: each.name ?? each.dn })}</li>
            ))}
          </ul>
        </div>
      )}
      {last?.outcome === "held" ? <p role="alert">{t("adminLdapHeldAlert")}</p> : null}
      <div className="dialog-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            act(async () => {
              const answer = await post(`/api/admin/directories/${id}/test`);
              setSample((await answer.json()) as Sample);
              return t("adminLdapTested", { name });
            });
          }}
        >
          {t("adminLdapTest")}
        </button>
        <button
          type="button"
          disabled={busy || ldap.running}
          onClick={() => {
            run({}, t(ldap.confirmed ? "adminLdapSyncing" : "adminLdapPreviewing", { name }));
          }}
        >
          {t(ldap.confirmed ? "adminLdapSyncNow" : "adminLdapPreview")}
        </button>
        {!ldap.confirmed && last?.outcome === "preview" ? (
          <button
            type="button"
            className="primary"
            disabled={busy || ldap.running}
            onClick={() => {
              run({ confirm: true }, t("adminLdapApplying", { name }));
            }}
          >
            {t("adminLdapApply")}
          </button>
        ) : null}
        {last?.outcome === "held" ? (
          <button
            type="button"
            className="danger"
            disabled={busy || ldap.running}
            onClick={() => {
              run({ anyway: true }, t("adminLdapApplying", { name }));
            }}
          >
            {t("adminLdapRunAnyway")}
          </button>
        ) : null}
      </div>
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </div>
  );
}

// The admin console's Workspaces page (ADR 0083): every workspace on the
// server, a page at a time, found by its name or a member's; and one opened
// to its members, whose roles an instance admin sets, keeping an owner. An
// account a directory deactivated is marked (ADR 0085).
import { useCallback, useEffect, useState } from "react";
import { t } from "./messages.ts";
import { roleName } from "./server.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

interface Owner {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly deactivated: boolean;
}

interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly encryption: "none" | "end-to-end";
  readonly owners: readonly Owner[];
  /** Its owners whose accounts are not deactivated. */
  readonly activeOwners: number;
  readonly roles: {
    readonly owner: number;
    readonly admin: number;
    readonly member: number;
    readonly guest: number;
  };
  readonly notes: number | null;
  readonly bytes: {
    readonly documents: number;
    readonly history: number;
    readonly attachments: number;
  };
  readonly changedAt: string | null;
}

interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly joinedAt: string;
  readonly deactivated: boolean;
}

interface Page {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly next: string | null;
}

interface Opened {
  readonly workspace: WorkspaceSummary;
  readonly members: readonly Member[];
}

const roles = ["owner", "admin", "member", "guest"] as const;
const numbers = new Intl.NumberFormat();
const megabytes = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "megabyte",
  maximumFractionDigits: 1,
});
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function size(bytes: number): string {
  return megabytes.format(bytes / 1_000_000);
}

function total(workspace: WorkspaceSummary): number {
  const { owner, admin, member, guest } = workspace.roles;
  return owner + admin + member + guest;
}

async function answered<T>(answer: Response): Promise<T> {
  if (!answer.ok) throw new Error(await messageOf(answer));
  return (await answer.json()) as T;
}

function page(search: string, ownerless: boolean, after?: string): Promise<Page> {
  const query = new URLSearchParams();
  if (search !== "") query.set("search", search);
  if (ownerless) query.set("ownerless", "true");
  if (after !== undefined) query.set("after", after);
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
  return webFetch(`${webServer}/api/admin/workspaces${suffix}`).then((answer) =>
    answered<Page>(answer),
  );
}

function opening(id: string): Promise<Opened> {
  return webFetch(`${webServer}/api/admin/workspaces/${id}`).then((answer) =>
    answered<Opened>(answer),
  );
}

function List(props: {
  readonly list: { readonly workspaces: readonly WorkspaceSummary[] } | undefined;
  readonly onOpen: (id: string) => void;
}) {
  const { list, onOpen } = props;
  if (list === undefined) return <p role="status">{t("adminCounting")}</p>;
  if (list.workspaces.length === 0) return <p>{t("adminNoWorkspaces")}</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table" aria-labelledby="admin-workspaces">
        <thead>
          <tr>
            <th scope="col">{t("adminColumnWorkspace")}</th>
            <th scope="col">{t("adminColumnOwners")}</th>
            <th scope="col">{t("adminColumnMembers")}</th>
            <th scope="col">{t("adminColumnNotes")}</th>
            <th scope="col">{t("adminColumnSize")}</th>
            <th scope="col">{t("adminColumnChanged")}</th>
          </tr>
        </thead>
        <tbody>
          {list.workspaces.map((workspace) => (
            <tr key={workspace.id}>
              <th scope="row">
                <button
                  type="button"
                  className="admin-open"
                  onClick={() => {
                    onOpen(workspace.id);
                  }}
                >
                  {workspace.name}
                </button>
                {workspace.encryption === "end-to-end" ? (
                  <span className="hint admin-tag">{t("adminEncryptedTag")}</span>
                ) : null}
                {workspace.activeOwners === 0 ? (
                  <span className="admin-tag admin-ownerless">{t("adminNoActiveOwner")}</span>
                ) : null}
              </th>
              <td>
                {workspace.owners.length === 0
                  ? t("adminNoOwner")
                  : workspace.owners
                      .map((owner) =>
                        owner.deactivated
                          ? t("accountDeactivatedName", { name: owner.name })
                          : owner.name,
                      )
                      .join(", ")}
              </td>
              <td>{numbers.format(total(workspace))}</td>
              <td>
                {workspace.notes === null ? t("adminEncrypted") : numbers.format(workspace.notes)}
              </td>
              <td>
                {size(
                  workspace.bytes.documents + workspace.bytes.history + workspace.bytes.attachments,
                )}
              </td>
              <td>
                {workspace.changedAt === null
                  ? t("adminNever")
                  : day.format(new Date(workspace.changedAt))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Members(props: {
  readonly opened: Opened;
  readonly busy: boolean;
  readonly onRole: (member: Member, role: string) => void;
  readonly onBack: () => void;
}) {
  const { opened, busy, onRole, onBack } = props;
  const { workspace } = opened;
  return (
    <div className="admin-workspace">
      <button type="button" className="quiet" onClick={onBack}>
        {t("adminAllWorkspaces")}
      </button>
      <h3 id="admin-members">{t("adminMembersOf", { workspace: workspace.name })}</h3>
      <p className="hint">
        {t("adminSizeParts", {
          documents: size(workspace.bytes.documents),
          history: size(workspace.bytes.history),
          attachments: size(workspace.bytes.attachments),
        })}
      </p>
      <p className="hint">{t("adminRolesIntro")}</p>
      <div className="admin-table-wrap">
        <table className="admin-table" aria-labelledby="admin-members">
          <thead>
            <tr>
              <th scope="col">{t("adminColumnName")}</th>
              <th scope="col">{t("adminColumnEmail")}</th>
              <th scope="col">{t("adminColumnRole")}</th>
              <th scope="col">{t("adminColumnJoined")}</th>
            </tr>
          </thead>
          <tbody>
            {opened.members.map((member) => (
              <tr key={member.id}>
                <th scope="row">
                  {member.name}
                  {member.deactivated ? (
                    <span className="hint admin-tag">{t("accountDeactivated")}</span>
                  ) : null}
                </th>
                <td>{member.email}</td>
                <td>
                  <select
                    aria-label={t("membersRoleOf", { name: member.name })}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => {
                      onRole(member, event.target.value);
                    }}
                  >
                    {roles.map((role) => (
                      <option key={role} value={role}>
                        {roleName(role)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{day.format(new Date(member.joinedAt))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function WorkspacesPage() {
  const [search, setSearch] = useState("");
  // Only the workspaces with no active owner, for an instance admin to give one (ADR 0085).
  const [ownerless, setOwnerless] = useState(false);
  // The search the list shows, which its next pages keep.
  const [asked, setAsked] = useState({ search: "", ownerless: false });
  const [list, setList] = useState<Page | undefined>();
  const [opened, setOpened] = useState<Opened | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const report = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  }, []);

  const find = useCallback(
    (query: string, onlyOwnerless: boolean) => {
      setError(undefined);
      setList(undefined);
      page(query, onlyOwnerless)
        .then((found) => {
          setAsked({ search: query, ownerless: onlyOwnerless });
          setList(found);
        })
        .catch(report);
    },
    [report],
  );

  useEffect(() => {
    find("", false);
  }, [find]);

  const more = () => {
    const next = list?.next;
    if (next === undefined || next === null) return;
    setBusy(true);
    page(asked.search, asked.ownerless, next)
      .then((found) => {
        setList((current) => ({
          workspaces: [...(current?.workspaces ?? []), ...found.workspaces],
          next: found.next,
        }));
      })
      .catch(report)
      .finally(() => {
        setBusy(false);
      });
  };

  const open = (id: string) => {
    setError(undefined);
    setStatus(undefined);
    opening(id).then(setOpened).catch(report);
  };

  const back = () => {
    setOpened(undefined);
    setStatus(undefined);
    // Its owners or members may have changed while it was open.
    find(asked.search, asked.ownerless);
  };

  const setRole = (member: Member, role: string) => {
    if (opened === undefined) return;
    const { workspace } = opened;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    // The role shows at once, and as the server has it after.
    setOpened({
      ...opened,
      members: opened.members.map((each) => (each.id === member.id ? { ...each, role } : each)),
    });
    webFetch(`${webServer}/api/admin/workspaces/${workspace.id}/members/${member.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    })
      .then(async (answer) => {
        await answered<unknown>(answer);
        setStatus(
          t("adminRoleChanged", {
            name: member.name,
            workspace: workspace.name,
            role: roleName(role),
          }),
        );
      })
      .catch(report)
      .finally(() => {
        opening(workspace.id)
          .then(setOpened)
          .catch(report)
          .finally(() => {
            setBusy(false);
          });
      });
  };

  return (
    <section className="admin-section" aria-labelledby="admin-workspaces">
      <h2 id="admin-workspaces">{t("adminWorkspaces")}</h2>
      {opened === undefined ? (
        <>
          <form
            className="admin-find"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              find(search.trim(), ownerless);
            }}
          >
            <label className="field">
              {t("adminFind")}
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </label>
            <label className="field-check">
              <input
                type="checkbox"
                checked={ownerless}
                onChange={(event) => {
                  setOwnerless(event.target.checked);
                  find(search.trim(), event.target.checked);
                }}
              />
              {t("adminOnlyOwnerless")}
            </label>
            <button type="submit">{t("adminFindButton")}</button>
          </form>
          <List list={list} onOpen={open} />
          {typeof list?.next === "string" ? (
            <button type="button" className="quiet" disabled={busy} onClick={more}>
              {t("adminMore")}
            </button>
          ) : null}
        </>
      ) : (
        <Members opened={opened} busy={busy} onRole={setRole} onBack={back} />
      )}
      {status === undefined ? null : <p role="status">{status}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

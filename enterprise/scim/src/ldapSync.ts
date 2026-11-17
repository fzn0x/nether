// What an LDAP run changes (ADR 0085), worked out from what it read and
// what the directory's accounts and groups are now, then applied through
// the paths SCIM requests take: accounts made, taken over, changed and
// reactivated by `writeUser`, deactivated by core's `deactivateAccount`,
// groups made, renamed and removed by `writeGroup` and `deleteGroup`, and
// every place a group gives settled by core's `settleMemberships`. A person
// is known by the stable ID, so a renamed or moved entry stays the same
// account. Someone no longer read is deactivated, never removed: an LDAP
// read cannot tell a deletion from a filter that now leaves them out; they
// leave the read groups, so what those gave goes, and their own places
// stay. The groups go first, in one transaction; then the accounts, 500 to
// a transaction, each with its groups and places, so a run that stops
// between batches leaves each whole, and the next run finishes it.
import { deactivateAccount } from "@nether/server/src/accounts.ts";
import {
  type Database,
  type Queryable,
  readBoolean,
  readText,
  readTextOrNull,
} from "@nether/server/src/db.ts";
import { type EventActor, type ServerEvents, fromServer } from "@nether/server/src/events.ts";
import { settleMemberships } from "@nether/server/src/members.ts";
import type { Directory } from "./directories.ts";
import { ScimError } from "./errors.ts";
import {
  type GroupChanger,
  type Place,
  deleteGroup,
  lockGroup,
  setAccountGroups,
  writeGroup,
} from "./groupWrites.ts";
import { LdapFailure } from "./ldapConnect.ts";
import type { DirectoryRead, ReadGroup, ReadPerson, Skip } from "./ldapRead.ts";
import type { UserDoc } from "./userDoc.ts";
import { type UserContext, accountName, findUser, writeUser } from "./users.ts";

/** Accounts a transaction writes, with their groups and places. */
export const batchSize = 500;

/** How many of each list a preview keeps to show. */
const shown = 50;

/** What a run did, or would do. */
export interface RunCounts {
  /** People read. */
  readonly people: number;
  /** Groups read. */
  readonly groups: number;
  readonly made: number;
  readonly linked: number;
  readonly changed: number;
  readonly reactivated: number;
  readonly deactivated: number;
  readonly skipped: number;
  readonly groupsMade: number;
  readonly groupsChanged: number;
  readonly groupsRemoved: number;
  readonly membersAdded: number;
  readonly membersRemoved: number;
}

/** Someone a run makes, changes or deactivates, as the console names them. */
export interface Named {
  readonly name: string;
  readonly email: string;
}

/** Who a run would change, the first of each, as a preview and a held run show them. */
export interface RunPreview {
  readonly made: readonly Named[];
  readonly changed: readonly Named[];
  readonly reactivated: readonly Named[];
  readonly deactivated: readonly Named[];
  readonly groupsMade: readonly string[];
  readonly groupsRemoved: readonly string[];
}

/** One of the directory's accounts, as a run compares it. */
export interface AccountNow {
  readonly userId: string;
  readonly userName: string;
  readonly externalId: string | null;
  readonly displayName: string | null;
  readonly sentEmail: string | null;
  readonly name: string;
  readonly email: string;
  readonly deactivated: boolean;
  readonly groups: ReadonlySet<string>;
}

/** One of the directory's groups, as a run compares it. */
interface GroupNow {
  readonly id: string;
  readonly name: string;
  readonly externalId: string | null;
}

/** A person read, with the account they are, when they have one, and what changes. */
interface PersonPlan {
  readonly person: ReadPerson;
  readonly account: AccountNow | undefined;
  /** Whether the account is made, taken over, changed or reactivated. */
  readonly write: boolean;
}

/** What a run would change. */
export interface Plan {
  readonly groupsMade: readonly ReadGroup[];
  readonly groupsChanged: readonly { readonly now: GroupNow; readonly read: ReadGroup }[];
  readonly groupsRemoved: readonly GroupNow[];
  /** Read groups' IDs in Nether, by their stable IDs, for those that exist now. */
  readonly groupIds: ReadonlyMap<string, string>;
  readonly people: readonly PersonPlan[];
  /** Accounts no longer read: active ones are deactivated, and all leave their groups. */
  readonly gone: readonly AccountNow[];
  /** The directory's accounts that are active now. */
  readonly active: number;
  readonly counts: RunCounts;
}

/** A person's account as a write gives it: a name, the address, and active. */
export function docOf(person: ReadPerson): UserDoc {
  return {
    userName: person.userName,
    externalId: person.id,
    displayName: person.name,
    name: {},
    emails: [{ value: person.email, primary: true }],
    active: true,
  };
}

/** Whether a person's account differs from what was read, so it is written. */
function differs(account: AccountNow, person: ReadPerson): boolean {
  const doc = docOf(person);
  return (
    account.deactivated ||
    account.userName !== person.userName ||
    account.externalId !== person.id ||
    account.displayName !== person.name ||
    account.sentEmail !== person.email ||
    account.email !== person.email ||
    account.name !== accountName(doc, person.email)
  );
}

/** The directory's accounts as they are now, with their groups. */
async function accountsNow(db: Queryable, directory: string): Promise<AccountNow[]> {
  const { rows } = await db.query(
    `SELECT a.user_id, a.user_name, a.external_id, a.attributes, u.name, u.email,
            u.deactivated_at IS NOT NULL AS deactivated,
            coalesce((SELECT array_agg(gm.group_id::text) FROM group_members gm
                        JOIN groups g ON g.id = gm.group_id
                       WHERE gm.user_id = a.user_id AND g.directory_id = a.directory_id),
                     '{}') AS groups
       FROM directory_accounts a JOIN users u ON u.id = a.user_id
      WHERE a.directory_id = $1
      ORDER BY a.created_at, a.user_id`,
    [directory],
  );
  return rows.map((row) => {
    const attributes =
      typeof row.attributes === "object" && row.attributes !== null
        ? (row.attributes as { displayName?: unknown; emails?: unknown })
        : {};
    const emails = Array.isArray(attributes.emails) ? (attributes.emails as unknown[]) : [];
    const first = emails[0] as { value?: unknown } | undefined;
    return {
      userId: readText(row, "user_id"),
      userName: readText(row, "user_name"),
      externalId: readTextOrNull(row, "external_id"),
      displayName: typeof attributes.displayName === "string" ? attributes.displayName : null,
      sentEmail: emails.length === 1 && typeof first?.value === "string" ? first.value : null,
      name: readText(row, "name"),
      email: readText(row, "email"),
      deactivated: readBoolean(row, "deactivated"),
      groups: new Set(Array.isArray(row.groups) ? row.groups.map(String) : []),
    };
  });
}

/** Works out what a run changes, from what it read and the directory as it is now. */
export async function planRun(
  db: Queryable,
  directory: string,
  read: DirectoryRead,
): Promise<Plan> {
  const { rows } = await db.query(
    "SELECT id, name, external_id FROM groups WHERE directory_id = $1 ORDER BY created_at, id",
    [directory],
  );
  const groupsNow: GroupNow[] = rows.map((row) => ({
    id: readText(row, "id"),
    name: readText(row, "name"),
    externalId: readTextOrNull(row, "external_id"),
  }));

  // Groups, by their stable IDs; else, when the group with that ID is not
  // read, by name, as a group made again under its old name.
  const readGroupIds = new Set(read.groups.map((group) => group.id));
  const groupByExternal = new Map(groupsNow.map((group) => [group.externalId, group]));
  const groupByName = new Map(groupsNow.map((group) => [group.name.toLowerCase(), group]));
  const matchedGroups = new Set<GroupNow>();
  const groupIds = new Map<string, string>();
  const groupsMade: ReadGroup[] = [];
  const groupsChanged: { now: GroupNow; read: ReadGroup }[] = [];
  for (const group of read.groups) {
    const byName = groupByName.get(group.name.toLowerCase());
    const now =
      groupByExternal.get(group.id) ??
      (byName !== undefined &&
      !matchedGroups.has(byName) &&
      !readGroupIds.has(byName.externalId ?? "")
        ? byName
        : undefined);
    if (now === undefined || matchedGroups.has(now)) {
      groupsMade.push(group);
      continue;
    }
    matchedGroups.add(now);
    groupIds.set(group.id, now.id);
    if (now.name !== group.name || now.externalId !== group.id) {
      groupsChanged.push({ now, read: group });
    }
  }
  const groupsRemoved = groupsNow.filter((group) => !matchedGroups.has(group));
  const removedIds = new Set(groupsRemoved.map((group) => group.id));

  // People, by their stable IDs; else, when the account's own person is not
  // read, by userName, as an entry made again for the same person.
  const accounts = await accountsNow(db, directory);
  const readIds = new Set([...read.people.map((person) => person.id), ...read.kept]);
  const byExternal = new Map(accounts.map((account) => [account.externalId, account]));
  const byUserName = new Map(accounts.map((account) => [account.userName.toLowerCase(), account]));
  const matched = new Set<AccountNow>();
  const people: PersonPlan[] = [];
  let made = 0;
  let changed = 0;
  let reactivated = 0;
  let membersAdded = 0;
  let membersRemoved = 0;
  for (const person of read.people) {
    const byName = byUserName.get(person.userName.toLowerCase());
    const found =
      byExternal.get(person.id) ??
      (byName !== undefined && !matched.has(byName) && !readIds.has(byName.externalId ?? "")
        ? byName
        : undefined);
    const account = found === undefined || matched.has(found) ? undefined : found;
    if (account !== undefined) matched.add(account);
    const wanted = new Set(person.groups.map((id) => groupIds.get(id) ?? `new:${id}`));
    const now = account?.groups ?? new Set<string>();
    const adding = [...wanted].filter((id) => !now.has(id)).length;
    const leaving = [...now].filter((id) => !wanted.has(id)).length;
    const write = account === undefined || differs(account, person);
    if (!write && adding === 0 && leaving === 0) continue;
    people.push({ person, account, write });
    membersAdded += adding;
    membersRemoved += leaving;
    if (account === undefined) made += 1;
    else if (account.deactivated) reactivated += 1;
    else if (write) changed += 1;
  }

  // Whoever is no longer read, and was not skipped.
  const gone = accounts.filter(
    (account) =>
      !matched.has(account) &&
      !read.kept.has(account.externalId ?? "") &&
      (!account.deactivated || account.groups.size > 0),
  );
  for (const account of gone) {
    membersRemoved += [...account.groups].filter((id) => !removedIds.has(id)).length;
  }

  return {
    groupsMade,
    groupsChanged,
    groupsRemoved,
    groupIds,
    people,
    gone,
    active: accounts.filter((account) => !account.deactivated).length,
    counts: {
      people: read.people.length,
      groups: read.groups.length,
      made,
      linked: 0,
      changed,
      reactivated,
      deactivated: gone.filter((account) => !account.deactivated).length,
      skipped: read.skipped.length,
      groupsMade: groupsMade.length,
      groupsChanged: groupsChanged.length,
      groupsRemoved: groupsRemoved.length,
      membersAdded,
      membersRemoved,
    },
  };
}

/** The accounts a plan deactivates. */
export function deactivating(plan: Plan): string[] {
  return plan.gone.filter((account) => !account.deactivated).map((account) => account.userId);
}

/** Who a plan changes, the first of each, as the console shows them. */
export function previewOf(plan: Plan): RunPreview {
  const person = (each: PersonPlan): Named => ({
    name: each.person.name ?? each.person.userName,
    email: each.person.email,
  });
  return {
    made: plan.people
      .filter((each) => each.account === undefined)
      .slice(0, shown)
      .map(person),
    changed: plan.people
      .filter((each) => each.write && each.account !== undefined && !each.account.deactivated)
      .slice(0, shown)
      .map(person),
    reactivated: plan.people
      .filter((each) => each.account?.deactivated === true)
      .slice(0, shown)
      .map(person),
    deactivated: plan.gone
      .filter((account) => !account.deactivated)
      .slice(0, shown)
      .map((account) => ({ name: account.name, email: account.email })),
    groupsMade: plan.groupsMade.slice(0, shown).map((group) => group.name),
    groupsRemoved: plan.groupsRemoved.slice(0, shown).map((group) => group.name),
  };
}

/** What applying a run is given. */
export interface ApplyContext {
  readonly db: Database;
  readonly events: ServerEvents;
  readonly directory: Directory;
  /** Closes an account's connections on every node, once a change to it commits. */
  readonly disconnect: (userId: string) => void;
  /** Whether the server is stopping, so the run stops between batches. */
  readonly stopped: () => boolean;
}

/** What applying gave: what changed, and who was skipped on the way. */
export interface Applied {
  readonly counts: RunCounts;
  readonly skipped: readonly Skip[];
}

/** Why a write was refused, as a skip names it. */
function reasonOf(error: unknown): string {
  if (error instanceof ScimError) return error.message;
  return `Nether could not write it: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Runs one item's writes in a savepoint of the caller's transaction: a
 * refusal, as an address another directory has, undoes that item alone,
 * and gives why, for the run to skip it.
 */
async function attempt<T>(
  tx: Queryable,
  work: () => Promise<T>,
): Promise<{ readonly done: T } | { readonly refused: string }> {
  await tx.query("SAVEPOINT ldap_item");
  try {
    const done = await work();
    await tx.query("RELEASE SAVEPOINT ldap_item");
    return { done };
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT ldap_item");
    return { refused: reasonOf(error) };
  }
}

const stoppedMessage = "The server stopped during the run. The next run finishes it.";

/** Applies a plan, telling of each change as the directory's; gives what it did. */
export async function applyPlan(context: ApplyContext, plan: Plan): Promise<Applied> {
  const { db, events, directory, disconnect, stopped } = context;
  const actor: EventActor = { kind: "directory", id: directory.id, name: directory.name };
  const changer: GroupChanger = { directory: directory.id, actor, origin: fromServer, events };
  const users: UserContext = { directory, events, by: { actor, origin: fromServer } };
  const skipped: Skip[] = [];
  const counts = {
    ...plan.counts,
    made: 0,
    linked: 0,
    changed: 0,
    reactivated: 0,
    deactivated: 0,
    groupsMade: 0,
    groupsChanged: 0,
    groupsRemoved: 0,
    membersAdded: 0,
    membersRemoved: 0,
  };
  const groupIds = new Map(plan.groupIds);
  const groupNames = new Map<string, string>();
  for (const group of plan.groupsChanged) groupNames.set(group.now.id, group.read.name);

  // The groups read, made or renamed, before anyone is put in them.
  await db.transaction(async (tx) => {
    for (const group of plan.groupsMade) {
      const outcome = await attempt(tx, () =>
        writeGroup(tx, changer, undefined, {
          displayName: group.name,
          externalId: group.id,
          members: [],
        }),
      );
      if ("refused" in outcome) {
        skipped.push({ dn: group.dn, reason: outcome.refused });
        continue;
      }
      groupIds.set(group.id, outcome.done.groupId);
      counts.groupsMade += 1;
    }
    for (const { now, read } of plan.groupsChanged) {
      const outcome = await attempt(tx, async () => {
        const locked = await lockGroup(tx, directory.id, now.id);
        if (locked === undefined) throw new ScimError(404, "The group was removed meanwhile.");
        const members = await tx.query(
          "SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY created_at, user_id",
          [now.id],
        );
        return writeGroup(tx, changer, locked, {
          displayName: read.name,
          externalId: read.id,
          members: members.rows.map((row) => readText(row, "user_id")),
        });
      });
      if ("refused" in outcome) {
        skipped.push({ dn: read.dn, reason: outcome.refused });
        continue;
      }
      counts.groupsChanged += 1;
    }
  });
  const readNames = new Map<string, string>();
  for (const group of [...plan.groupsMade, ...plan.groupsChanged.map((each) => each.read)]) {
    const id = groupIds.get(group.id);
    if (id !== undefined) readNames.set(id, group.name);
  }
  const groupsOf = (person: ReadPerson) => {
    const groups = new Map<string, string>();
    for (const stable of person.groups) {
      const id = groupIds.get(stable);
      if (id !== undefined) groups.set(id, readNames.get(id) ?? groupNames.get(id) ?? "");
    }
    return groups;
  };

  /** Runs a batch in one transaction, settles the places it touched, then closes connections. */
  const batch = async <T>(
    items: readonly T[],
    each: (tx: Queryable, item: T, places: Place[], closing: Set<string>) => Promise<void>,
  ) => {
    for (let start = 0; start < items.length; start += batchSize) {
      if (stopped()) throw new LdapFailure(stoppedMessage);
      const closing = await db.transaction(async (tx) => {
        const places: Place[] = [];
        const closing = new Set<string>();
        for (const item of items.slice(start, start + batchSize)) {
          await each(tx, item, places, closing);
        }
        for (const user of await settleMemberships(
          tx,
          places,
          { actor, origin: fromServer },
          events,
        )) {
          closing.add(user);
        }
        return closing;
      });
      for (const user of closing) disconnect(user);
    }
  };

  // People read: made, taken over, changed or reactivated, with their groups.
  await batch(plan.people, async (tx, item, places) => {
    const outcome = await attempt(tx, async () => {
      let userId = item.account?.userId;
      let created = false;
      if (item.write) {
        const existing =
          userId === undefined ? undefined : await findUser(tx, directory.id, userId, true);
        if (userId !== undefined && existing === undefined) {
          throw new ScimError(404, "Its account is no longer this directory's.");
        }
        const written = await writeUser(tx, users, existing, docOf(item.person));
        userId = written.userId;
        created = written.created;
      }
      if (userId === undefined) throw new Error("A person read has no account to put in groups.");
      const groups = await setAccountGroups(tx, changer, userId, groupsOf(item.person));
      return { created, groups };
    });
    if ("refused" in outcome) {
      skipped.push({ dn: item.person.dn, reason: outcome.refused });
      return;
    }
    const { created, groups } = outcome.done;
    places.push(...groups.places);
    counts.membersAdded += groups.added;
    counts.membersRemoved += groups.removed;
    if (item.account === undefined) {
      if (created) counts.made += 1;
      else counts.linked += 1;
    } else if (item.account.deactivated) counts.reactivated += 1;
    else if (item.write) counts.changed += 1;
  });

  // People no longer read: deactivated, out of the read groups, their own places kept.
  await batch(plan.gone, async (tx, account, places, closing) => {
    const outcome = await attempt(tx, async () => {
      let deactivated = false;
      if (!account.deactivated) {
        const done = await deactivateAccount(tx, account.userId, users.by, events);
        if (typeof done !== "string") throw new ScimError(done[0], done[1]);
        deactivated = done === "changed";
      }
      const groups = await setAccountGroups(tx, changer, account.userId, new Map());
      return { deactivated, groups };
    });
    if ("refused" in outcome) {
      skipped.push({ dn: `${account.name} <${account.email}>`, reason: outcome.refused });
      return;
    }
    const { deactivated, groups } = outcome.done;
    if (deactivated) {
      counts.deactivated += 1;
      closing.add(account.userId);
    }
    places.push(...groups.places);
    counts.membersRemoved += groups.removed;
  });

  // Groups no longer read, with what they gave.
  if (stopped()) throw new LdapFailure(stoppedMessage);
  const closing = await db.transaction(async (tx) => {
    const closing = new Set<string>();
    for (const group of plan.groupsRemoved) {
      const outcome = await attempt(tx, async () => {
        const locked = await lockGroup(tx, directory.id, group.id);
        return locked === undefined ? new Set<string>() : deleteGroup(tx, changer, locked);
      });
      if ("refused" in outcome) {
        skipped.push({ dn: group.name, reason: outcome.refused });
        continue;
      }
      for (const user of outcome.done) closing.add(user);
      counts.groupsRemoved += 1;
    }
    return closing;
  });
  for (const user of closing) disconnect(user);

  return { counts: { ...counts, skipped: plan.counts.skipped + skipped.length }, skipped };
}

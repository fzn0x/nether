// An LDAP directory on the server (ADR 0085), read through a fake in place
// of the network: its settings and sealed bind password on the console;
// the first run a preview, applied once confirmed; people known by their
// stable IDs, made, taken over, changed, deactivated when no longer read
// and reactivated when they come back, with the places their groups give;
// a large deactivation held back until Run anyway; a failed read changing
// nothing; and runs started when they are due, one at a time.
import { afterEach, describe, expect, it } from "vitest";
import { readBoolean, readText } from "@nether/server/src/db.ts";
import { LdapFailure } from "../src/ldapConnect.ts";
import type { ReadGroup, ReadPerson, Skip } from "../src/ldapRead.ts";
import { dueDirectories } from "../src/ldapRuns.ts";
import { type Test, actions, admin, join, start, stop } from "./server.ts";

afterEach(stop);

const secretKey = Buffer.alloc(32, 7).toString("base64");

/** A directory read in place of the network, which a test changes between runs. */
function fakeDirectory() {
  const fake: {
    people: ReadPerson[];
    groups: ReadGroup[];
    skipped: Skip[];
    failure: Error | undefined;
    password: string | undefined;
  } = { people: [], groups: [], skipped: [], failure: undefined, password: undefined };
  return {
    fake,
    readLdap: (_settings: unknown, password: string) => {
      fake.password = password;
      if (fake.failure !== undefined) return Promise.reject(fake.failure);
      return Promise.resolve({
        people: [...fake.people],
        groups: [...fake.groups],
        skipped: [...fake.skipped],
        kept: new Set<string>(),
      });
    },
  };
}

function person(uid: string, groups: string[] = [], domain = "corp.example"): ReadPerson {
  return {
    id: `id-${uid}`,
    dn: `uid=${uid},ou=people,dc=corp,dc=example`,
    userName: uid,
    email: `${uid}@${domain}`,
    name: `Person ${uid}`,
    groups: groups.map((name) => `group-${name}`),
  };
}

function group(name: string): ReadGroup {
  return { id: `group-${name}`, dn: `cn=${name},ou=groups,dc=corp,dc=example`, name };
}

const settings = {
  url: "ldaps://ldap.corp.example",
  bindDn: "cn=reader,dc=corp,dc=example",
  password: "reader-password",
  peopleBase: "ou=people,dc=corp,dc=example",
  groupsBase: "ou=groups,dc=corp,dc=example",
};

async function startWith(env: Record<string, string> = {}) {
  const directory = fakeDirectory();
  const test = await start(
    { NETHER_SECRET_KEY: secretKey, ...env },
    { readLdap: directory.readLdap },
  );
  return { test, fake: directory.fake };
}

/** Adds an LDAP directory for `domains`, with the settings above. */
async function addLdap(test: Test, domains = ["corp.example"], extra: object = {}) {
  const added = await admin(test, "POST", "/api/admin/directories", {
    id: "corp",
    name: "Corp LDAP",
    kind: "ldap",
    domains,
    ldap: { ...settings, ...extra },
  });
  expect(added.statusCode, added.body).toBe(201);
  return added.json<{ ldap: LdapShown }>();
}

interface LdapShown {
  readonly running: boolean;
  readonly confirmed: boolean;
  readonly passwordSet: boolean;
  readonly nextAt: string | null;
  readonly last: {
    readonly outcome: string;
    readonly failure: string | null;
    readonly counts: Record<string, number> | null;
    readonly skipped: Skip[];
    readonly preview: {
      readonly made: { name: string; email: string }[];
      readonly deactivated: { name: string; email: string }[];
      readonly groupsMade: string[];
    } | null;
  } | null;
}

async function shown(test: Test, id = "corp"): Promise<LdapShown> {
  const listed = await admin(test, "GET", "/api/admin/directories");
  const found = listed
    .json<{ directories: { id: string; ldap: LdapShown }[] }>()
    .directories.find((each) => each.id === id);
  if (found === undefined) throw new Error(`No directory ${id}`);
  return found.ldap;
}

/** Asks for a run, and waits for it to end. */
async function sync(test: Test, body: object = {}, id = "corp"): Promise<LdapShown> {
  const asked = await admin(test, "POST", `/api/admin/directories/${id}/sync`, body);
  expect(asked.statusCode, asked.body).toBe(202);
  for (let tries = 0; tries < 400; tries += 1) {
    const now = await shown(test, id);
    if (!now.running) return now;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The run did not end.");
}

/** The first run, previewed, then applied. */
async function firstRun(test: Test): Promise<LdapShown> {
  expect((await sync(test)).last?.outcome).toBe("preview");
  return sync(test, { confirm: true });
}

async function account(test: Test, email: string) {
  const { rows } = await test.db.query(
    `SELECT u.id, u.name, u.email, u.deactivated_at IS NOT NULL AS deactivated, a.user_name,
            a.external_id
       FROM users u LEFT JOIN directory_accounts a ON a.user_id = u.id WHERE u.email = $1`,
    [email],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    deactivated: readBoolean(row, "deactivated"),
    userName: row.user_name,
    externalId: row.external_id,
  };
}

async function roleIn(test: Test, user: string): Promise<[string, string | null] | undefined> {
  const { rows } = await test.db.query(
    "SELECT role, own_role FROM memberships WHERE workspace_id = $1 AND user_id = $2",
    [test.workspaceId, user],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : [readText(row, "role"), (row.own_role as string | null) ?? null];
}

describe("an LDAP directory", () => {
  it("keeps its settings and its bind password sealed, asked for again when its address or DN change", async () => {
    const { test } = await startWith();
    const added = await addLdap(test);
    expect(added.ldap).toMatchObject({
      passwordSet: true,
      running: false,
      confirmed: false,
      nextAt: null,
      last: null,
    });
    const listed = await admin(test, "GET", "/api/admin/directories");
    expect(listed.body).not.toContain("reader-password");
    expect(listed.json()).toMatchObject({
      secretKey: true,
      ldapPresets: {
        activeDirectory: { idAttribute: "objectGUID", idIsGuid: true },
        openLdap: { idAttribute: "entryUUID", userNameAttribute: "uid" },
      },
    });
    const { rows } = await test.db.query("SELECT secrets FROM directories WHERE id = 'corp'");
    expect(Buffer.from(rows[0]?.secrets as Uint8Array).includes("reader-password")).toBe(false);

    // A new address or bind DN asks for the password again.
    const moved = await admin(test, "PATCH", "/api/admin/directories/corp", {
      ldap: { url: "ldaps://other.corp.example" },
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json<{ message: string }>().message).toContain("asks for the bind password again");
    const rebound = await admin(test, "PATCH", "/api/admin/directories/corp", {
      ldap: { bindDn: "cn=other,dc=corp,dc=example", password: "another-password" },
    });
    expect(rebound.statusCode, rebound.body).toBe(200);
    const filtered = await admin(test, "PATCH", "/api/admin/directories/corp", {
      ldap: { peopleFilter: "(objectClass=person)", everyMinutes: 30, holdPercent: 25 },
    });
    expect(filtered.json()).toMatchObject({
      ldap: { peopleFilter: "(objectClass=person)", everyMinutes: 30, holdPercent: 25 },
    });
    expect(actions(test).filter((each) => each.startsWith("directory."))).toEqual([
      "directory.created",
      "directory.changed",
      "directory.changed",
    ]);

    // Encrypted, a host alone, and checked filters and trust.
    for (const [ldap, why] of [
      [{ url: "http://ldap.corp.example" }, "ldaps://host or ldap://host"],
      [{ url: "ldaps://ldap.corp.example/dc=corp" }, "the host and port alone"],
      [{ peopleFilter: "(objectClass=person" }, "does not read as an LDAP filter"],
      [{ fingerprint: "not hex" }, "64 hex digits"],
      [{ ca: "not a certificate" }, "certificates in PEM"],
      [{ fingerprint: "ab".repeat(32), ca: "-----BEGIN CERTIFICATE-----" }, "not both"],
      [{ idAttribute: "object GUID" }, "an attribute's name"],
    ] as const) {
      const refused = await admin(test, "PATCH", "/api/admin/directories/corp", {
        ldap: { ...ldap, password: "reader-password" },
      });
      expect(refused.statusCode, JSON.stringify(ldap)).toBe(400);
      expect(refused.json<{ message: string }>().message).toContain(why);
    }
    const scim = await admin(test, "POST", "/api/admin/directories", {
      id: "okta",
      name: "Okta",
      ldap: settings,
    });
    expect(scim.statusCode).toBe(400);
    const noPassword = await admin(test, "POST", "/api/admin/directories", {
      id: "other",
      name: "Other",
      kind: "ldap",
      ldap: { ...settings, password: undefined },
    });
    expect(noPassword.json<{ message: string }>().message).toBe("Give the bind password.");
    await stop();

    // Without NETHER_SECRET_KEY, no password can be kept.
    const keyless = await start();
    const refused = await admin(keyless, "POST", "/api/admin/directories", {
      id: "corp",
      name: "Corp",
      kind: "ldap",
      ldap: settings,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ message: string }>().message).toContain("NETHER_SECRET_KEY");
  });

  it("reaches no address that is not public unless NETHER_LDAP_PRIVATE allows it", async () => {
    const test = await start(
      { NETHER_SECRET_KEY: secretKey },
      { resolve: () => Promise.resolve([{ address: "10.0.0.5", family: 4 }]) },
    );
    await addLdap(test);
    const tested = await admin(test, "POST", "/api/admin/directories/corp/test");
    expect(tested.statusCode).toBe(400);
    expect(tested.json<{ message: string }>().message).toBe(
      "ldap.corp.example resolves to 10.0.0.5, which is not a public address: the server's admin can allow it with NETHER_LDAP_PRIVATE.",
    );
    // A run says so too, and changes nothing.
    const ran = await sync(test);
    expect(ran.last).toMatchObject({
      outcome: "failed",
      failure: tested.json<{ message: string }>().message,
    });
  });

  it("previews its first run, applies it once confirmed, and tells of each change as the directory's", async () => {
    const { test, fake } = await startWith();
    await addLdap(test);
    fake.people = [person("ada", ["eng"]), person("bea")];
    fake.groups = [group("eng")];

    const preview = await sync(test);
    expect(fake.password).toBe("reader-password");
    expect(preview.last).toMatchObject({
      outcome: "preview",
      counts: { people: 2, groups: 1, made: 2, groupsMade: 1, membersAdded: 1, deactivated: 0 },
      preview: {
        made: [
          { name: "Person ada", email: "ada@corp.example" },
          { name: "Person bea", email: "bea@corp.example" },
        ],
        groupsMade: ["eng"],
      },
    });
    expect(await account(test, "ada@corp.example")).toBeUndefined();
    expect(preview.confirmed).toBe(false);
    // The schedule leaves an unconfirmed directory alone.
    expect(await dueDirectories(test.db)).toEqual([]);

    const from = test.told.length;
    const applied = await sync(test, { confirm: true });
    expect(applied.confirmed).toBe(true);
    expect(applied.nextAt).not.toBeNull();
    expect(applied.last).toMatchObject({
      outcome: "applied",
      counts: { made: 2, linked: 0, groupsMade: 1, membersAdded: 1 },
      preview: null,
    });
    const ada = await account(test, "ada@corp.example");
    expect(ada).toMatchObject({
      name: "Person ada",
      deactivated: false,
      userName: "ada",
      externalId: "id-ada",
    });
    expect(actions(test, from)).toEqual([
      "directory.changed",
      "group.created",
      "account.created",
      "group.member_added",
      "account.created",
      "directory.synced",
    ]);
    const made = test.told.slice(from).find((event) => event.action === "account.created");
    expect(made).toMatchObject({
      actor: { kind: "directory", id: "corp", name: "Corp LDAP" },
      details: { by: "ldap", directory: "corp" },
    });
    expect(test.told.at(-1)).toMatchObject({
      action: "directory.synced",
      details: { outcome: "applied", counts: { made: 2 } },
    });
    // Nothing changes the next time.
    const again = await sync(test);
    expect(again.last?.counts).toMatchObject({ made: 0, changed: 0, membersAdded: 0 });
  });

  it("knows people by their IDs, deactivates who it no longer reads, and gives their groups back when they return", async () => {
    const { test, fake } = await startWith();
    await addLdap(test);
    // Bea has her own place already; the directory takes her account over.
    const bea = await join(test, "bea@corp.example", "Bea");
    fake.people = [person("ada", ["eng"]), person("bea", ["eng"])];
    fake.groups = [group("eng")];
    const first = await firstRun(test);
    expect(first.last?.counts).toMatchObject({ made: 1, linked: 1 });
    const groupId = readText(
      (await test.db.query("SELECT id FROM groups WHERE directory_id = 'corp'")).rows[0],
      "id",
    );
    const mapped = await admin(
      test,
      "PUT",
      `/api/admin/directories/corp/groups/${groupId}/workspaces/${test.workspaceId}`,
      { role: "admin" },
    );
    expect(mapped.statusCode).toBe(204);
    const ada = await account(test, "ada@corp.example");
    if (ada === undefined) throw new Error("Ada was not made");
    expect(await roleIn(test, ada.id)).toEqual(["admin", "none"]);
    expect(await roleIn(test, bea.id)).toEqual(["admin", "member"]);

    // Renamed and moved, Ada stays one account.
    fake.people = [
      {
        ...person("ada.l", ["eng"]),
        id: "id-ada",
        dn: "uid=ada.l,ou=moved,dc=corp,dc=example",
        email: "ada.l@corp.example",
        name: "Ada Lovelace",
      },
      person("bea", ["eng"]),
    ];
    const renamed = await sync(test);
    expect(renamed.last?.counts).toMatchObject({ made: 0, changed: 1 });
    expect(await account(test, "ada.l@corp.example")).toMatchObject({
      id: ada.id,
      name: "Ada Lovelace",
      userName: "ada.l",
    });

    // Bea is no longer read: deactivated, out of the group, her own place kept.
    fake.people = fake.people.filter((each) => each.userName !== "bea");
    const from = test.told.length;
    const gone = await sync(test);
    expect(gone.last?.counts).toMatchObject({ deactivated: 1, membersRemoved: 1 });
    expect(await account(test, "bea@corp.example")).toMatchObject({ deactivated: true });
    expect(await roleIn(test, bea.id)).toEqual(["member", null]);
    expect(actions(test, from)).toEqual([
      "account.deactivated",
      "group.member_removed",
      "member.role_changed",
      "directory.synced",
    ]);
    const session = await test.server.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${bea.token}` },
    });
    expect(session.statusCode).toBe(401);

    // She comes back: reactivated, in her group again.
    fake.people = [...fake.people, person("bea", ["eng"])];
    const back = await sync(test);
    expect(back.last?.counts).toMatchObject({ reactivated: 1, membersAdded: 1 });
    expect(await account(test, "bea@corp.example")).toMatchObject({ deactivated: false });
    expect(await roleIn(test, bea.id)).toEqual(["admin", "member"]);

    // The group goes: what it gave goes with it; one made again by its name keeps nothing of it.
    fake.groups = [];
    fake.people = fake.people.map((each) => ({ ...each, groups: [] }));
    const removed = await sync(test);
    expect(removed.last?.counts).toMatchObject({ groupsRemoved: 1 });
    expect(await roleIn(test, ada.id)).toBeUndefined();
    expect(await roleIn(test, bea.id)).toEqual(["member", null]);
  });

  it("finds a group made again under its name, and keeps its places", async () => {
    const { test, fake } = await startWith();
    await addLdap(test);
    fake.people = [person("ada", ["eng"])];
    fake.groups = [group("eng")];
    await firstRun(test);
    const groupId = readText(
      (await test.db.query("SELECT id FROM groups WHERE directory_id = 'corp'")).rows[0],
      "id",
    );
    // Deleted and made again in the directory: a new ID, the same name.
    fake.groups = [{ ...group("eng"), id: "group-eng-again" }];
    fake.people = [{ ...person("ada"), groups: ["group-eng-again"] }];
    const ran = await sync(test);
    expect(ran.last?.counts).toMatchObject({ groupsMade: 0, groupsChanged: 1, groupsRemoved: 0 });
    const { rows } = await test.db.query(
      "SELECT id, external_id FROM groups WHERE directory_id = 'corp'",
    );
    expect(rows).toEqual([{ id: groupId, external_id: "group-eng-again" }]);
  });

  it("holds back a large deactivation until an instance admin looks, and Run anyway applies it once", async () => {
    const { test, fake } = await startWith();
    await addLdap(test);
    const everyone = Array.from({ length: 10 }, (_, at) => person(`p${String(at)}`));
    fake.people = everyone;
    await firstRun(test);
    const notHeld = await admin(test, "POST", "/api/admin/directories/corp/sync", {
      anyway: true,
    });
    expect(notHeld.statusCode).toBe(409);

    // A filter misspelled: seven of ten no longer read.
    fake.people = everyone.slice(0, 3);
    const held = await sync(test);
    expect(held.last).toMatchObject({ outcome: "held", counts: { deactivated: 7 } });
    expect(held.last?.preview?.deactivated).toHaveLength(7);
    expect(await account(test, "p9@corp.example")).toMatchObject({ deactivated: false });
    expect(test.told.at(-1)).toMatchObject({
      action: "directory.synced",
      details: { outcome: "held", holding: 7 },
    });

    // Looked at, and run anyway.
    const from = test.told.length;
    const anyway = await sync(test, { anyway: true });
    expect(anyway.last).toMatchObject({ outcome: "applied", counts: { deactivated: 7 } });
    expect(await account(test, "p9@corp.example")).toMatchObject({ deactivated: true });
    expect(test.told[from]).toMatchObject({
      action: "directory.changed",
      actor: { kind: "account", id: test.userId },
      details: { run: "run anyway" },
    });
  });

  it("changes nothing when a read fails", async () => {
    const { test, fake } = await startWith();
    await addLdap(test);
    fake.people = [person("ada")];
    await firstRun(test);
    fake.failure = new LdapFailure("The directory refused the bind DN and password.");
    fake.people = [];
    const failed = await sync(test);
    expect(failed.last).toMatchObject({
      outcome: "failed",
      failure: "The directory refused the bind DN and password.",
      counts: null,
    });
    expect(await account(test, "ada@corp.example")).toMatchObject({ deactivated: false });
    expect(test.told.at(-1)).toMatchObject({
      action: "directory.synced",
      outcome: "failure",
      details: { outcome: "failed" },
    });
  });

  it("skips whom it cannot write, and never deactivates the last active instance admin", async () => {
    const { test, fake } = await startWith();
    await addLdap(test, ["example.org"]);
    fake.people = [person("ada", [], "example.org"), person("eve", [], "elsewhere.example")];
    fake.skipped = [{ dn: "uid=nomail,ou=people", reason: "It has no address in mail." }];
    const first = await firstRun(test);
    expect(first.last?.counts).toMatchObject({ linked: 1, made: 0, skipped: 2 });
    expect(first.last?.skipped).toEqual([
      { dn: "uid=nomail,ou=people", reason: "It has no address in mail." },
      {
        dn: "uid=eve,ou=people,dc=corp,dc=example",
        reason:
          "eve@elsewhere.example is not at one of this directory's domains: example.org. Add its domain on the console's Directories page.",
      },
    ]);
    // The setup's admin, taken over, is the only instance admin.
    expect(await account(test, "ada@example.org")).toMatchObject({ id: test.userId });
    fake.people = [];
    fake.skipped = [];
    const gone = await sync(test);
    expect(gone.last?.outcome).toBe("applied");
    expect(gone.last?.counts).toMatchObject({ deactivated: 0, skipped: 1 });
    expect(gone.last?.skipped[0]?.reason).toContain("last active instance admin");
    expect(await account(test, "ada@example.org")).toMatchObject({ deactivated: false });
  });

  it("runs when its time comes, on one node at a time", async () => {
    const { test, fake } = await startWith();
    await addLdap(test);
    fake.people = [person("ada")];
    await firstRun(test);
    // Just ran: not due for an hour.
    expect(await dueDirectories(test.db)).toEqual([]);
    await test.db.query(
      `UPDATE directories
          SET sync_state = sync_state || jsonb_build_object('startedAt', now() - interval '61 minutes')
        WHERE id = 'corp'`,
    );
    expect(await dueDirectories(test.db)).toEqual(["corp"]);
    // Claimed by another node meanwhile: not due, and Sync now waits too.
    await test.db.query(
      "UPDATE directories SET syncing_until = now() + interval '1 hour' WHERE id = 'corp'",
    );
    expect(await dueDirectories(test.db)).toEqual([]);
    const busy = await admin(test, "POST", "/api/admin/directories/corp/sync", {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json<{ message: string }>().message).toBe("A run of this directory is on now.");
    // A claim whose node died lapses.
    await test.db.query(
      "UPDATE directories SET syncing_until = now() - interval '1 second' WHERE id = 'corp'",
    );
    expect(await dueDirectories(test.db)).toEqual(["corp"]);
  });
});

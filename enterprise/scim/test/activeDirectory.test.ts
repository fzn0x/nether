// The LDAP pull's Active Directory preset against a Samba domain controller
// (#214, ADR 0085): the preset read from an organizational unit over
// ldaps:// with the domain's authority pasted, and over ldap:// with
// StartTLS; objectGUID kept across a rename and a move; a disabled account
// deactivated; nested groups flattened through a group the filter does not
// read; a group of more than 1,500 members read through memberOf; the hold
// on a large deactivation; and the referrals the domain's root sends,
// which fail a run, saying so.
//
// They run when NETHER_TEST_AD names the folder the domain controller of
// test/ad/ wrote its authority to, as CI sets it, and are skipped
// otherwise. It answers on localhost, ports 2389 and 2636.
//
// Where Samba is not Windows Active Directory, each test says so: Samba
// sends a large group's member whole where Windows sends ranges of 1,500,
// and it caps no page at MaxPageSize.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Attribute, Change, Client } from "ldapts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readBoolean, readText } from "@nether/server/src/db.ts";
import { guidOf } from "../src/ldapRead.ts";
import { type Test, admin, start, stop } from "./server.ts";

const folder = process.env.NETHER_TEST_AD ?? "";
const ca = folder === "" ? "" : readFileSync(join(folder, "ca.pem"), "utf8");

const ldaps = "ldaps://localhost:2636";
const startTls = "ldap://localhost:2389";
const domain = "DC=corp,DC=example";
const administrator = `CN=Administrator,CN=Users,${domain}`;
const administratorPassword = process.env.NETHER_TEST_AD_PASSWORD ?? "Admin-Passw0rd-1";

/** The account Nether binds as: a service account of the test's own, with a password. */
const reader = { dn: "", password: `Reader-${randomUUID().slice(0, 8)}-1a` };

afterEach(stop);

/** The domain's administrator, who shapes each test's tree. */
async function domainAdmin(): Promise<Client> {
  const client = new Client({ url: ldaps, tlsOptions: { ca } });
  await client.bind(administrator, administratorPassword);
  return client;
}

/** A short name of its own for an account, as sAMAccountName takes 20 characters at most. */
const accountName = () => `n${randomUUID().replace(/-/g, "").slice(0, 18)}`;

/** An organizational unit of the test's own under `parent`; gives its DN. */
async function unit(client: Client, name: string, parent = domain): Promise<string> {
  const dn = `OU=${name},${parent}`;
  await client.add(dn, { objectClass: ["top", "organizationalUnit"] });
  return dn;
}

/**
 * A tree of the test's own: OU=People, OU=Moved and OU=Groups under one
 * OU, and a tag for its addresses, as a domain holds a userPrincipalName
 * once and keeps every test's people.
 */
async function tree(client: Client) {
  const tag = randomUUID().slice(0, 8);
  const base = await unit(client, `t${tag}`);
  return {
    tag,
    base,
    people: await unit(client, "People", base),
    moved: await unit(client, "Moved", base),
    groups: await unit(client, "Groups", base),
  };
}

/** A person, enabled with no password of their own, as a directory holds many. */
async function person(client: Client, ou: string, name: string, tag: string): Promise<string> {
  const dn = `CN=${name},${ou}`;
  const email = address(name, tag);
  await client.add(dn, {
    objectClass: ["top", "person", "organizationalPerson", "user"],
    sAMAccountName: accountName(),
    userPrincipalName: email,
    mail: email,
    displayName: `${name} Person`,
    // A normal account, with no password required.
    userAccountControl: "544",
  });
  return dn;
}

async function group(client: Client, dn: string, members: readonly string[]): Promise<void> {
  await client.add(dn, {
    objectClass: ["top", "group"],
    sAMAccountName: accountName(),
    ...(members.length === 0 ? {} : { member: [...members] }),
  });
}

function replace(client: Client, dn: string, type: string, value: string) {
  return client.modify(
    dn,
    new Change({ operation: "replace", modification: new Attribute({ type, values: [value] }) }),
  );
}

/** Disables an account, as Active Directory's admins do: bit 2 of userAccountControl. */
const disable = (client: Client, dn: string) => replace(client, dn, "userAccountControl", "546");

/** A person's address and userPrincipalName. */
const address = (name: string, tag: string) => `${name.toLowerCase()}.${tag}@corp.example`;

/** An account's objectGUID, as the domain holds it. */
async function objectGuid(client: Client, dn: string): Promise<string> {
  const { searchEntries } = await client.search(dn, {
    scope: "base",
    attributes: ["objectGUID"],
    explicitBufferAttributes: ["objectGUID"],
  });
  const value = searchEntries[0]?.objectGUID;
  if (!Buffer.isBuffer(value)) throw new Error(`${dn} has no objectGUID`);
  return guidOf(value);
}

async function server(): Promise<Test> {
  return start({
    NETHER_SECRET_KEY: Buffer.alloc(32, 11).toString("base64"),
    NETHER_LDAP_PRIVATE: "loopback",
  });
}

/** Adds the domain as an LDAP directory, from the console's Active Directory preset. */
async function addDomain(test: Test, ldap: Record<string, unknown>) {
  const listed = await admin(test, "GET", "/api/admin/directories");
  const preset = listed.json<{ ldapPresets: { activeDirectory: Record<string, unknown> } }>()
    .ldapPresets.activeDirectory;
  const added = await admin(test, "POST", "/api/admin/directories", {
    id: "corp",
    name: "Corp",
    kind: "ldap",
    domains: ["corp.example"],
    ldap: {
      ...preset,
      url: ldaps,
      ca,
      bindDn: reader.dn,
      password: reader.password,
      groupsFilter: "(&(objectClass=group)(cn=nether-*))",
      ...ldap,
    },
  });
  expect(added.statusCode, added.body).toBe(201);
}

function change(test: Test, ldap: object) {
  return admin(test, "PATCH", "/api/admin/directories/corp", { ldap });
}

interface Last {
  readonly outcome: string;
  readonly failure: string | null;
  readonly counts: Record<string, number> | null;
  readonly preview: { readonly deactivated: readonly unknown[] } | null;
}

async function sync(test: Test, body: object = {}): Promise<Last> {
  const asked = await admin(test, "POST", "/api/admin/directories/corp/sync", body);
  expect(asked.statusCode, asked.body).toBe(202);
  for (let tries = 0; tries < 4800; tries += 1) {
    const listed = await admin(test, "GET", "/api/admin/directories");
    const ldap = listed.json<{ directories: { ldap: { running: boolean; last: Last } }[] }>()
      .directories[0]?.ldap;
    if (ldap !== undefined && !ldap.running) return ldap.last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The run did not end.");
}

/** The first run, previewed, then applied. */
async function firstRun(test: Test): Promise<Last> {
  expect(await sync(test)).toMatchObject({ outcome: "preview" });
  return sync(test, { confirm: true });
}

async function accounts(test: Test) {
  const { rows } = await test.db.query(
    `SELECT a.user_name, a.external_id, u.name, u.deactivated_at IS NOT NULL AS deactivated,
            coalesce((SELECT array_agg(g.name ORDER BY g.name) FROM group_members gm
                        JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = u.id), '{}') AS groups
       FROM directory_accounts a JOIN users u ON u.id = a.user_id
      ORDER BY a.user_name`,
  );
  return rows.map((row) => ({
    userName: readText(row, "user_name"),
    externalId: readText(row, "external_id"),
    name: readText(row, "name"),
    deactivated: readBoolean(row, "deactivated"),
    groups: row.groups,
  }));
}

describe.skipIf(folder === "")("an Active Directory domain", () => {
  beforeAll(async () => {
    // The service account Nether binds as, with a password of its own.
    const client = await domainAdmin();
    const services = await unit(client, `s${randomUUID().slice(0, 8)}`);
    reader.dn = `CN=nether-reader,${services}`;
    await client.add(reader.dn, [
      new Attribute({
        type: "objectClass",
        values: ["top", "person", "organizationalPerson", "user"],
      }),
      new Attribute({ type: "sAMAccountName", values: [accountName()] }),
      new Attribute({
        type: "unicodePwd",
        values: [Buffer.from(`"${reader.password}"`, "utf16le")],
      }),
      new Attribute({ type: "userAccountControl", values: ["512"] }),
    ]);
    await client.unbind();
  });

  it("is read from an organizational unit by its preset over ldaps:// and StartTLS, the authority pasted", async () => {
    const client = await domainAdmin();
    const ou = await tree(client);
    const ada = await person(client, ou.people, "Ada", ou.tag);
    await person(client, ou.people, "Bea", ou.tag);
    const adaGuid = await objectGuid(client, ada);
    await client.unbind();

    const test = await server();
    await addDomain(test, { peopleBase: ou.base, groupsBase: ou.groups });
    const tested = await admin(test, "POST", "/api/admin/directories/corp/test");
    expect(tested.statusCode, tested.body).toBe(200);
    const sample = tested
      .json<{ people: { userName: string }[] }>()
      .people.sort((a, b) => a.userName.localeCompare(b.userName));
    expect(sample).toMatchObject([
      { dn: ada, id: adaGuid, userName: address("Ada", ou.tag), name: "Ada Person" },
      { userName: address("Bea", ou.tag) },
    ]);
    // StartTLS, the bind password given again for the new address.
    expect((await change(test, { url: startTls, password: reader.password })).statusCode).toBe(200);
    const again = await admin(test, "POST", "/api/admin/directories/corp/test");
    expect(again.statusCode, again.body).toBe(200);

    expect(await firstRun(test)).toMatchObject({ outcome: "applied", counts: { made: 2 } });
    expect(await accounts(test)).toMatchObject([
      { userName: address("Ada", ou.tag), externalId: adaGuid, name: "Ada Person" },
      { userName: address("Bea", ou.tag), deactivated: false },
    ]);
  });

  it("keeps an account by its objectGUID across a rename and a move, and deactivates a disabled one", async () => {
    const client = await domainAdmin();
    const ou = await tree(client);
    const ada = await person(client, ou.people, "Ada", ou.tag);
    const bea = await person(client, ou.people, "Bea", ou.tag);
    const adaGuid = await objectGuid(client, ada);
    const test = await server();
    await addDomain(test, { peopleBase: ou.base, groupsBase: ou.groups });
    expect(await firstRun(test)).toMatchObject({ counts: { made: 2 } });

    // Renamed and moved to another OU, her display name changed with it.
    const moved = `CN=Ada Lovelace,${ou.moved}`;
    await client.modifyDN(ada, moved);
    await replace(client, moved, "displayName", "Ada Lovelace");
    expect(await objectGuid(client, moved)).toBe(adaGuid);
    // Disabled: the preset's filter leaves Bea out.
    await disable(client, bea);
    await client.unbind();

    expect(await sync(test)).toMatchObject({
      outcome: "applied",
      counts: { made: 0, changed: 1, deactivated: 1 },
    });
    expect(await accounts(test)).toMatchObject([
      {
        userName: address("Ada", ou.tag),
        externalId: adaGuid,
        name: "Ada Lovelace",
        deactivated: false,
      },
      { userName: address("Bea", ou.tag), deactivated: true },
    ]);
  });

  it("flattens nested groups through one the filter does not read, and reads 1,600 members through memberOf", async () => {
    const client = await domainAdmin();
    const ou = await tree(client);
    const ada = await person(client, ou.people, "Ada", ou.tag);
    const bea = await person(client, ou.people, "Bea", ou.tag);
    await person(client, ou.people, "Cy", ou.tag);
    // Engineering is not read; it sits inside nether-all.
    const engineering = `CN=Engineering,${ou.groups}`;
    await group(client, engineering, [ada]);
    await group(client, `CN=nether-all,${ou.groups}`, [engineering, bea]);
    // 1,600 people in one group: more than Windows sends of a member at once.
    const many = await unit(client, "Many", ou.people);
    const members: string[] = [];
    for (let at = 0; at < 1600; at += 50) {
      members.push(
        ...(await Promise.all(
          Array.from({ length: 50 }, (_, k) => person(client, many, `P${String(at + k)}`, ou.tag)),
        )),
      );
    }
    await group(client, `CN=nether-many,${ou.groups}`, []);
    for (let at = 0; at < members.length; at += 400) {
      await client.modify(
        `CN=nether-many,${ou.groups}`,
        new Change({
          operation: "add",
          modification: new Attribute({ type: "member", values: members.slice(at, at + 400) }),
        }),
      );
    }
    await client.unbind();

    const test = await server();
    await addDomain(test, { peopleBase: ou.base, groupsBase: ou.groups });
    expect(await firstRun(test)).toMatchObject({
      outcome: "applied",
      counts: { people: 1603, made: 1603, groups: 2, groupsMade: 2, membersAdded: 1602 },
    });
    const read = await accounts(test);
    expect(read.filter((each) => !each.userName.startsWith("p"))).toMatchObject([
      { userName: address("Ada", ou.tag), groups: ["nether-all"] },
      { userName: address("Bea", ou.tag), groups: ["nether-all"] },
      { userName: address("Cy", ou.tag), groups: [] },
    ]);
    expect(read.filter((each) => (each.groups as string[]).includes("nether-many"))).toHaveLength(
      1600,
    );

    // From each group's member list, as Windows would stop: it sends the
    // first 1,500 members as member;range=0-1499, which Nether reads none
    // of. Samba sends all 1,600 at once, so the same read comes out here.
    expect((await change(test, { membership: "member" })).statusCode).toBe(200);
    expect(await sync(test)).toMatchObject({
      outcome: "applied",
      counts: { membersAdded: 0, membersRemoved: 0 },
    });
  }, 300_000);

  it("holds back a large deactivation, and fails at the domain's root on its referrals, changing nothing", async () => {
    const client = await domainAdmin();
    const ou = await tree(client);
    const people = [];
    for (const name of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]) {
      people.push(await person(client, ou.people, name, ou.tag));
    }
    const test = await server();
    await addDomain(test, { peopleBase: ou.base, groupsBase: ou.groups });
    expect(await firstRun(test)).toMatchObject({ counts: { made: 8 } });

    // Seven of eight disabled at once: held, nothing deactivated.
    for (const dn of people.slice(1)) await disable(client, dn);
    await client.unbind();
    const held = await sync(test);
    expect(held).toMatchObject({ outcome: "held", counts: { deactivated: 7 } });
    expect(held.preview?.deactivated).toHaveLength(7);
    expect((await accounts(test)).filter((each) => each.deactivated)).toEqual([]);

    // The domain's root as the base: its partitions answer with referrals.
    expect((await change(test, { peopleBase: domain })).statusCode).toBe(200);
    const failed = await sync(test);
    expect(failed.outcome).toBe("failed");
    expect(failed.failure).toMatch(
      /^The directory sent a referral to ldaps?:\/\/corp\.example\/.*DC=corp,DC=example, and Nether follows none\. Set the base DN to where the entries are, as an organizational unit\.$/,
    );
    expect((await accounts(test)).filter((each) => each.deactivated)).toEqual([]);

    // Looked at, and run anyway from the OU again: the seven go.
    expect((await change(test, { peopleBase: ou.base })).statusCode).toBe(200);
    expect(await sync(test)).toMatchObject({ outcome: "held" });
    expect(await sync(test, { anyway: true })).toMatchObject({
      outcome: "applied",
      counts: { deactivated: 7 },
    });
  });
});

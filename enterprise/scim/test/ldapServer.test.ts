// The LDAP pull against a real directory (ADR 0085): the OpenLDAP of
// test/ldap/, with the memberof and refint overlays, reached by ldaps://
// and by StartTLS with the authority pasted, a wrong authority and a wrong
// fingerprint refused; 2,500 people read in pages; a renamed entry kept by
// its ID; nested groups flattened; someone leaving the filter deactivated;
// a large deactivation held back; and a failed bind changing nothing.
//
// They run when NETHER_TEST_LDAP names the folder the directory wrote its
// authority to, as CI sets it, and are skipped otherwise; the directory
// answers on localhost, ports 1389 and 1636 (test/ldap/Dockerfile).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Attribute, Change, Client } from "ldapts";
import { afterEach, describe, expect, it } from "vitest";
import { readBoolean, readText } from "@nether/server/src/db.ts";
import { LdapFailure, openLdap, searchAll } from "../src/ldapConnect.ts";
import { type Test, admin, start, stop } from "./server.ts";

const folder = process.env.NETHER_TEST_LDAP ?? "";
const read = (name: string) => (folder === "" ? "" : readFileSync(join(folder, name), "utf8"));
const ca = read("ca.pem");
const otherCa = read("other-ca.pem");
const fingerprint = read("fingerprint").trim();

const ldaps = "ldaps://localhost:1636";
const startTls = "ldap://localhost:1389";
const reader = { bindDn: "cn=reader,dc=example,dc=org", password: "reader-password" };

afterEach(stop);

/** The directory's admin, who shapes each test's tree. */
async function directoryAdmin(): Promise<Client> {
  const client = new Client({ url: ldaps, tlsOptions: { ca } });
  await client.bind("cn=admin,dc=example,dc=org", "admin-password");
  return client;
}

/** A tree of the test's own, with these people under ou=people; gives its DN. */
async function tree(client: Client, people: readonly string[]): Promise<string> {
  const name = `t${randomUUID().slice(0, 8)}`;
  const base = `ou=${name},dc=example,dc=org`;
  await client.add(base, { objectClass: "organizationalUnit", ou: name });
  await client.add(`ou=people,${base}`, { objectClass: "organizationalUnit", ou: "people" });
  await client.add(`ou=groups,${base}`, { objectClass: "organizationalUnit", ou: "groups" });
  for (const uid of people) {
    await client.add(`uid=${uid},ou=people,${base}`, {
      objectClass: "inetOrgPerson",
      uid,
      cn: `Person ${uid}`,
      sn: uid,
      mail: `${uid}@corp.example`,
    });
  }
  return base;
}

async function server(): Promise<Test> {
  return start({
    NETHER_SECRET_KEY: Buffer.alloc(32, 9).toString("base64"),
    NETHER_LDAP_PRIVATE: "loopback",
  });
}

async function addLdap(test: Test, base: string, ldap: object = {}) {
  const added = await admin(test, "POST", "/api/admin/directories", {
    id: "corp",
    name: "Corp",
    kind: "ldap",
    domains: ["corp.example", "many.example"],
    ldap: {
      url: ldaps,
      ca,
      ...reader,
      peopleBase: `ou=people,${base}`,
      groupsBase: `ou=groups,${base}`,
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
}

async function sync(test: Test, body: object = {}): Promise<Last> {
  const asked = await admin(test, "POST", "/api/admin/directories/corp/sync", body);
  expect(asked.statusCode, asked.body).toBe(202);
  for (let tries = 0; tries < 2400; tries += 1) {
    const listed = await admin(test, "GET", "/api/admin/directories");
    const ldap = listed.json<{ directories: { ldap: { running: boolean; last: Last } }[] }>()
      .directories[0]?.ldap;
    if (ldap !== undefined && !ldap.running) return ldap.last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The run did not end.");
}

async function people(test: Test) {
  const { rows } = await test.db.query(
    `SELECT a.user_name, a.external_id, u.email, u.deactivated_at IS NOT NULL AS deactivated,
            coalesce((SELECT array_agg(g.name ORDER BY g.name) FROM group_members gm
                        JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = u.id), '{}') AS groups
       FROM directory_accounts a JOIN users u ON u.id = a.user_id
      ORDER BY a.user_name`,
  );
  return rows.map((row) => ({
    userName: readText(row, "user_name"),
    externalId: readText(row, "external_id"),
    deactivated: readBoolean(row, "deactivated"),
    groups: row.groups,
  }));
}

describe.skipIf(folder === "")("a real LDAP directory", () => {
  it("is reached by ldaps and by StartTLS, its certificate checked, a wrong one refused", async () => {
    const client = await directoryAdmin();
    const base = await tree(client, ["ada", "bea"]);
    await client.unbind();
    const test = await server();
    await addLdap(test, base);
    const tested = await admin(test, "POST", "/api/admin/directories/corp/test");
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({
      people: [
        { dn: `uid=ada,ou=people,${base}`, userName: "ada", email: "ada@corp.example" },
        { dn: `uid=bea,ou=people,${base}`, userName: "bea", name: "Person bea" },
      ],
      groups: [],
    });
    const id = (tested.json<{ people: { id: string }[] }>().people[0]?.id ?? "").length;
    expect(id).toBe(36);

    const message = async () => {
      const answer = await admin(test, "POST", "/api/admin/directories/corp/test");
      return answer.statusCode === 200 ? "reached" : answer.json<{ message: string }>().message;
    };
    // StartTLS, the bind password given again for the new address.
    expect((await change(test, { url: startTls, password: reader.password })).statusCode).toBe(200);
    expect(await message()).toBe("reached");
    // Pinned by its fingerprint, by either way.
    expect((await change(test, { ca: null, fingerprint })).statusCode).toBe(200);
    expect(await message()).toBe("reached");
    expect((await change(test, { url: ldaps, password: reader.password })).statusCode).toBe(200);
    expect(await message()).toBe("reached");

    // The wrong fingerprint, the wrong authority, or the system's: refused.
    expect((await change(test, { fingerprint: "AB".repeat(32) })).statusCode).toBe(200);
    expect(await message()).toBe("The directory's certificate is not the one pinned.");
    expect((await change(test, { url: startTls, password: reader.password })).statusCode).toBe(200);
    expect(await message()).toBe("The directory's certificate is not the one pinned.");
    expect((await change(test, { fingerprint: null, ca: otherCa })).statusCode).toBe(200);
    expect(await message()).toContain("Could not start TLS with localhost:1389");
    expect((await change(test, { url: ldaps, password: reader.password })).statusCode).toBe(200);
    expect(await message()).toContain("Could not reach localhost:1636 by TLS");
    expect((await change(test, { ca: null })).statusCode).toBe(200);
    expect(await message()).toContain("Could not reach localhost:1636 by TLS");

    // The wrong password.
    expect((await change(test, { ca, password: "not-the-password" })).statusCode).toBe(200);
    expect(await message()).toBe("The directory refused the bind DN and password.");
  });

  it("fails a run whose connection drops, rather than reconnect without the bind", async () => {
    for (const url of [ldaps, startTls]) {
      const connection = await openLdap(
        { url, ca, fingerprint: null, ...reader },
        reader.password,
        { policy: ["loopback"] },
      );
      const search = {
        base: "dc=example,dc=org",
        filter: "(cn=reader)",
        attributes: ["cn"],
        binary: [],
        what: "the reader",
      };
      expect(await searchAll(connection.client, search)).toHaveLength(1);
      // Dropped: the client would connect again, unbound and, after
      // StartTLS, unencrypted. The socket factory refuses.
      await connection.client.unbind();
      const again = searchAll(connection.client, search);
      await expect(again).rejects.toBeInstanceOf(LdapFailure);
      await expect(again).rejects.toThrow("The connection to the directory dropped");
      await connection.close();
    }
  });

  it("reads 2,500 people in pages, more than one page holds", async () => {
    const test = await server();
    await addLdap(test, "dc=example,dc=org", {
      peopleBase: "ou=many,dc=example,dc=org",
      groupsBase: "ou=many,dc=example,dc=org",
      groupsFilter: "(objectClass=groupOfNames)",
    });
    const preview = await sync(test);
    expect(preview).toMatchObject({
      outcome: "preview",
      counts: { people: 2500, made: 2500, skipped: 0 },
    });
    const applied = await sync(test, { confirm: true });
    expect(applied).toMatchObject({ outcome: "applied", counts: { made: 2500 } });
    const { rows } = await test.db.query("SELECT count(*)::int AS count FROM directory_accounts");
    expect(rows[0]?.count).toBe(2500);
  }, 300_000);

  it("keeps a renamed entry by its ID, flattens nested groups, and deactivates who leaves the filter", async () => {
    const client = await directoryAdmin();
    const base = await tree(client, ["ada", "bea", "cy"]);
    const groups = `ou=groups,${base}`;
    // Ada is in eng, which is in nether-all with Bea; only nether-* is read.
    await client.add(`cn=eng,${groups}`, {
      objectClass: "groupOfNames",
      cn: "eng",
      member: `uid=ada,ou=people,${base}`,
    });
    await client.add(`cn=nether-all,${groups}`, {
      objectClass: "groupOfNames",
      cn: "nether-all",
      member: [`cn=eng,${groups}`, `uid=bea,ou=people,${base}`],
    });
    const test = await server();
    await addLdap(test, base, {
      peopleFilter: "(&(objectClass=inetOrgPerson)(!(employeeType=gone)))",
      groupsFilter: "(cn=nether-*)",
    });
    expect((await sync(test)).outcome).toBe("preview");
    const first = await sync(test, { confirm: true });
    expect(first).toMatchObject({ outcome: "applied", counts: { made: 3, groupsMade: 1 } });
    expect(await people(test)).toMatchObject([
      { userName: "ada", deactivated: false, groups: ["nether-all"] },
      { userName: "bea", deactivated: false, groups: ["nether-all"] },
      { userName: "cy", deactivated: false, groups: [] },
    ]);
    const adaId = (await people(test))[0]?.externalId;

    // The same read from each group's member list.
    expect((await change(test, { membership: "member" })).statusCode).toBe(200);
    expect(await sync(test)).toMatchObject({
      outcome: "applied",
      counts: { changed: 0, membersAdded: 0, membersRemoved: 0 },
    });

    // Ada renamed: the same account, by her entryUUID.
    await client.modifyDN(`uid=ada,ou=people,${base}`, "uid=ada.l");
    // Bea leaves the filter: deactivated, out of her group.
    await client.modify(
      `uid=bea,ou=people,${base}`,
      new Change({
        operation: "add",
        modification: new Attribute({ type: "employeeType", values: ["gone"] }),
      }),
    );
    await client.unbind();
    const later = await sync(test);
    expect(later).toMatchObject({ outcome: "applied", counts: { changed: 1, deactivated: 1 } });
    expect(await people(test)).toMatchObject([
      { userName: "ada.l", externalId: adaId, deactivated: false, groups: ["nether-all"] },
      { userName: "bea", deactivated: true, groups: [] },
      { userName: "cy", deactivated: false, groups: [] },
    ]);
  });

  it("holds back a large deactivation, and changes nothing when the bind fails", async () => {
    const client = await directoryAdmin();
    const base = await tree(client, ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    await client.unbind();
    const test = await server();
    await addLdap(test, base);
    await sync(test);
    expect(await sync(test, { confirm: true })).toMatchObject({ counts: { made: 8 } });

    // A filter that misses most of them: held, nothing deactivated.
    expect((await change(test, { peopleFilter: "(uid=p1)" })).statusCode).toBe(200);
    expect(await sync(test)).toMatchObject({ outcome: "held", counts: { deactivated: 7 } });
    expect((await people(test)).filter((each) => each.deactivated)).toEqual([]);

    // A failed bind: nothing read, nothing changed.
    expect((await change(test, { peopleFilter: "(objectClass=inetOrgPerson)" })).statusCode).toBe(
      200,
    );
    expect((await change(test, { password: "not-the-password" })).statusCode).toBe(200);
    expect(await sync(test)).toMatchObject({
      outcome: "failed",
      failure: "The directory refused the bind DN and password.",
    });
    expect((await people(test)).filter((each) => each.deactivated)).toEqual([]);
  });
});

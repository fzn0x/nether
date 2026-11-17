// What a run makes of what it read (ADR 0085), on fixtures: Active
// Directory's objectGUID as bytes, its preset's filter, DNs compared
// without case, nested groups flattened through the groups between with
// loops ignored, membership read each way, and the entries skipped, with
// why. A group sent in ranges stops the run.
import type { Entry } from "ldapts";
import { FilterParser } from "ldapts";
import { describe, expect, it } from "vitest";
import { LdapFailure } from "../src/ldapConnect.ts";
import { dnKey, guidOf, shapeRead, stableId } from "../src/ldapRead.ts";
import { type LdapSettings, presets } from "../src/ldapSettings.ts";

function settings(overrides: Partial<LdapSettings> = {}): LdapSettings {
  return {
    url: "ldaps://ldap.example.org",
    ca: null,
    fingerprint: null,
    bindDn: "cn=reader,dc=example,dc=org",
    ...presets.openLdap,
    people: { base: "ou=people,dc=example,dc=org", filter: "(objectClass=inetOrgPerson)" },
    groups: { base: "ou=groups,dc=example,dc=org", filter: "(objectClass=groupOfNames)" },
    everyMinutes: 60,
    holdPercent: 10,
    ...overrides,
  };
}

function person(uid: string, extra: Record<string, string | string[]> = {}): Entry {
  return {
    dn: `uid=${uid},ou=people,dc=example,dc=org`,
    entryUUID: `id-${uid}`,
    uid,
    mail: `${uid}@example.org`,
    cn: `Person ${uid}`,
    ...extra,
  };
}

function group(cn: string, extra: Record<string, string | string[]> = {}): Entry {
  return { dn: `cn=${cn},ou=groups,dc=example,dc=org`, entryUUID: `group-${cn}`, cn, ...extra };
}

const groupDn = (cn: string) => `cn=${cn},ou=groups,dc=example,dc=org`;
const noLookup = () => Promise.resolve(undefined);

describe("an LDAP read", () => {
  it("reads Active Directory's objectGUID as a GUID, its first three parts little-endian", () => {
    const bytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    expect(guidOf(bytes)).toBe("33221100-5544-7766-8899-aabbccddeeff");
    const ad = settings({ ...presets.activeDirectory });
    expect(stableId({ dn: "cn=Ada", objectGUID: bytes }, ad)).toBe(
      "33221100-5544-7766-8899-aabbccddeeff",
    );
    // Bytes that happen to be UTF-8 come as text, and read the same.
    const ascii = Buffer.from("ABCDEFGHIJKLMNOP", "latin1");
    expect(stableId({ dn: "cn=Bea", objectGUID: ascii.toString("utf8") }, ad)).toBe(guidOf(ascii));
    // Not 16 bytes: no ID.
    expect(stableId({ dn: "cn=Cy", objectGUID: Buffer.from("0011", "hex") }, ad)).toBeUndefined();
  });

  it("starts Active Directory from its people, leaving out disabled accounts, and its groups", () => {
    const ad = presets.activeDirectory;
    expect(ad.people.filter).toBe(
      "(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))",
    );
    expect(ad.groups.filter).toBe("(objectClass=group)");
    expect(ad.attributes).toMatchObject({
      id: "objectGUID",
      idIsGuid: true,
      userName: "userPrincipalName",
      email: "mail",
      name: ["displayName", "cn"],
    });
    expect(ad.membership).toBe("memberOf");
    // Both presets' filters read as LDAP filters.
    for (const preset of Object.values(presets)) {
      expect(() => FilterParser.parseString(preset.people.filter)).not.toThrow();
      expect(() => FilterParser.parseString(preset.groups.filter)).not.toThrow();
    }
  });

  it("compares DNs without case or the spaces around their parts", () => {
    expect(dnKey("CN=Ada Lovelace, OU=People ,DC=Example,DC=org")).toBe(
      "cn=ada lovelace,ou=people,dc=example,dc=org",
    );
    expect(dnKey("cn=Smith\\, Ada,ou=people")).toBe("cn=smith\\, ada,ou=people");
  });

  it("flattens nested groups from each person's memberOf, through groups between, loops ignored", async () => {
    const looked: string[] = [];
    const between: Record<string, Entry> = {
      // A group the filter does not read, inside a read one, and in a loop.
      [dnKey(groupDn("team"))]: {
        dn: groupDn("team"),
        memberOf: [groupDn("nether-eng"), groupDn("loop")],
      },
      [dnKey(groupDn("loop"))]: { dn: groupDn("loop"), memberOf: groupDn("team") },
    };
    const read = await shapeRead(
      settings(),
      [
        person("ada", { memberOf: [groupDn("team"), groupDn("other")] }),
        person("bea", { memberOf: "CN=Nether-All,OU=Groups,DC=Example,DC=org" }),
        person("cy", { memberOf: groupDn("loop") }),
      ],
      [group("nether-eng", { memberOf: groupDn("nether-all") }), group("nether-all")],
      (dn) => {
        looked.push(dn);
        return Promise.resolve(between[dn]);
      },
    );
    const groupsOf = (uid: string) => read.people.find((each) => each.userName === uid)?.groups;
    expect(groupsOf("ada")).toEqual(["group-nether-all", "group-nether-eng"]);
    expect(groupsOf("bea")).toEqual(["group-nether-all"]);
    expect(groupsOf("cy")).toEqual(["group-nether-all", "group-nether-eng"]);
    // Each group between read once; the groups read are never looked up.
    expect(looked.sort()).toEqual([
      dnKey(groupDn("loop")),
      dnKey(groupDn("other")),
      dnKey(groupDn("team")),
    ]);
  });

  it("reads members from groups' member lists, nested ones too, and from memberUid", async () => {
    const memberOf = settings({ membership: "member" });
    const read = await shapeRead(
      memberOf,
      [person("ada"), person("bea"), person("cy")],
      [
        group("nether-all", {
          member: [groupDn("team"), "UID=ada,OU=people,DC=example,DC=org"],
        }),
      ],
      (dn) =>
        Promise.resolve(
          dn === dnKey(groupDn("team"))
            ? { dn, member: ["uid=bea,ou=people,dc=example,dc=org", groupDn("nether-all")] }
            : undefined,
        ),
    );
    expect(read.people.map((each) => [each.userName, each.groups])).toEqual([
      ["ada", ["group-nether-all"]],
      ["bea", ["group-nether-all"]],
      ["cy", []],
    ]);

    const unique = await shapeRead(
      settings({ membership: "uniqueMember" }),
      [person("ada")],
      [group("nether-all", { uniqueMember: "uid=ada,ou=people,dc=example,dc=org#'0101'B" })],
      noLookup,
    );
    expect(unique.people[0]?.groups).toEqual(["group-nether-all"]);

    const posix = await shapeRead(
      settings({ membership: "memberUid" }),
      [person("ada"), person("bea")],
      [group("nether-all", { memberUid: ["ADA", "nobody"] })],
      noLookup,
    );
    expect(posix.people.map((each) => each.groups)).toEqual([["group-nether-all"], []]);
  });

  it("skips people and groups it cannot provision, saying why, and keeps the skipped people's accounts", async () => {
    const read = await shapeRead(
      settings(),
      [
        person("ada"),
        person("nomail", { mail: [] }),
        person("twin", { uid: "Ada" }),
        { dn: "uid=noid,ou=people,dc=example,dc=org", uid: "noid", mail: "noid@example.org" },
      ],
      [
        group("eng"),
        group("ENG", { entryUUID: "group-eng-2" }),
        { dn: groupDn("nameless"), entryUUID: "g3" },
      ],
      noLookup,
    );
    expect(read.people.map((each) => each.userName)).toEqual(["ada"]);
    expect(read.groups.map((each) => each.name)).toEqual(["eng"]);
    expect(read.skipped).toEqual([
      { dn: groupDn("ENG"), reason: "Another group read is named ENG." },
      { dn: groupDn("nameless"), reason: "It has no cn." },
      { dn: "uid=nomail,ou=people,dc=example,dc=org", reason: "It has no address in mail." },
      {
        dn: "uid=twin,ou=people,dc=example,dc=org",
        reason: "Another person read has the userName Ada.",
      },
      { dn: "uid=noid,ou=people,dc=example,dc=org", reason: "It has no entryUUID." },
    ]);
    expect([...read.kept].sort()).toEqual(["id-nomail", "id-twin"]);
  });

  it("names a group whose members come in ranges, and reads none of it", async () => {
    const ranged = shapeRead(
      settings({ membership: "member" }),
      [person("ada")],
      [group("big", { "member;range=0-1499": ["uid=ada,ou=people,dc=example,dc=org"] })],
      noLookup,
    );
    await expect(ranged).rejects.toBeInstanceOf(LdapFailure);
    await expect(ranged).rejects.toThrow(`${groupDn("big")} sends its member in ranges`);
  });
});

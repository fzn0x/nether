// An LDAP directory's settings (ADR 0085): its address, always encrypted,
// with `ldaps://` or StartTLS on `ldap://`; how its certificate is checked;
// the DN it binds as; where its people and groups are and how their
// attributes read; how often it runs; and when a run holds back. The bind
// password is not among them: it is sealed apart, bound to the directory,
// its address and its DN. Two presets start the console's form, and every
// field stays the admin's.
import { createSecureContext } from "node:tls";
import { FilterParser } from "ldapts";

/** Where a group's members are read: each person's memberOf, or each group's own list. */
export const memberships = ["memberOf", "member", "uniqueMember", "memberUid"] as const;

export type Membership = (typeof memberships)[number];

export interface LdapSettings {
  /** `ldaps://host:port`, or `ldap://host:port` with StartTLS. */
  readonly url: string;
  /** Authorities in PEM to check the certificate with, instead of the system's. */
  readonly ca: string | null;
  /** The certificate's SHA-256 fingerprint, trusted whoever signed it. */
  readonly fingerprint: string | null;
  readonly bindDn: string;
  readonly people: { readonly base: string; readonly filter: string };
  readonly groups: { readonly base: string; readonly filter: string };
  readonly attributes: {
    /** A person's and a group's stable ID, which renaming or moving keeps. */
    readonly id: string;
    /** Whether the ID is 16 bytes read as a GUID, as Active Directory's objectGUID. */
    readonly idIsGuid: boolean;
    readonly userName: string;
    readonly email: string;
    /** Where a person's name is read, the first that has one. */
    readonly name: readonly string[];
    readonly groupName: string;
  };
  readonly membership: Membership;
  /** Minutes between runs, from 15 to a day. */
  readonly everyMinutes: number;
  /** The share of the directory's active accounts a run may deactivate before it holds back. */
  readonly holdPercent: number;
}

export const presetNames = ["activeDirectory", "openLdap"] as const;

export type PresetName = (typeof presetNames)[number];

/** What a preset fills in: everything but the address, the bind DN and the bases. */
export type Preset = Pick<LdapSettings, "people" | "groups" | "attributes" | "membership">;

export const presets: Readonly<Record<PresetName, Preset>> = {
  activeDirectory: {
    // People, leaving out disabled accounts: bit 2 of userAccountControl.
    people: {
      base: "",
      filter:
        "(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))",
    },
    groups: { base: "", filter: "(objectClass=group)" },
    attributes: {
      id: "objectGUID",
      idIsGuid: true,
      userName: "userPrincipalName",
      email: "mail",
      name: ["displayName", "cn"],
      groupName: "cn",
    },
    membership: "memberOf",
  },
  openLdap: {
    people: { base: "", filter: "(objectClass=inetOrgPerson)" },
    groups: { base: "", filter: "(objectClass=groupOfNames)" },
    attributes: {
      id: "entryUUID",
      idIsGuid: false,
      userName: "uid",
      email: "mail",
      name: ["displayName", "cn"],
      groupName: "cn",
    },
    membership: "memberOf",
  },
};

export const defaultEveryMinutes = 60;
export const leastEveryMinutes = 15;
export const mostEveryMinutes = 1440;
export const defaultHoldPercent = 10;

/** An address as a connection reads it. */
export interface LdapAddress {
  readonly host: string;
  readonly port: number;
  /** Whether TLS starts at once, as `ldaps://`; else StartTLS follows the connection. */
  readonly secure: boolean;
}

/** A setting refused, saying what to change. */
export class SettingRefused extends Error {
  override readonly name = "SettingRefused";
}

/** The address of an `ldaps://` or `ldap://` URL with a host and maybe a port, and nothing else. */
export function addressOf(text: string): LdapAddress {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new SettingRefused("The address is ldaps://host or ldap://host, with a port if needed.");
  }
  const secure = url.protocol === "ldaps:";
  if (!secure && url.protocol !== "ldap:") {
    throw new SettingRefused("The address is ldaps://host or ldap://host, with a port if needed.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SettingRefused("The address holds no user or password: give the bind DN apart.");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new SettingRefused("The address is the host and port alone: give the base DNs apart.");
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "") throw new SettingRefused("The address has no host.");
  return { host, port: url.port === "" ? (secure ? 636 : 389) : Number(url.port), secure };
}

/** A SHA-256 fingerprint as Node gives it: upper-case hex pairs joined by colons. */
export function fingerprintOf(text: string): string {
  const hex = text.replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new SettingRefused(
      "A certificate's SHA-256 fingerprint is 64 hex digits, colons allowed.",
    );
  }
  return (hex.match(/../g) ?? []).join(":");
}

/** Authorities in PEM, as TLS reads them. */
export function authoritiesOf(text: string): string {
  const pem = text.trim();
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new SettingRefused("A certificate authority is one or more certificates in PEM.");
  }
  try {
    createSecureContext({ ca: pem });
  } catch {
    throw new SettingRefused("The certificate authority does not read as certificates in PEM.");
  }
  return pem;
}

/** A search filter, checked as LDAP reads it (RFC 4515). */
export function filterOf(text: string, what: string): string {
  const filter = text.trim();
  try {
    FilterParser.parseString(filter);
  } catch (error) {
    const why = error instanceof Error ? `: ${error.message}` : "";
    throw new SettingRefused(`The ${what} filter does not read as an LDAP filter${why}.`);
  }
  return filter;
}

const attributePattern = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)$/;

/** An attribute's name, as `mail` or its OID. */
export function attributeOf(text: string, what: string): string {
  const name = text.trim();
  if (!attributePattern.test(name) || name.length > 100) {
    throw new SettingRefused(`${what} is an attribute's name, as mail.`);
  }
  return name;
}

/** A DN as given, trimmed; checked by the directory when it is read. */
export function dnOf(text: string, what: string): string {
  const dn = text.trim();
  if (dn === "" || dn.length > 1000) throw new SettingRefused(`Give the ${what}.`);
  return dn;
}

/** What the console sends of an LDAP directory's settings: each field when it changes. */
export interface LdapInput {
  readonly url?: string;
  readonly ca?: string | null;
  readonly fingerprint?: string | null;
  readonly bindDn?: string;
  readonly peopleBase?: string;
  readonly peopleFilter?: string;
  readonly groupsBase?: string;
  readonly groupsFilter?: string;
  readonly idAttribute?: string;
  readonly idIsGuid?: boolean;
  readonly userNameAttribute?: string;
  readonly emailAttribute?: string;
  readonly nameAttributes?: readonly string[];
  readonly groupNameAttribute?: string;
  readonly membership?: Membership;
  readonly everyMinutes?: number;
  readonly holdPercent?: number;
}

/** The JSON schema of what the console sends; `settingsOf` checks the rest. */
export const ldapInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1, maxLength: 300 },
    ca: { type: ["string", "null"], maxLength: 100_000 },
    fingerprint: { type: ["string", "null"], maxLength: 200 },
    bindDn: { type: "string", minLength: 1, maxLength: 1000 },
    password: { type: "string", minLength: 1, maxLength: 1000 },
    peopleBase: { type: "string", minLength: 1, maxLength: 1000 },
    peopleFilter: { type: "string", minLength: 1, maxLength: 2000 },
    groupsBase: { type: "string", minLength: 1, maxLength: 1000 },
    groupsFilter: { type: "string", minLength: 1, maxLength: 2000 },
    idAttribute: { type: "string", minLength: 1, maxLength: 100 },
    idIsGuid: { type: "boolean" },
    userNameAttribute: { type: "string", minLength: 1, maxLength: 100 },
    emailAttribute: { type: "string", minLength: 1, maxLength: 100 },
    nameAttributes: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    groupNameAttribute: { type: "string", minLength: 1, maxLength: 100 },
    membership: { type: "string", enum: memberships },
    everyMinutes: { type: "integer", minimum: leastEveryMinutes, maximum: mostEveryMinutes },
    holdPercent: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

/**
 * The settings `input` makes of those kept, or of the OpenLDAP preset for
 * a new directory, each field checked; a refusal says what to change.
 */
export function settingsOf(input: LdapInput, kept: LdapSettings | undefined): LdapSettings {
  const base = kept ?? newSettings();
  const given = <T>(value: T | undefined, fallback: T): T => value ?? fallback;
  const url = input.url === undefined ? base.url : input.url.trim();
  addressOf(url);
  const ca =
    input.ca === undefined
      ? base.ca
      : input.ca === null || input.ca.trim() === ""
        ? null
        : authoritiesOf(input.ca);
  const fingerprint =
    input.fingerprint === undefined
      ? base.fingerprint
      : input.fingerprint === null || input.fingerprint.trim() === ""
        ? null
        : fingerprintOf(input.fingerprint);
  if (ca !== null && fingerprint !== null) {
    throw new SettingRefused("Trust a certificate authority or pin a fingerprint, not both.");
  }
  const attributes = base.attributes;
  const names = input.nameAttributes?.map((name) => attributeOf(name, "A name's attribute"));
  return {
    url,
    ca,
    fingerprint,
    bindDn: dnOf(given(input.bindDn, base.bindDn), "bind DN"),
    people: {
      base: dnOf(given(input.peopleBase, base.people.base), "people's base DN"),
      filter: filterOf(given(input.peopleFilter, base.people.filter), "people's"),
    },
    groups: {
      base: dnOf(given(input.groupsBase, base.groups.base), "groups' base DN"),
      filter: filterOf(given(input.groupsFilter, base.groups.filter), "groups'"),
    },
    attributes: {
      id: attributeOf(given(input.idAttribute, attributes.id), "The stable ID"),
      idIsGuid: given(input.idIsGuid, attributes.idIsGuid),
      userName: attributeOf(given(input.userNameAttribute, attributes.userName), "The userName"),
      email: attributeOf(given(input.emailAttribute, attributes.email), "The address"),
      name: names ?? attributes.name,
      groupName: attributeOf(
        given(input.groupNameAttribute, attributes.groupName),
        "A group's name",
      ),
    },
    membership: given(input.membership, base.membership),
    everyMinutes: given(input.everyMinutes, base.everyMinutes),
    holdPercent: given(input.holdPercent, base.holdPercent),
  };
}

/** A new directory's settings before the admin's: OpenLDAP's preset, with nothing to reach. */
function newSettings(): LdapSettings {
  return {
    url: "",
    ca: null,
    fingerprint: null,
    bindDn: "",
    ...presets.openLdap,
    everyMinutes: defaultEveryMinutes,
    holdPercent: defaultHoldPercent,
  };
}

/** Settings as kept in a directory's row, or undefined when they do not read as such. */
export function keptSettings(value: unknown): LdapSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kept = value as Partial<LdapSettings>;
  if (typeof kept.url !== "string" || typeof kept.bindDn !== "string") return undefined;
  if (kept.people === undefined || kept.groups === undefined || kept.attributes === undefined) {
    return undefined;
  }
  return { ...newSettings(), ...kept };
}

/** What a sealed bind password is bound to: the directory, its address and its DN. */
export function passwordOwner(id: string, settings: Pick<LdapSettings, "url" | "bindDn">): string {
  return JSON.stringify(["ldap", id, settings.url, settings.bindDn]);
}

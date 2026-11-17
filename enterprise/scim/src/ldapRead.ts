// What a run reads of an LDAP directory (ADR 0085): its people and its
// groups, each known by a stable ID that renaming or moving keeps, and who
// is in each group. Membership is read from each person's memberOf by
// default, or from each group's member, uniqueMember or memberUid. Nested
// groups are flattened: a group inside a read one gives it its members, to
// any depth, loops ignored, the groups between read by their DNs. An entry
// that cannot be provisioned, as a person with no address, is skipped and
// named; an attribute that comes in ranges stops the run, naming it, as a
// group read in part would drop its members.
import type { Client, Entry } from "ldapts";
import { LdapFailure, readEntry, searchAll } from "./ldapConnect.ts";
import type { LdapSettings } from "./ldapSettings.ts";

/** A person as read. */
export interface ReadPerson {
  readonly id: string;
  readonly dn: string;
  readonly userName: string;
  readonly email: string;
  readonly name: string | null;
  /** The stable IDs of the read groups it is in, nesting followed. */
  readonly groups: readonly string[];
}

/** A group as read. */
export interface ReadGroup {
  readonly id: string;
  readonly dn: string;
  readonly name: string;
}

/** An entry left out, and why. */
export interface Skip {
  readonly dn: string;
  readonly reason: string;
}

export interface DirectoryRead {
  readonly people: readonly ReadPerson[];
  readonly groups: readonly ReadGroup[];
  readonly skipped: readonly Skip[];
  /** Stable IDs of people skipped, whose accounts stay as they are. */
  readonly kept: ReadonlySet<string>;
}

/** Reads one entry by its DN, with the attribute that nests groups; undefined when there is none. */
export type Lookup = (dn: string) => Promise<Entry | undefined>;

/** Entries looked up at once, as the groups between read ones are. */
const lookupsAtOnce = 16;

/** A GUID as Active Directory's objectGUID holds it: its first three parts little-endian. */
export function guidOf(bytes: Uint8Array): string {
  const part = (start: number, end: number, flip: boolean) => {
    const slice = [...bytes.subarray(start, end)];
    if (flip) slice.reverse();
    return Buffer.from(slice).toString("hex");
  };
  return [
    part(0, 4, true),
    part(4, 6, true),
    part(6, 8, true),
    part(8, 10, false),
    part(10, 16, false),
  ].join("-");
}

/**
 * A DN as compared: each part's type and value trimmed, without regard to
 * case, so `CN=Ada, OU=People` and `cn=ada,ou=people` are one.
 */
export function dnKey(dn: string): string {
  return dn
    .split(/(?<!\\),/)
    .map((part) =>
      part
        .split(/(?<!\\)\+/)
        .map((pair) => {
          const at = pair.indexOf("=");
          return at < 0
            ? pair.trim().toLowerCase()
            : `${pair.slice(0, at).trim().toLowerCase()}=${pair
                .slice(at + 1)
                .trim()
                .toLowerCase()}`;
        })
        .join("+"),
    )
    .join(",");
}

/** An attribute's values, its name read without regard to case; ranged values stop the run. */
export function valuesOf(entry: Entry, name: string): (string | Buffer)[] {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(entry)) {
    if (key === "dn") continue;
    const type = key.toLowerCase();
    if (type.startsWith(`${lower};range=`)) {
      throw new LdapFailure(
        `${entry.dn} sends its ${name} in ranges, more values than the directory sends at once, and Nether reads no group in part. Read membership another way: from each person's memberOf, or from groups with fewer members.`,
      );
    }
    if (type !== lower) continue;
    return Array.isArray(value) ? value : [value];
  }
  return [];
}

/** An attribute's text values, trimmed, empty ones left out. */
export function textsOf(entry: Entry, name: string): string[] {
  return valuesOf(entry, name)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** An entry's stable ID, as text, or undefined when it has none that reads. */
export function stableId(entry: Entry, settings: LdapSettings): string | undefined {
  const [value] = valuesOf(entry, settings.attributes.id);
  if (value === undefined) return undefined;
  if (!settings.attributes.idIsGuid) {
    const text = typeof value === "string" ? value.trim() : value.toString("hex");
    return text === "" ? undefined : text;
  }
  // Bytes that read as UTF-8 came as text: as UTF-8, they are the same bytes.
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return bytes.length === 16 ? guidOf(bytes) : undefined;
}

/** A uniqueMember's DN, without the optional unique identifier after `#`. */
function memberDn(value: string, membership: LdapSettings["membership"]): string {
  return membership === "uniqueMember" ? value.replace(/#'[01]*'B$/, "") : value;
}

/** Runs `work` on each item, a few at once. */
async function eachAtOnce<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += lookupsAtOnce) {
    await Promise.all(items.slice(start, start + lookupsAtOnce).map(work));
  }
}

/**
 * Follows `next` from each key, to any depth, ignoring loops, looking up
 * the keys it does not know a level at a time; gives what reaches every
 * key reached from one, its own included.
 */
async function closure(
  starts: Iterable<string>,
  next: Map<string, readonly string[]>,
  lookUp: (keys: readonly string[]) => Promise<void>,
): Promise<(key: string) => ReadonlySet<string>> {
  const seen = new Set<string>(starts);
  for (let level = [...seen]; level.length > 0;) {
    await lookUp(level.filter((key) => !next.has(key)));
    const more: string[] = [];
    for (const key of level) {
      for (const each of next.get(key) ?? []) {
        if (seen.has(each)) continue;
        seen.add(each);
        more.push(each);
      }
    }
    level = more;
  }
  const memo = new Map<string, ReadonlySet<string>>();
  return (start) => {
    const found = memo.get(start);
    if (found !== undefined) return found;
    const reached = new Set<string>([start]);
    const stack = [start];
    for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
      for (const each of next.get(key) ?? []) {
        if (reached.has(each)) continue;
        reached.add(each);
        stack.push(each);
      }
    }
    memo.set(start, reached);
    return reached;
  };
}

/**
 * Shapes what a run read: the people and groups to provision, each
 * person's groups with nesting followed, and what was skipped, with why.
 * `lookup` reads a group between read ones by its DN.
 */
export async function shapeRead(
  settings: LdapSettings,
  peopleEntries: readonly Entry[],
  groupEntries: readonly Entry[],
  lookup: Lookup,
): Promise<DirectoryRead> {
  const { attributes, membership } = settings;
  const skipped: Skip[] = [];
  const kept = new Set<string>();

  // Groups, each once by its ID and its name.
  const groups: ReadGroup[] = [];
  const groupByDn = new Map<string, ReadGroup>();
  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  for (const entry of groupEntries) {
    const id = stableId(entry, settings);
    const [name] = textsOf(entry, attributes.groupName);
    if (id === undefined) {
      skipped.push({ dn: entry.dn, reason: `It has no ${attributes.id}.` });
    } else if (name === undefined) {
      skipped.push({ dn: entry.dn, reason: `It has no ${attributes.groupName}.` });
    } else if (groupIds.has(id)) {
      skipped.push({ dn: entry.dn, reason: "Another group read has its ID." });
    } else if (groupNames.has(name.toLowerCase())) {
      skipped.push({ dn: entry.dn, reason: `Another group read is named ${name}.` });
    } else {
      const group = { id, dn: entry.dn, name };
      groups.push(group);
      groupByDn.set(dnKey(entry.dn), group);
      groupIds.add(id);
      groupNames.add(name.toLowerCase());
    }
  }

  // People, each once by its ID and its userName, with an address.
  interface Person extends Omit<ReadPerson, "groups"> {
    readonly entry: Entry;
  }
  const people: Person[] = [];
  const personIds = new Set<string>();
  const userNames = new Set<string>();
  for (const entry of peopleEntries) {
    const id = stableId(entry, settings);
    const [userName] = textsOf(entry, attributes.userName);
    const [email] = textsOf(entry, attributes.email);
    const name =
      attributes.name.map((each) => textsOf(entry, each)[0]).find((each) => each !== undefined) ??
      null;
    if (id === undefined) {
      skipped.push({ dn: entry.dn, reason: `It has no ${attributes.id}.` });
      continue;
    }
    if (personIds.has(id)) {
      skipped.push({ dn: entry.dn, reason: "Another person read has its ID." });
      continue;
    }
    personIds.add(id);
    if (userName === undefined) {
      kept.add(id);
      skipped.push({ dn: entry.dn, reason: `It has no ${attributes.userName}.` });
    } else if (userNames.has(userName.toLowerCase())) {
      kept.add(id);
      skipped.push({ dn: entry.dn, reason: `Another person read has the userName ${userName}.` });
    } else if (email === undefined) {
      kept.add(id);
      skipped.push({ dn: entry.dn, reason: `It has no address in ${attributes.email}.` });
    } else {
      userNames.add(userName.toLowerCase());
      people.push({ id, dn: entry.dn, userName, email, name, entry });
    }
  }

  // Who is in each group, nesting followed.
  const groupsOf = new Map<Person, Set<string>>();
  const join = (person: Person, group: ReadGroup) => {
    const set = groupsOf.get(person) ?? new Set<string>();
    set.add(group.id);
    groupsOf.set(person, set);
  };
  if (membership === "memberOf") {
    // Upward: a group's parents are the groups its memberOf names.
    const parents = new Map<string, readonly string[]>();
    for (const entry of groupEntries) {
      parents.set(
        dnKey(entry.dn),
        textsOf(entry, "memberOf").map((dn) => dnKey(dn)),
      );
    }
    const direct = new Map<Person, string[]>(
      people.map((person) => [person, textsOf(person.entry, "memberOf").map((dn) => dnKey(dn))]),
    );
    const reach = await closure([...direct.values()].flat(), parents, (keys) =>
      eachAtOnce(keys, async (key) => {
        const entry = await lookup(key);
        parents.set(key, entry === undefined ? [] : textsOf(entry, "memberOf").map(dnKey));
      }),
    );
    for (const [person, dns] of direct) {
      for (const dn of dns) {
        for (const key of reach(dn)) {
          const group = groupByDn.get(key);
          if (group !== undefined) join(person, group);
        }
      }
    }
  } else if (membership === "memberUid") {
    // By userName, as a posixGroup names its members: no nesting.
    const byUserName = new Map(people.map((person) => [person.userName.toLowerCase(), person]));
    for (const entry of groupEntries) {
      const group = groupByDn.get(dnKey(entry.dn));
      if (group === undefined) continue;
      for (const uid of textsOf(entry, "memberUid")) {
        const person = byUserName.get(uid.toLowerCase());
        if (person !== undefined) join(person, group);
      }
    }
  } else {
    // Downward: a group's children are the DNs its member list names.
    const children = new Map<string, readonly string[]>();
    const childrenOf = (entry: Entry) =>
      textsOf(entry, membership).map((value) => dnKey(memberDn(value, membership)));
    for (const entry of groupEntries) children.set(dnKey(entry.dn), childrenOf(entry));
    const personByDn = new Map(people.map((person) => [dnKey(person.dn), person]));
    // A person read has no members, and is looked up never.
    for (const key of personByDn.keys()) children.set(key, []);
    const reach = await closure([...groupByDn.keys()], children, (keys) =>
      eachAtOnce(keys, async (key) => {
        const entry = await lookup(key);
        children.set(key, entry === undefined ? [] : childrenOf(entry));
      }),
    );
    for (const [key, group] of groupByDn) {
      for (const each of reach(key)) {
        const person = personByDn.get(each);
        if (person !== undefined) join(person, group);
      }
    }
  }

  return {
    people: people.map((person) => ({
      id: person.id,
      dn: person.dn,
      userName: person.userName,
      email: person.email,
      name: person.name,
      groups: [...(groupsOf.get(person) ?? [])].sort(),
    })),
    groups,
    skipped,
    kept,
  };
}

/** The attributes a run reads of people, of groups, and of the groups between. */
export function attributesRead(settings: LdapSettings): {
  readonly people: readonly string[];
  readonly groups: readonly string[];
  readonly nesting: string;
  readonly binary: readonly string[];
} {
  const { attributes, membership } = settings;
  const nesting = membership === "memberOf" ? "memberOf" : membership;
  const unique = (names: readonly string[]) => [...new Set(names)];
  return {
    people: unique([
      attributes.id,
      attributes.userName,
      attributes.email,
      ...attributes.name,
      ...(membership === "memberOf" ? ["memberOf"] : []),
    ]),
    groups: unique([attributes.id, attributes.groupName, nesting]),
    nesting,
    binary: attributes.idIsGuid ? [attributes.id] : [],
  };
}

/** Reads every person and group the settings name, in pages, and shapes them. */
export async function readDirectory(
  client: Client,
  settings: LdapSettings,
  stopped: () => boolean = () => false,
): Promise<DirectoryRead> {
  const read = attributesRead(settings);
  const people = await searchAll(
    client,
    {
      base: settings.people.base,
      filter: settings.people.filter,
      attributes: read.people,
      binary: read.binary,
      what: "people",
    },
    stopped,
  );
  const groups = await searchAll(
    client,
    {
      base: settings.groups.base,
      filter: settings.groups.filter,
      attributes: read.groups,
      binary: read.binary,
      what: "groups",
    },
    stopped,
  );
  return shapeRead(settings, people, groups, (dn) => readEntry(client, dn, [read.nesting]));
}

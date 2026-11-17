// A SCIM user as Nether keeps it (ADR 0085): its userName and externalId,
// its name, displayName and emails as the directory sent them, and whether
// it is active. What else a directory sends, as phone numbers, addresses,
// a title or the enterprise extension, is accepted and dropped, since
// Entra ID's documented mappings send it; `password` is never kept. A
// `PUT` replaces what is kept; a `PATCH` applies every operation, in
// both providers' forms, or none.
import { ScimError } from "./errors.ts";
import { type AttrPath, type Comparison, parsePath, pathText } from "./paths.ts";

/** A user's `name`, by the sub-attributes kept. */
export type NameDoc = Partial<Record<(typeof nameParts)[number], string>>;

export interface EmailDoc {
  readonly value?: string;
  readonly type?: string;
  readonly primary?: boolean;
  readonly display?: string;
}

export interface UserDoc {
  readonly userName: string;
  readonly externalId: string | null;
  readonly displayName: string | null;
  readonly name: NameDoc;
  readonly emails: readonly EmailDoc[];
  readonly active: boolean;
}

export const nameParts = [
  "formatted",
  "familyName",
  "givenName",
  "middleName",
  "honorificPrefix",
  "honorificSuffix",
] as const;

const emailParts = ["value", "type", "primary", "display"] as const;

/** Longest text kept in any attribute: an address is 320 at most. */
const textLimit = 1000;

export const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function invalid(detail: string): ScimError {
  return new ScimError(400, detail, "invalidValue");
}

/** An object's member by a name read without regard to case. */
export function member(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const lower = name.toLowerCase();
  for (const [key, each] of Object.entries(value)) {
    if (key.toLowerCase() === lower) return each;
  }
  return undefined;
}

/** A boolean, or one sent as a string, as Entra ID sends "False", in any case. */
export function toBoolean(value: unknown, what: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  throw invalid(`${what} is true or false.`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw invalid(`${what} is text.`);
  if (value.length > textLimit) throw invalid(`${what} is longer than Nether keeps.`);
  return value;
}

function textOrNull(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : text(value, what);
}

function canonical<T extends string>(names: readonly T[], lower: string): T | undefined {
  return names.find((name) => name.toLowerCase() === lower);
}

/** A `name` as kept: its known sub-attributes, as text. */
export function nameOf(value: unknown): NameDoc {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("name is an object.");
  const name: Record<string, string> = {};
  for (const [key, each] of Object.entries(value)) {
    const part = canonical(nameParts, key.toLowerCase());
    if (part === undefined || each === null || each === undefined) continue;
    name[part] = text(each, `name.${part}`);
  }
  return name;
}

function emailOf(value: unknown): EmailDoc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Each of emails is an object.");
  }
  const email: { value?: string; type?: string; primary?: boolean; display?: string } = {};
  for (const [key, each] of Object.entries(value)) {
    const part = canonical(emailParts, key.toLowerCase());
    if (part === undefined || each === null || each === undefined) continue;
    if (part === "primary") email.primary = toBoolean(each, "emails.primary");
    else email[part] = text(each, `emails.${part}`);
  }
  return email;
}

/** `emails` as kept, from an array or a single object; one primary at most. */
export function emailsOf(value: unknown): EmailDoc[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return onePrimary(list.map(emailOf));
}

/** Keeps the last email marked primary as the only one. */
function onePrimary(emails: readonly EmailDoc[]): EmailDoc[] {
  const last = emails.findLastIndex((email) => email.primary === true);
  return emails.map((email, at) =>
    email.primary === true && at !== last ? { ...email, primary: false } : email,
  );
}

/**
 * A user from a resource as `POST` or `PUT` sends it: `userName` is
 * required; `active` is as sent, else `keptActive`, so a `PUT` that leaves
 * it out reactivates no one.
 */
export function docFromResource(body: unknown, keptActive: boolean): UserDoc {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ScimError(400, "A user is a JSON object.", "invalidSyntax");
  }
  const userName = member(body, "userName");
  if (typeof userName !== "string" || userName.trim() === "") {
    throw invalid("Give the user a userName.");
  }
  const active = member(body, "active");
  return {
    userName: text(userName.trim(), "userName"),
    externalId: textOrNull(member(body, "externalId"), "externalId"),
    displayName: textOrNull(member(body, "displayName"), "displayName"),
    name: nameOf(member(body, "name")),
    emails: emailsOf(member(body, "emails")),
    active: active === undefined || active === null ? keptActive : toBoolean(active, "active"),
  };
}

type Op = "add" | "replace" | "remove";

/** Whether an email matches a value filter, as `type eq "work"`; text compared without regard to case. */
function matches(email: EmailDoc, filter: readonly Comparison[]): boolean {
  return filter.every(({ path, value }) => {
    const part = canonical(emailParts, path.attr);
    if (part === undefined) return false;
    const own = email[part];
    if (typeof own === "string" && typeof value === "string") {
      return own.toLowerCase() === value.toLowerCase();
    }
    return own === value;
  });
}

/** What a value filter makes, when it matches nothing and a value is set: its own sub-attributes. */
function madeFrom(filter: readonly Comparison[]): EmailDoc {
  let email: EmailDoc = {};
  for (const { path, value } of filter) {
    const part = canonical(emailParts, path.attr);
    if (part === undefined || value === null) continue;
    email =
      part === "primary"
        ? { ...email, primary: toBoolean(value, "emails.primary") }
        : { ...email, [part]: String(value) };
  }
  return email;
}

/** An object without one of its members. */
function without<T extends object>(value: T, key: string): T {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as T;
}

function setEmailPart(email: EmailDoc, sub: string, value: unknown, op: Op): EmailDoc {
  const part = canonical(emailParts, sub);
  if (part === undefined) return email;
  if (op === "remove" || value === null) return without(email, part);
  if (part === "primary") return { ...email, primary: toBoolean(value, "emails.primary") };
  return { ...email, [part]: text(value, `emails.${part}`) };
}

function applyEmails(doc: UserDoc, path: AttrPath, op: Op, value: unknown): UserDoc {
  const { filter, sub } = path;
  if (filter === undefined) {
    if (sub !== undefined) {
      // emails.value with no filter: the primary address, else the first.
      if (op === "remove") return { ...doc, emails: [] };
      const at = Math.max(
        0,
        doc.emails.findIndex((email) => email.primary === true),
      );
      const current = doc.emails[at] ?? {};
      const emails = [...doc.emails];
      emails[at] = setEmailPart(current, sub, value, op);
      return { ...doc, emails: onePrimary(emails) };
    }
    if (op === "remove") return { ...doc, emails: [] };
    const sent = emailsOf(value);
    if (op === "replace") return { ...doc, emails: sent };
    // Added: one with the same address is replaced, the others kept.
    const same = (a: EmailDoc, b: EmailDoc) =>
      a.value !== undefined && a.value.toLowerCase() === b.value?.toLowerCase();
    const kept = doc.emails.filter((email) => !sent.some((each) => same(each, email)));
    const merged = sent.some((email) => email.primary === true)
      ? kept.map((email) => ({ ...email, primary: false }))
      : kept;
    return { ...doc, emails: onePrimary([...merged, ...sent]) };
  }
  const hit = doc.emails.some((email) => matches(email, filter));
  if (op === "remove") {
    if (sub === undefined || sub === "value") {
      return { ...doc, emails: doc.emails.filter((email) => !matches(email, filter)) };
    }
    return {
      ...doc,
      emails: doc.emails.map((email) =>
        matches(email, filter) ? setEmailPart(email, sub, null, op) : email,
      ),
    };
  }
  // Set where it matches; where nothing does, as Entra ID's work address on
  // a user made without a type, it is made from the filter.
  const set = (email: EmailDoc): EmailDoc => {
    if (sub !== undefined) return setEmailPart(email, sub, value, op);
    const sent = emailOf(value);
    return op === "replace" ? { ...madeFrom(filter), ...sent } : { ...email, ...sent };
  };
  const emails = hit
    ? doc.emails.map((email) => (matches(email, filter) ? set(email) : email))
    : [...doc.emails, set(madeFrom(filter))];
  return { ...doc, emails: onePrimary(emails) };
}

function applyName(doc: UserDoc, sub: string | undefined, op: Op, value: unknown): UserDoc {
  if (sub === undefined) {
    if (op === "remove") return { ...doc, name: {} };
    const sent = nameOf(value);
    return { ...doc, name: op === "replace" ? sent : { ...doc.name, ...sent } };
  }
  const part = canonical(nameParts, sub);
  if (part === undefined) return doc;
  const rest = without(doc.name, part);
  if (op === "remove" || value === null) return { ...doc, name: rest };
  return { ...doc, name: { ...rest, [part]: text(value, `name.${part}`) } };
}

/** Applies one operation at a path to a user. */
function applyAt(doc: UserDoc, path: AttrPath, op: Op, value: unknown): UserDoc {
  // The enterprise extension, and other schemas' attributes, are not kept.
  if (path.schema === "enterprise" || path.schema === "other" || path.attr === "") return doc;
  switch (path.attr) {
    case "active":
      // Removing it leaves it as it is: only false deactivates.
      return op === "remove" ? doc : { ...doc, active: toBoolean(value, "active") };
    case "username":
      if (op === "remove") throw new ScimError(400, "A user keeps its userName.", "mutability");
      if (typeof value !== "string" || value.trim() === "") throw invalid("userName is text.");
      return { ...doc, userName: text(value.trim(), "userName") };
    case "externalid":
      return { ...doc, externalId: op === "remove" ? null : textOrNull(value, "externalId") };
    case "displayname":
      return { ...doc, displayName: op === "remove" ? null : textOrNull(value, "displayName") };
    case "name":
      return applyName(doc, path.sub, op, value);
    case "emails":
      return applyEmails(doc, path, op, value);
    default:
      // What Nether does not keep, as phoneNumbers, title, password, or the
      // read-only groups, id and meta: accepted, and dropped.
      return doc;
  }
}

/** One operation of a PATCH, as sent. */
interface Operation {
  readonly op: Op;
  readonly path: string | undefined;
  readonly value: unknown;
}

/** A PATCH's operations, with `op` read without regard to case, as Entra ID capitalizes it. */
export function operationsOf(body: unknown): Operation[] {
  const list = member(body, "Operations");
  if (!Array.isArray(list) || list.length === 0) {
    throw new ScimError(400, "A PATCH has Operations, one or more.", "invalidSyntax");
  }
  return list.map((each: unknown) => {
    const op = member(each, "op");
    const lower = typeof op === "string" ? op.toLowerCase() : "";
    if (lower !== "add" && lower !== "replace" && lower !== "remove") {
      throw new ScimError(400, "Each operation's op is add, replace or remove.", "invalidSyntax");
    }
    const path = member(each, "path");
    if (path !== undefined && path !== null && typeof path !== "string") {
      throw new ScimError(400, "An operation's path is text.", "invalidPath");
    }
    return {
      op: lower,
      path: typeof path === "string" && path.trim() !== "" ? path : undefined,
      value: member(each, "value"),
    };
  });
}

/**
 * Applies a PATCH's operations to a user, all or none: a path, a path with
 * a value filter, or no path with an object whose keys are attributes or
 * paths, as `{"active": false}` or `{"name.givenName": "Ada"}`.
 */
export function applyPatch(doc: UserDoc, operations: readonly Operation[]): UserDoc {
  let next = doc;
  for (const { op, path, value } of operations) {
    if (path !== undefined) {
      const parsed = parsePath(path);
      if (op !== "remove" && value === undefined) {
        throw invalid(`The ${op} at ${pathText(parsed)} has no value.`);
      }
      next = applyAt(next, parsed, op, value);
      continue;
    }
    if (op === "remove") {
      throw new ScimError(400, "A remove names what it removes in its path.", "noTarget");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ScimError(400, `An ${op} with no path takes an object.`, "invalidSyntax");
    }
    for (const [key, each] of Object.entries(value)) {
      next = applyAt(next, parsePath(key), op, each);
    }
  }
  return next;
}

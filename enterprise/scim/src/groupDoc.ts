// A SCIM group as Nether keeps it (ADR 0085): its displayName, unique in
// its directory, its externalId, and its members, each an account the
// directory manages. A `POST` or `PUT` gives the whole group; a `PATCH`
// applies every operation, in both providers' forms, or none: Okta's
// rename with no path, its removal by a value filter and its whole list
// replaced, and Entra ID's capitalized `op` and members removed by value.
import { ScimError } from "./errors.ts";
import { type AttrPath, parsePath, pathText } from "./paths.ts";
import { member, operationsOf } from "./userDoc.ts";

export interface GroupDoc {
  readonly displayName: string;
  readonly externalId: string | null;
  /** The members' IDs, lowercase, each once, in the order sent. */
  readonly members: readonly string[];
}

/** Longest name a group keeps. */
const nameLimit = 200;

function invalid(detail: string): ScimError {
  return new ScimError(400, detail, "invalidValue");
}

function nameOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("Give the group a displayName.");
  }
  if (value.trim().length > nameLimit) throw invalid("The group's displayName is too long.");
  return value.trim();
}

function externalOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 1000) throw invalid("externalId is text.");
  return value;
}

/** Members as sent: objects with a `value`, or one such object, each once. */
export function membersOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const ids = list.map((each: unknown) => {
    const id = typeof each === "string" ? each : member(each, "value");
    if (typeof id !== "string" || id.trim() === "") {
      throw invalid("Each member has a value, its user's id.");
    }
    return id.trim().toLowerCase();
  });
  return [...new Set(ids)];
}

/** A group from a resource as `POST` or `PUT` sends it. */
export function groupFromResource(body: unknown): GroupDoc {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ScimError(400, "A group is a JSON object.", "invalidSyntax");
  }
  return {
    displayName: nameOf(member(body, "displayName")),
    externalId: externalOf(member(body, "externalId")),
    members: membersOf(member(body, "members")),
  };
}

type Op = "add" | "replace" | "remove";

function applyMembers(doc: GroupDoc, path: AttrPath, op: Op, value: unknown): GroupDoc {
  if (path.sub !== undefined) {
    throw new ScimError(
      400,
      `Nether changes members as a whole, not ${pathText(path)}.`,
      "invalidPath",
    );
  }
  if (path.filter !== undefined) {
    // Okta's members[value eq "<id>"], which only a remove names.
    if (op !== "remove") {
      throw new ScimError(400, "A value filter on members is for a remove.", "invalidPath");
    }
    const named = path.filter.map(({ path: inner, value: id }) => {
      if (inner.attr !== "value" || typeof id !== "string") {
        throw new ScimError(
          400,
          'Name a member to remove as members[value eq "<id>"].',
          "invalidPath",
        );
      }
      return id.toLowerCase();
    });
    return { ...doc, members: doc.members.filter((id) => !named.includes(id)) };
  }
  if (op === "remove") {
    // Entra ID names the members it removes in value; with none, all go.
    if (value === undefined || value === null) return { ...doc, members: [] };
    const gone = membersOf(value);
    return { ...doc, members: doc.members.filter((id) => !gone.includes(id)) };
  }
  const sent = membersOf(value);
  if (op === "replace") return { ...doc, members: sent };
  return { ...doc, members: [...new Set([...doc.members, ...sent])] };
}

function applyAt(doc: GroupDoc, path: AttrPath, op: Op, value: unknown): GroupDoc {
  if (path.schema === "enterprise" || path.schema === "other" || path.attr === "") return doc;
  switch (path.attr) {
    case "displayname":
      if (op === "remove") throw new ScimError(400, "A group keeps its displayName.", "mutability");
      return { ...doc, displayName: nameOf(value) };
    case "externalid":
      return { ...doc, externalId: op === "remove" ? null : externalOf(value) };
    case "members":
      return applyMembers(doc, path, op, value);
    default:
      // What Nether does not keep, as id or meta, as Okta sends with a rename: dropped.
      return doc;
  }
}

/**
 * Applies a PATCH's operations to a group, all or none: by a path, with a
 * value filter on members, or with no path and an object whose keys are
 * its attributes, as Okta's `{"id": ..., "displayName": ...}`.
 */
export function applyGroupPatch(doc: GroupDoc, body: unknown): GroupDoc {
  let next = doc;
  for (const { op, path, value } of operationsOf(body)) {
    if (path !== undefined) {
      const parsed = parsePath(path);
      // A remove may name no value: Okta's filter, or all members.
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

// SCIM's attribute paths and filters (RFC 7644, sections 3.4.2.2 and
// 3.5.2), as far as Okta and Entra ID send them: an attribute, perhaps
// after its schema's URN, perhaps with a value filter in brackets, perhaps
// with a sub-attribute; and filters of `eq` comparisons joined by `and`.
// Attribute names and operators are read without regard to case.
import { ScimError } from "./errors.ts";

export const coreUserSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
export const coreGroupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const enterpriseUserSchema = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

/** Which schema a path's URN names: a core one, the enterprise extension, or another. */
export type SchemaOf = "core" | "enterprise" | "other";

const knownSchemas: readonly (readonly [string, SchemaOf])[] = [
  [coreUserSchema.toLowerCase(), "core"],
  [coreGroupSchema.toLowerCase(), "core"],
  [enterpriseUserSchema.toLowerCase(), "enterprise"],
];

/** A comparison's value: a string, a boolean, a number or null. */
export type CompareValue = string | boolean | number | null;

export interface Comparison {
  readonly path: AttrPath;
  readonly value: CompareValue;
}

export interface AttrPath {
  /** The schema its URN names, when it has one. */
  readonly schema: SchemaOf | undefined;
  /** The attribute, lowercase; empty for a path that is only an extension's URN. */
  readonly attr: string;
  /** A value filter, as `[type eq "work"]`. */
  readonly filter: readonly Comparison[] | undefined;
  /** A sub-attribute, lowercase, as `.value`. */
  readonly sub: string | undefined;
}

const namePattern = /^[A-Za-z][A-Za-z0-9_$-]*/;

class Scanner {
  readonly text: string;
  at = 0;
  readonly fail: (why: string) => ScimError;

  constructor(text: string, fail: (why: string) => ScimError) {
    this.text = text;
    this.fail = fail;
  }

  get rest(): string {
    return this.text.slice(this.at);
  }

  done(): boolean {
    return this.at >= this.text.length;
  }

  spaces(): void {
    while (this.text[this.at] === " ") this.at++;
  }

  /** Takes a word, as an operator, if it is next, without regard to case. */
  word(word: string): boolean {
    const next = this.text.slice(this.at, this.at + word.length);
    const after = this.text[this.at + word.length];
    if (next.toLowerCase() !== word || (after !== undefined && after !== " ")) return false;
    this.at += word.length;
    return true;
  }

  name(): string {
    const found = namePattern.exec(this.rest);
    if (found === null) throw this.fail("an attribute's name is missing");
    this.at += found[0].length;
    return found[0].toLowerCase();
  }

  /** An attribute path: its URN, its name, a value filter and a sub-attribute. */
  path(allowFilter: boolean): AttrPath {
    let schema: SchemaOf | undefined;
    let attr: string | undefined;
    if (this.rest.toLowerCase().startsWith("urn:")) {
      const lower = this.rest.toLowerCase();
      const known = knownSchemas.find(
        ([urn]) =>
          lower.startsWith(urn) && [":", "", " ", "["].includes(this.rest[urn.length] ?? ""),
      );
      if (known !== undefined) {
        schema = known[1];
        this.at += known[0].length;
        if (this.text[this.at] === ":") this.at++;
        else attr = "";
      } else {
        // Another schema's URN: the attribute is after its last colon.
        const token = /^[A-Za-z0-9:._$-]+/.exec(this.rest)?.[0] ?? "";
        const colon = token.lastIndexOf(":");
        schema = "other";
        this.at += colon + 1;
        if (colon === token.length - 1) attr = "";
      }
    }
    attr ??= this.name();
    let filter: Comparison[] | undefined;
    if (this.text[this.at] === "[") {
      if (!allowFilter) throw this.fail("a value filter cannot be nested");
      this.at++;
      filter = this.comparisons(false);
      this.spaces();
      if (this.text[this.at] !== "]") throw this.fail("a value filter is not closed");
      this.at++;
    }
    let sub: string | undefined;
    if (this.text[this.at] === ".") {
      this.at++;
      sub = this.name();
    }
    return { schema, attr, filter, sub };
  }

  value(): CompareValue {
    if (this.text[this.at] === '"') {
      const found = /^"(?:[^"\\]|\\.)*"/.exec(this.rest);
      if (found === null) throw this.fail("a string is not closed");
      this.at += found[0].length;
      return JSON.parse(found[0]) as string;
    }
    const token = /^[^\s\]]+/.exec(this.rest)?.[0] ?? "";
    this.at += token.length;
    const lower = token.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (lower === "null") return null;
    if (token !== "" && Number.isFinite(Number(token))) return Number(token);
    throw this.fail(`${token === "" ? "a value" : token} is not a value`);
  }

  /** `attr eq value`, joined by `and`. */
  comparisons(allowFilter: boolean): Comparison[] {
    const found: Comparison[] = [];
    for (;;) {
      this.spaces();
      if (this.text[this.at] === "(" || this.word("not")) {
        throw this.fail("Nether takes comparisons with eq, joined by and");
      }
      const path = this.path(allowFilter);
      this.spaces();
      if (!this.word("eq")) throw this.fail("Nether compares with eq alone");
      this.spaces();
      found.push({ path, value: this.value() });
      this.spaces();
      if (this.word("and")) continue;
      if (this.word("or")) throw this.fail("Nether joins comparisons with and, not or");
      return found;
    }
  }
}

/** A filter, as `userName eq "ada@example.org" and active eq true`; a 400 `invalidFilter` when Nether does not take it. */
export function parseFilter(text: string): Comparison[] {
  const scanner = new Scanner(
    text.trim(),
    (why) => new ScimError(400, `This filter cannot be read: ${why}.`, "invalidFilter"),
  );
  const found = scanner.comparisons(true);
  scanner.spaces();
  if (!scanner.done()) throw scanner.fail(`"${scanner.rest}" was not expected`);
  return found;
}

/** A PATCH operation's path; a 400 `invalidPath` when it is not one. */
export function parsePath(text: string): AttrPath {
  const scanner = new Scanner(
    text.trim(),
    (why) => new ScimError(400, `The path ${text} cannot be read: ${why}.`, "invalidPath"),
  );
  const path = scanner.path(true);
  if (!scanner.done()) throw scanner.fail(`"${scanner.rest}" was not expected`);
  return path;
}

/** A path as text, for an answer: its name, filter and sub-attribute. */
export function pathText(path: AttrPath): string {
  return `${path.attr}${path.filter === undefined ? "" : "[...]"}${path.sub === undefined ? "" : `.${path.sub}`}`;
}

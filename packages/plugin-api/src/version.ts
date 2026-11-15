// The API's own version, apart from the app's (ADR 0055), and the ranges a
// manifest names it by.

/** The version of the API this SDK speaks. */
export const apiVersion = "0.1.0";

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Whether the text named the patch, as `^0.0` does not. */
  readonly exact: boolean;
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

function readVersion(text: string, patchNeeded: boolean): Version | undefined {
  const match = versionPattern.exec(text);
  if (match === null) return undefined;
  const [, major = "", minor = "", patch] = match;
  if (patch === undefined && patchNeeded) return undefined;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch ?? "0"),
    exact: patch !== undefined,
  };
}

/** Whether a string is a version, as `0.1.0`. */
export function isVersion(text: string): boolean {
  return readVersion(text, true) !== undefined;
}

/** Whether a string is a range `satisfies` reads: `^0.1`, `^1.2.3`, or a version alone. */
export function isRange(text: string): boolean {
  return (
    readVersion(text.startsWith("^") ? text.slice(1) : text, !text.startsWith("^")) !== undefined
  );
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether a version is in a range, as npm reads a caret: `^1.2` takes 1.2.0
 * and up, before 2.0.0. Before 1.0 a minor version may break, so `^0.1`
 * takes only 0.1.x, `^0.0` only 0.0.x, and `^0.0.3` only 0.0.3. A version
 * alone takes only itself.
 */
export function satisfies(version: string, range: string): boolean {
  const have = readVersion(version, true);
  if (have === undefined) return false;
  if (!range.startsWith("^")) {
    const exact = readVersion(range, true);
    return exact !== undefined && compare(have, exact) === 0;
  }
  const low = readVersion(range.slice(1), false);
  if (low === undefined || compare(have, low) < 0) return false;
  if (low.major > 0) return have.major === low.major;
  if (low.minor > 0) return have.major === 0 && have.minor === low.minor;
  return have.major === 0 && have.minor === 0 && (!low.exact || have.patch === low.patch);
}

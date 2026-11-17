// What ADR 0001 allows (docs/adr/0001-license-agpl-and-dco.md), a check of
// SPDX license expressions against it, and the license of a package known by
// its license file, for Go modules and Swift packages, which name none.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const allowed = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  // MIT without its attribution clause: more permissive than MIT (ADR 0008).
  "MIT-0",
  "Zlib",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "MPL-2.0",
  "LGPL-2.1",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  // Content licenses, for data only, such as browser support tables.
  "CC-BY-4.0",
]);
export const allowedExceptions = new Set(["LLVM-exception"]);

// Packages whose license field is missing or not SPDX, checked by hand:
// "name": "the license found, and where".
export const reviewed = {
  khroma: "MIT, in its license file; package.json has no license field",
  // Under @hocuspocus/extension-redis, for the `ha` module (ADR 0082).
  "@sesamecare-oss/redlock":
    "MIT, in its LICENSE.md (Mike Marcacci's, as the original redlock); package.json says UNLICENSED",
};

/** Whether an SPDX expression such as "(MIT OR Apache-2.0)" is allowed. */
export function permits(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  function either() {
    let result = both();
    while (peek()?.toUpperCase() === "OR") {
      take();
      result = both() || result;
    }
    return result;
  }
  function both() {
    let result = single();
    while (peek()?.toUpperCase() === "AND") {
      take();
      result = single() && result;
    }
    return result;
  }
  function single() {
    const token = take();
    if (token === "(") {
      const result = either();
      if (take() !== ")") throw new Error("unbalanced parentheses");
      return result;
    }
    if (token === undefined || token === ")") throw new Error("missing license");
    const id = token.replace(/\+$/, "");
    if (peek()?.toUpperCase() === "WITH") {
      take();
      return allowed.has(id) && allowedExceptions.has(take() ?? "");
    }
    return allowed.has(id);
  }

  try {
    const result = either();
    return position === tokens.length && result;
  } catch {
    return false;
  }
}

// Recognizes a license file by phrases from its text.
const licenseTexts = [
  ["MIT", ["Permission is hereby granted, free of charge", 'THE SOFTWARE IS PROVIDED "AS IS"']],
  ["Apache-2.0", ["Apache License", "Version 2.0"]],
  ["BSD-3-Clause", ["Redistribution and use in source and binary forms", "Neither the name of"]],
  ["BSD-2-Clause", ["Redistribution and use in source and binary forms"]],
  ["ISC", ["Permission to use, copy, modify, and/or distribute this software for any purpose"]],
  ["MPL-2.0", ["Mozilla Public License Version 2.0"]],
  ["Unlicense", ["This is free and unencumbered software released into the public domain"]],
];
const licenseFiles = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];

/** A package's license, from the license file in its folder. */
export function identify(directory) {
  for (const name of licenseFiles) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").replace(/\s+/g, " ");
    const match = licenseTexts.find(([, phrases]) =>
      phrases.every((phrase) => text.includes(phrase)),
    );
    return match?.[0] ?? `unrecognized text in ${name}`;
  }
  return "no license file";
}

/**
 * The Swift packages a Package.resolved pins, each with the folder SwiftPM
 * checks it out to: its repository's name. Reads the file's first format,
 * and the second and third.
 */
export function swiftPins(resolved) {
  const pins = resolved.pins ?? resolved.object?.pins ?? [];
  return pins.map((pin) => {
    const location = pin.location ?? pin.repositoryURL ?? "";
    const version = pin.state?.version ?? pin.state?.revision ?? "";
    return {
      name: pin.identity ?? pin.package ?? location,
      version,
      folder:
        location
          .replace(/\/+$/, "")
          .replace(/\.git$/, "")
          .split("/")
          .pop() ?? "",
    };
  });
}

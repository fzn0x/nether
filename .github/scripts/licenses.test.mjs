// node --test ".github/scripts/*.test.mjs"
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { identify, permits, swiftPins } from "./licenses.mjs";

test("allows the licenses ADR 0001 lists, alone and combined", () => {
  for (const expression of [
    "MIT",
    "Apache-2.0",
    "(MIT OR Apache-2.0)",
    "Apache-2.0 AND LGPL-3.0-or-later",
    "MIT AND (BSD-3-Clause OR GPL-2.0-only)",
    "GPL-3.0 OR PROPRIETARY",
    "Apache-2.0 WITH LLVM-exception",
    "GPL-3.0+",
  ]) {
    assert.equal(permits(expression), true, expression);
  }
});

test("refuses other licenses, unknown ones and malformed expressions", () => {
  for (const expression of [
    "GPL-2.0-only",
    "MIT AND GPL-2.0-only",
    "BUSL-1.1",
    "SSPL-1.0",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "MIT WITH Some-exception",
    "SEE LICENSE IN LICENSE.md",
    "Unknown",
    "UNLICENSED",
    "",
    "(MIT",
    "MIT)",
    "MIT OR",
  ]) {
    assert.equal(permits(expression), false, expression);
  }
});

test("knows a package's license by its license file", () => {
  const directory = mkdtempSync(join(tmpdir(), "license-"));
  try {
    assert.equal(identify(directory), "no license file");
    // SQLCipher.swift's, a BSD license under a heading, with SQLite's notes after it.
    writeFileSync(
      join(directory, "LICENSE.md"),
      [
        "## Community Edition Open Source License",
        "",
        "Redistribution and use in source and binary",
        "forms, with or without modification, are permitted provided that ...",
        "* Neither the name of the ZETETIC LLC nor the names of its contributors may be used",
        "",
      ].join("\n"),
    );
    assert.equal(identify(directory), "BSD-3-Clause");
    writeFileSync(join(directory, "LICENSE"), "All rights reserved.\n");
    assert.equal(identify(directory), "unrecognized text in LICENSE");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads the Swift packages Package.resolved pins, in each of its formats", () => {
  const third = {
    pins: [
      {
        identity: "sqlcipher.swift",
        kind: "remoteSourceControl",
        location: "https://github.com/sqlcipher/SQLCipher.swift.git",
        state: { revision: "0123abc", version: "4.20.0" },
      },
      {
        identity: "zipfoundation",
        kind: "remoteSourceControl",
        location: "https://github.com/weichsel/ZIPFoundation",
        state: { revision: "4567def" },
      },
    ],
    version: 3,
  };
  assert.deepEqual(swiftPins(third), [
    { name: "sqlcipher.swift", version: "4.20.0", folder: "SQLCipher.swift" },
    { name: "zipfoundation", version: "4567def", folder: "ZIPFoundation" },
  ]);
  const first = {
    object: {
      pins: [
        {
          package: "Capacitor",
          repositoryURL: "https://github.com/ionic-team/capacitor-swift-pm.git",
          state: { version: "8.6.0" },
        },
      ],
    },
    version: 1,
  };
  assert.deepEqual(swiftPins(first), [
    { name: "Capacitor", version: "8.6.0", folder: "capacitor-swift-pm" },
  ]);
  assert.deepEqual(swiftPins({}), []);
});

// Checks that every Swift package the iOS app ships has a license ADR 0001
// allows (docs/adr/0001-license-agpl-and-dco.md), as the Android app's
// licensee check does for its libraries (ADR 0087): each package Xcode
// resolved, as Package.resolved pins it, known by the license file in its
// checkout, as check-licenses.mjs knows Go modules. Fails on any other
// license, and on a license it cannot read, which a person must then review.
//
//   node .github/scripts/check-swift-licenses.mjs <Package.resolved> <checkouts folder>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { allowed, identify, swiftPins } from "./licenses.mjs";

const [resolvedFile, checkouts] = process.argv.slice(2);
if (resolvedFile === undefined || checkouts === undefined) {
  console.error("Usage: check-swift-licenses.mjs <Package.resolved> <checkouts folder>");
  process.exit(2);
}

const pins = swiftPins(JSON.parse(readFileSync(resolvedFile, "utf8")));
const problems = [];
for (const pin of pins) {
  const directory = join(checkouts, pin.folder);
  const license = existsSync(directory) ? identify(directory) : `no checkout in ${directory}`;
  if (!allowed.has(license)) problems.push(`${license}\t${pin.name}@${pin.version}`);
  else console.log(`${license}\t${pin.name}@${pin.version}`);
}

if (pins.length === 0) {
  console.error(`${resolvedFile} pins no packages: the app has at least Capacitor's.`);
  process.exitCode = 1;
} else if (problems.length > 0) {
  console.error("These Swift packages have a license ADR 0001 does not allow, or one to review:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`Licenses allowed: ${String(pins.length)} Swift packages.`);
}

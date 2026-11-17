// The iOS app in a simulator (ADR 0087): installs the app built for the
// simulator, gives it a vault in its Documents with one note, the vault it
// had open last, starts it, and waits for the page's marks in the system's
// log: the vault open, and its notes read. Then the vault's index, in the
// app's SQLite, holds the note with the size and time the plugin listed, and
// search finds it by a word of it: the page, the plugin and SQLite together.
// The index learns a note's SHA-256 only as the note is opened or written,
// not as the vault is listed and its notes read for search; the plugin's own
// tests check the hash.
//
//   pnpm --filter @nether/mobile smoke:ios <path/to/App.app> [simulator UDID]
//
// It needs macOS with Xcode, and a booted simulator, or the UDID of one.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const app = "io.github.fzn0x.nether";
const [bundle, device = "booted"] = process.argv.slice(2).filter((arg) => arg !== "--");
if (bundle === undefined) throw new Error("Give the path to App.app, built for the simulator.");
const timeout = 120_000;
const screenshot = fileURLToPath(new URL("../smoke-failure.png", import.meta.url));

function simctl(...args) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" }).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` gives something, or fails with `what` after the timeout. */
async function until(what, check) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(500);
  }
}

// The page's marks, from the plugin's log, with the milliseconds since the app's process started.
const marks = new Map();
let log;
/**
 * Reads the vault's index, once it is found, with Node's own SQLite, which
 * has FTS5, as macOS's sqlite3 has not. Each query opens it again, read
 * only, so it sees what the app last committed.
 */
let rows;

try {
  simctl("terminate", device, app);
} catch {
  // Not installed, or not running: nothing to end.
}

try {
  console.log(`Installing ${bundle}`);
  simctl("install", device, bundle);

  // A vault as the app keeps one: a folder in its Documents, which the Files
  // app shows, with its ID in .nether/vault.json, and the list of vaults in
  // its support folder, this vault the one open last.
  const data = simctl("get_app_container", device, app, "data");
  const id = randomUUID();
  const note = "# Welcome\n\nA lighthouse keeps the smoke test company.\n";
  const vault = join(data, "Documents", "Smoke");
  mkdirSync(join(vault, ".nether"), { recursive: true });
  writeFileSync(join(vault, ".nether", "vault.json"), `{\n  "id": "${id}",\n  "format": 1\n}\n`);
  writeFileSync(join(vault, "Welcome.md"), note);
  const support = join(data, "Library", "Application Support");
  mkdirSync(support, { recursive: true });
  writeFileSync(
    join(support, "vaults.json"),
    JSON.stringify({ vaults: [{ id, name: "Smoke", folder: "Smoke" }], last: id }, null, 2),
  );

  log = spawn("xcrun", [
    "simctl",
    "spawn",
    device,
    "log",
    "stream",
    "--style",
    "compact",
    "--predicate",
    'subsystem == "io.github.fzn0x.nether"',
  ]);
  let pending = "";
  log.stdout.setEncoding("utf8");
  log.stdout.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const mark = /NetherMarks: (\S+) (-?\d+)/.exec(line);
      if (mark === null) continue;
      marks.set(mark[1], Number(mark[2]));
      console.log(`  ${mark[1]} at ${mark[2]} ms`);
    }
  });
  // The stream takes a moment to start.
  await sleep(3_000);

  console.log(`Starting ${app}`);
  simctl("launch", device, app);
  await until("the vault to open", () => (marks.has("vault-open") ? true : undefined));
  await until("its notes to be read", () => (marks.has("notes-read") ? true : undefined));

  // The index the page keeps in SQLite, through @capacitor-community/sqlite.
  const databases = join(data, "Library", "CapacitorDatabase");
  const db = await until("the vault's index", () => {
    if (!existsSync(databases)) return undefined;
    const name = readdirSync(databases).find(
      (each) => each.startsWith(`index-${id}`) && each.endsWith(".db"),
    );
    return name === undefined ? undefined : join(databases, name);
  });
  rows = (query) => {
    const index = new DatabaseSync(db, { readOnly: true });
    try {
      return index.prepare(query).all();
    } finally {
      index.close();
    }
  };
  // Welcome.md is a note in the index, with the size and the time in
  // milliseconds that the plugin listed: what the file has on the disk.
  const indexed = await until(
    "the note in the index",
    () =>
      rows(
        "SELECT size || ' ' || modified AS found FROM files WHERE path = 'Welcome.md' AND note IS NOT NULL",
      )[0]?.found,
  );
  const file = statSync(join(vault, "Welcome.md"), { bigint: true });
  const listed = `${file.size} ${file.mtimeNs / 1_000_000n}`;
  if (indexed !== listed) {
    throw new Error(`The index has Welcome.md at size and time ${indexed}, not ${listed}.`);
  }
  await until("search to find the note", () =>
    rows("SELECT count(*) AS found FROM note_texts WHERE note_texts MATCH 'lighthouse'")[0]
      ?.found === 1
      ? true
      : undefined,
  );
  console.log("The vault opened, its note is in the index, and search finds it.");
} catch (error) {
  // What the index holds, to tell a vault never listed from a note never indexed.
  if (rows !== undefined) {
    try {
      const files = rows("SELECT path, note, size, modified FROM files");
      const [{ texts }] = rows("SELECT count(*) AS texts FROM note_texts");
      console.error(`The index's files: ${JSON.stringify(files)}\nIts notes for search: ${texts}`);
    } catch (reason) {
      console.error(`The index could not be read: ${reason}`);
    }
  }
  try {
    simctl("io", device, "screenshot", screenshot);
    console.error(`What the simulator showed: ${screenshot}`);
  } catch {
    // No screen to keep.
  }
  throw error;
} finally {
  log?.kill();
  try {
    simctl("terminate", device, app);
  } catch {
    // Already ended.
  }
}

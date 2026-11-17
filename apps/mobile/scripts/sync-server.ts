// A Nether server for the Android app's smoke test (ADR 0087): PostgreSQL in
// the process (PGlite), on this machine's loopback address, which the
// emulator reaches as 10.0.2.2. Ada sets it up with a password and the
// workspace Team, which holds a note made through the API. Once it listens,
// it prints one line of JSON: its address here, its address from the
// emulator, Ada's session token and Team's ID.
//
//   node scripts/sync-server.ts [port]
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../server/src/app.ts";
import { DiskBlobs } from "../../server/src/blobs.ts";
import { readConfig } from "../../server/src/config.ts";
import { migrate } from "../../server/src/migrations.ts";
import { newSetupCode } from "../../server/src/setup.ts";
import { testDatabase } from "../../server/test/database.ts";

const port = Number(process.argv[2] ?? "4180");
const here = `http://127.0.0.1:${String(port)}`;
/** The emulator's way to this machine's loopback address. */
const fromEmulator = `http://10.0.2.2:${String(port)}`;
const password = "a long password";

const db = await testDatabase();
await migrate(db);
const setupCode = newSetupCode();
const app = await buildApp(
  readConfig({
    NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether",
    NETHER_LOG_LEVEL: "warn",
    NETHER_PUBLIC_URL: fromEmulator,
  }),
  { db, setupCode, blobs: new DiskBlobs(await mkdtemp(join(tmpdir(), "nether-phone-"))) },
);
await app.listen({ host: "127.0.0.1", port });

async function post(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const response = await fetch(here + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

const setup = (await post("/api/setup", {
  code: setupCode,
  name: "Ada",
  email: "ada@example.org",
  password,
  workspace: "Team",
})) as { token: string; workspace: { id: string } };
await post(
  `/api/v1/workspaces/${setup.workspace.id}/notes`,
  { path: "From the server.md", markdown: "Written on the server.\n" },
  setup.token,
);

console.log(
  JSON.stringify({ url: here, fromEmulator, token: setup.token, workspace: setup.workspace.id }),
);

const stop = () => {
  void app.close().then(() => db.close());
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

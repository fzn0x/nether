// Checks that `docker compose up` gives a working server (ADR 0054): it
// starts the compose project, finds its schema current, sets
// the server up with the code from its log, keeps an attachment, serves the
// web app, counts its rate limits in Valkey and makes a backup; then stops
// it all, starts it again and finds the account and the attachment kept;
// then restores the backup on a new install, as the self-hosting guide
// says. CI runs it on the image it built.
//
//   node deploy/docker/check.mjs           # the image NETHER_VERSION names, pulled or built
//   node deploy/docker/check.mjs --build   # built from this checkout first
//
// It runs as a compose project of its own, nether-check, on a free port,
// and removes the project and its volumes at the end.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("docker-compose.yml", import.meta.url));
const project = process.env.NETHER_CHECK_PROJECT ?? "nether-check";
const build = process.argv.includes("--build");

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port: found } = probe.address();
    probe.close(() => resolve(found));
  });
});
const env = { ...process.env, NETHER_PUBLISH: `127.0.0.1:${String(port)}` };
const base = `http://127.0.0.1:${String(port)}`;

function compose(args) {
  const result = spawnSync("docker", ["compose", "-p", project, "-f", file, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function check(condition, what) {
  if (!condition) throw new Error(`Failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function call(method, path, { token, json, bytes, headers = {} } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(bytes === undefined ? {} : { "content-type": "application/octet-stream" }),
      ...headers,
    },
    body: json === undefined ? bytes : JSON.stringify(json),
  });
}

/** Starts the project, then waits for the server to answer on the host's port too. */
async function up(extra = []) {
  compose(["up", "--detach", "--wait", "--wait-timeout", "240", ...extra]);
  // Docker Desktop forwards the port a moment after the container is healthy.
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch (error) {
      if (tries === 30) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const admin = {
  name: "Ada",
  email: "ada@example.org",
  password: "a long password for the check",
  workspace: "Team",
};
const file1 = randomBytes(4096);
const hash = createHash("sha256").update(file1).digest("hex");
/** The folder the backup is copied out to, for the restore. */
let saved;

try {
  await up(build ? ["--build"] : []);
  check(true, `docker compose up: the server, PostgreSQL and Valkey are healthy on ${base}`);

  const health = await call("GET", "/health");
  const status = await health.json();
  check(health.status === 200 && status.status === "ok", `/health answers ${status.version}`);
  check(
    Object.values(status.enterprise).every((on) => on === false),
    "every enterprise feature is off",
  );
  const migrated = compose(["exec", "-T", "server", "node", "dist/admin.js", "migrate"]);
  check(migrated.includes("nothing to do"), "the admin command finds the schema current");
  check((await (await call("GET", "/api/setup")).json()).needed === true, "it asks to be set up");

  const logs = compose(["logs", "--no-color", "server"]);
  const code = /Set it up from the app with this code: ([A-Z0-9-]+)/.exec(logs)?.[1];
  check(code !== undefined, "its log has the setup code");
  const setup = await call("POST", "/api/setup", { json: { ...admin, code } });
  check(setup.status === 201, "setup makes the admin account");
  const { token, workspace } = await setup.json();

  const page = await call("GET", "/");
  check(
    page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html"),
    "it serves the web app",
  );
  check(
    (page.headers.get("content-security-policy") ?? "").includes("default-src"),
    "with its content security policy",
  );

  const put = await call("PUT", `/api/workspaces/${workspace.id}/attachments/${hash}`, {
    token,
    bytes: file1,
    headers: { "x-content-type": "application/octet-stream" },
  });
  check(put.status === 201, "it keeps an attachment");

  const keys = compose(["exec", "-T", "valkey", "valkey-cli", "--scan", "--pattern", "nether:*"]);
  check(/setup:/.test(keys), "its rate limits count in Valkey");

  compose([
    "exec",
    "-T",
    "server",
    "node",
    "dist/admin.js",
    "backup",
    "/data/backups/check.ndjson.gz",
  ]);
  const listed = compose(["exec", "-T", "server", "ls", "/data/backups"]);
  check(listed.includes("check.ndjson.gz"), "the admin command makes a backup in the volume");

  compose(["down"]);
  await up();
  check(true, "it starts again, on the same volumes");
  check((await (await call("GET", "/api/setup")).json()).needed === false, "it stays set up");
  const signIn = await call("POST", "/api/sessions", {
    json: { email: admin.email, password: admin.password },
  });
  check(signIn.status === 201, "the admin signs in again");
  const { token: again } = await signIn.json();
  const got = await call("GET", `/api/workspaces/${workspace.id}/attachments/${hash}`, {
    token: again,
  });
  const kept = Buffer.from(await got.arrayBuffer());
  check(got.status === 200 && kept.equals(file1), "the attachment is kept, byte for byte");

  // Moving to a new machine, as the self-hosting guide has it: the backup
  // copied out, every volume gone, then restored into the new database.
  saved = await mkdtemp(join(tmpdir(), "nether-check-"));
  // The server's user, not the one running this, reads the folder.
  await chmod(saved, 0o755);
  compose(["cp", "server:/data/backups/check.ndjson.gz", join(saved, "check.ndjson.gz")]);
  compose(["down", "--volumes"]);
  compose([
    "run",
    "--rm",
    "--volume",
    `${saved}:/restore:ro`,
    "server",
    "node",
    "dist/admin.js",
    "restore",
    "/restore/check.ndjson.gz",
  ]);
  await up();
  const restored = await call("POST", "/api/sessions", {
    json: { email: admin.email, password: admin.password },
  });
  check(restored.status === 201, "a backup restores on a new install, and the admin signs in");
  const { token: third } = await restored.json();
  const back = await call("GET", `/api/workspaces/${workspace.id}/attachments/${hash}`, {
    token: third,
  });
  check(
    back.status === 200 && Buffer.from(await back.arrayBuffer()).equals(file1),
    "with the attachment, byte for byte",
  );
  console.log("All checks passed.");
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
  try {
    console.error(compose(["logs", "--no-color", "--tail", "60"]));
  } catch {
    // The project may not have started at all.
  }
} finally {
  try {
    compose(["down", "--volumes"]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  if (saved !== undefined) await rm(saved, { recursive: true, force: true });
}

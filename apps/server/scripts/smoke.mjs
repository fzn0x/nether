// Starts the built server (dist/main.js) with every enterprise feature
// switched off, on the PostgreSQL database NETHER_DATABASE_URL names, checks
// that /health answers and reports them all off, that /health/ready says it
// takes work, and that a new server asks to be set up. Then it sends
// SIGTERM, as Kubernetes does, and checks that the server drains, its
// readiness answering 503, and exits cleanly (ADR 0082). On Windows, where
// SIGTERM ends a process at once, it stops it without that check. CI runs
// this after the build, with a database: `pnpm --filter @nether/server smoke`.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

if ((process.env.NETHER_DATABASE_URL ?? "") === "") {
  console.error("Set NETHER_DATABASE_URL to a PostgreSQL database to run the smoke test.");
  process.exit(1);
}

const features = ["SSO", "SCIM", "AUDIT", "POLICIES", "ADMIN", "HA"];
const env = {
  ...process.env,
  NETHER_HOST: "127.0.0.1",
  NETHER_PORT: "0",
  NETHER_LOG_LEVEL: "info",
  NETHER_DRAIN_SECONDS: "2",
};
for (const feature of features) env[`NETHER_ENTERPRISE_${feature}`] = "off";

const server = spawn(process.execPath, ["dist/main.js"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: ["ignore", "pipe", "inherit"],
});

function finish(code, message) {
  if (message) console[code === 0 ? "log" : "error"](message);
  server.kill();
  process.exitCode = code;
}

const timer = setTimeout(() => {
  finish(1, "The server did not start listening within 15 seconds.");
}, 15_000);

/** Set once the smoke run stops the server itself, so its exit is expected. */
let stopping = false;

server.on("exit", (code) => {
  if (process.exitCode === undefined && !stopping) {
    clearTimeout(timer);
    finish(1, `The server exited early with code ${String(code)}.`);
  }
});

// Fastify logs one JSON line per event; the one that says where it listens
// gives the port it picked.
for await (const line of createInterface({ input: server.stdout })) {
  const address = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
  if (address === undefined) continue;
  clearTimeout(timer);
  try {
    const response = await fetch(`${address}/health`);
    const body = await response.json();
    const off = Object.values(body.enterprise ?? {}).every((value) => value === false);
    const setup = await (await fetch(`${address}/api/setup`)).json();
    const ready = await fetch(`${address}/health/ready`);
    const readiness = await ready.json();
    if (response.status !== 200 || body.status !== "ok" || !off) {
      finish(1, `Unexpected health check: ${response.status} ${JSON.stringify(body)}`);
    } else if (setup.needed !== true) {
      finish(1, `A new server did not ask to be set up: ${JSON.stringify(setup)}`);
    } else if (ready.status !== 200 || readiness.status !== "ready") {
      finish(1, `Unexpected readiness: ${ready.status} ${JSON.stringify(readiness)}`);
    } else if (process.platform === "win32") {
      finish(0, `Server ${body.version} answered at ${address}, ready, waiting to be set up.`);
    } else {
      stopping = true;
      const exited = new Promise((resolve) => {
        server.once("exit", (code) => {
          resolve(code);
        });
      });
      server.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const draining = await fetch(`${address}/health/ready`);
      const drainingBody = await draining.json();
      const code = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve("still running"), 20_000)),
      ]);
      if (draining.status !== 503 || drainingBody.status !== "draining") {
        finish(1, `Draining, readiness said: ${draining.status} ${JSON.stringify(drainingBody)}`);
      } else if (code !== 0) {
        finish(1, `After SIGTERM the server ended with ${String(code)}, not 0.`);
      } else {
        finish(
          0,
          `Server ${body.version} answered at ${address} with every enterprise feature off, ready, waiting to be set up, and drained on SIGTERM before it exited.`,
        );
      }
    }
  } catch (error) {
    finish(1, `The health check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  break;
}

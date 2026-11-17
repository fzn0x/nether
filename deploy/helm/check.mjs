// Checks the chart on a kind cluster (ADR 0082), after the workflow has
// installed it with examples/kind.yaml: two nodes with high availability,
// the bundled PostgreSQL and Valkey, and the Service at NodePort 30080.
//
// It sets the server up with the setup code from the chart's Secret, and
// two devices sync an encrypted note through the relay, through the
// Service. Then it deletes a node's pod, and sync goes on; then, while a
// client sends a request every 100 ms and the devices push, it upgrades
// the release with a changed value, so every pod is replaced, and checks
// that none of the client's requests failed and no push was lost.
//
//   node deploy/helm/check.mjs   # with kubectl and helm on the PATH
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:30080";
const release = process.env.NETHER_CHECK_RELEASE ?? "nether";
const chart = fileURLToPath(new URL("nether", import.meta.url));
const values = fileURLToPath(new URL("nether/examples/kind.yaml", import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
  }
  return result.stdout.trim();
}

/** As `run`, without holding the event loop: requests and pushes go on meanwhile. */
function runAside(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed:
${output}`),
        );
    });
  });
}

function check(condition, what) {
  if (!condition) throw new Error(`Failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what, test, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if (await test()) return;
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function call(method, path, body, token) {
  const answer = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${text}`);
  return text === "" ? {} : JSON.parse(text);
}

/** A device's relay connection to one encrypted note, through the Service, as the sync client keeps one. */
class Device {
  heard = new Set();
  taken = new Set();
  #pending = new Map();
  #token;
  #name;
  #socket;
  #subscribed = false;
  #cursor = 0;
  #stopped = false;

  constructor(token, name) {
    this.#token = token;
    this.#name = name;
    this.#connect();
  }

  #connect() {
    if (this.#stopped) return;
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/relay`);
    this.#socket = socket;
    this.#subscribed = false;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: this.#token }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") {
        socket.send(JSON.stringify({ type: "subscribe", name: this.#name, after: this.#cursor }));
      } else if (message.type === "updates") {
        for (const update of message.updates) {
          this.heard.add(Buffer.from(update.data, "base64").toString("utf8"));
          this.#cursor = Math.max(this.#cursor, update.seq);
        }
      } else if (message.type === "subscribed") {
        this.#cursor = Math.max(this.#cursor, Number(message.seq));
        this.#subscribed = true;
        for (const [id, data] of this.#pending) this.#send(id, data);
      } else if (message.type === "pushed") {
        const data = this.#pending.get(message.id);
        if (data === undefined) return;
        this.#pending.delete(message.id);
        this.taken.add(data);
        this.#cursor = Math.max(this.#cursor, Number(message.seq));
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#subscribed = false;
      setTimeout(() => this.#connect(), 300);
    });
    socket.addEventListener("error", () => undefined);
  }

  #send(id, data) {
    if (!this.#subscribed || this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(
      JSON.stringify({
        type: "push",
        id,
        name: this.#name,
        data: Buffer.from(data, "utf8").toString("base64"),
      }),
    );
  }

  push(data) {
    const id = randomUUID();
    this.#pending.set(id, data);
    this.#send(id, data);
  }

  stop() {
    this.#stopped = true;
    this.#socket?.close();
  }
}

const devices = [];
try {
  await until(
    "the Service to answer as ready",
    async () => (await fetch(`${base}/health/ready`)).ok,
    180,
  );
  check(true, "the release answers at its Service, ready");

  const code = Buffer.from(
    run("kubectl", ["get", "secret", release, "-o", "jsonpath={.data.NETHER_SETUP_CODE}"]),
    "base64",
  ).toString("utf8");
  check(code.length >= 16, "the chart made a setup code, in its Secret");
  const admin = { email: "ada@example.org", password: "a long password for the check" };
  const made = await call("POST", "/api/setup", {
    code,
    name: "Ada",
    workspace: "Team",
    ...admin,
  });
  check(typeof made.token === "string", "the server is set up with that code");
  const signIn = async () => (await call("POST", "/api/sessions", admin)).token;
  const laptopToken = made.token;
  const phoneToken = await signIn();
  const nodes = await call("GET", "/api/instance/nodes", undefined, laptopToken);
  check(nodes.nodes.length === 2, "the console lists both nodes");

  const b64 = (bytes) => randomBytes(bytes).toString("base64");
  await call("PUT", "/api/me/keys", { publicKey: b64(32), recoveryBox: b64(73) }, laptopToken);
  const secret = await call(
    "POST",
    "/api/workspaces",
    { name: "Secret", encryption: "end-to-end", sealedKey: b64(80) },
    laptopToken,
  );
  const name = `${secret.id}/${randomUUID()}`;
  const laptop = new Device(laptopToken, name);
  const phone = new Device(phoneToken, name);
  devices.push(laptop, phone);

  const pushes = [];
  let round = 0;
  const push = () => {
    round++;
    for (const [device, who] of [
      [laptop, "laptop"],
      [phone, "phone"],
    ]) {
      const words = `${who}-${round}`;
      device.push(words);
      pushes.push(words);
    }
  };
  const synced = (what) =>
    until(
      what,
      () =>
        pushes.every((words) => {
          const [pusher, listener] = words.startsWith("laptop") ? [laptop, phone] : [phone, laptop];
          return pusher.taken.has(words) && listener.heard.has(words);
        }),
      120,
    );

  push();
  await synced("the first pushes");
  check(true, "two devices sync an encrypted note through the Service");

  // A node's pod deleted, as a cluster node draining deletes it.
  const serverPods = () =>
    run("kubectl", [
      "get",
      "pods",
      "-l",
      `app.kubernetes.io/instance=${release},app.kubernetes.io/component=server`,
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]).split(" ");
  const pods = serverPods();
  check(pods.length === 2, "two server pods run");
  run("kubectl", ["delete", "pod", pods[0], "--wait=false"]);
  push();
  await synced("the pushes after a pod went");
  push();
  await synced("more pushes");
  run("kubectl", ["rollout", "status", `deployment/${release}`, "--timeout=180s"]);
  check(true, "a pod deleted, sync goes on, and the Deployment makes another");

  // An upgrade that replaces every pod, while a client keeps asking.
  const before = serverPods();
  let asked = 0;
  const failed = [];
  let asking = true;
  const asker = (async () => {
    while (asking) {
      asked++;
      try {
        const answer = await fetch(`${base}/api/me`, {
          headers: { authorization: `Bearer ${laptopToken}` },
        });
        if (!answer.ok) failed.push(`${answer.status} ${await answer.text()}`);
        else await answer.arrayBuffer();
      } catch (error) {
        failed.push(
          error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const pusher = setInterval(push, 1000);
  await runAside("helm", [
    "upgrade",
    release,
    chart,
    "-f",
    values,
    "--set",
    `podAnnotations.rolled=r${Date.now()}`,
    "--wait",
    "--timeout",
    "5m",
  ]);
  // The old pods drain and close after the new ones are ready: still asking.
  for (const pod of before) {
    await runAside("kubectl", ["wait", "--for=delete", `pod/${pod}`, "--timeout=180s"]);
  }
  clearInterval(pusher);
  asking = false;
  await asker;
  push();
  await synced("every push through the upgrade");
  console.log(`${asked} requests through the upgrade, ${failed.length} failed`);
  for (const failure of failed.slice(0, 10)) console.log(`  ${failure}`);
  check(
    serverPods().every((pod) => !before.includes(pod)),
    "helm upgrade replaced every server pod",
  );
  check(failed.length === 0, "no request failed while every pod was replaced");
  check(true, `every one of ${pushes.length} pushes reached the other device`);
} finally {
  for (const device of devices) device.stop();
}

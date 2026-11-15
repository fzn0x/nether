// Measures sync under load, for the requirements' co-editing latency (under
// 200 ms in one region) and server size (200 active users on 2 vCPU and
// 4 GB). It starts deploy/docker's compose project with tools/perf's
// limits, sets the server up, makes 200 people in its workspace, and has
// them write live: ten to a note, each in a paragraph of their own,
// a word every two to four seconds, each with their caret. Every word
// carries the time it was typed; the others' clients note when it reaches
// them. It reports the latency's percentiles and the server's CPU and
// memory, checks every note came out the same for everyone with every
// word, then removes the project. It exits with 1 when a target is missed.
//
//   pnpm --filter @nether/perf sync                   # the image NETHER_VERSION names, or built
//   pnpm --filter @nether/perf sync --build --people 200 --seconds 120
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const people = Number(option("people", "200"));
const perNote = Number(option("per-note", "10"));
const seconds = Number(option("seconds", "120"));
const out = option("out", "sync-report.json");
const build = process.argv.includes("--build");
const project = "nether-load";
const files = [
  fileURLToPath(new URL("../../../deploy/docker/docker-compose.yml", import.meta.url)),
  fileURLToPath(new URL("../sync.compose.yml", import.meta.url)),
];
const latencyLimit = 200;

const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const found = typeof address === "object" && address !== null ? address.port : 0;
    probe.close(() => {
      resolve(found);
    });
  });
});
const base = `http://127.0.0.1:${String(port)}`;
const env = { ...process.env, NETHER_PUBLISH: `127.0.0.1:${String(port)}` };

function compose(args: readonly string[]): string {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, ...files.flatMap((file) => ["-f", file]), ...args],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) throw new Error(`docker compose ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A request to the API, as from its own address, so the limits count each person apart. */
async function api<T>(path: string, body: unknown, from: string, token?: string): Promise<T> {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": from,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as T;
}

const addressOf = (n: number) => `10.${String(Math.floor(n / 250) + 1)}.${String(n % 250)}.1`;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

/** What `docker stats` says of a container: its CPU, as a share of one core, and its memory in MiB. */
interface Sample {
  readonly cpu: number;
  readonly memory: number;
}

function mebibytes(text: string): number {
  const match = /^([\d.]+)\s*([KMG]i?B)/.exec(text.trim());
  if (match === null) return Number.NaN;
  const value = Number(match[1]);
  const unit = match[2] ?? "MiB";
  return unit.startsWith("G") ? value * 1024 : unit.startsWith("K") ? value / 1024 : value;
}

/** Samples the project's containers every five seconds, without blocking the clients. */
function sampleStats(samples: Map<string, Sample[]>): () => void {
  let stopped = false;
  const once = () =>
    new Promise<void>((resolve) => {
      const child = spawn(
        "docker",
        ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      child.on("close", () => {
        for (const line of text.split("\n")) {
          const [name = "", cpu = "", memory = ""] = line.split("\t");
          if (!name.startsWith(`${project}-`)) continue;
          const service = name.slice(project.length + 1).replace(/-\d+$/, "");
          const list = samples.get(service) ?? [];
          list.push({ cpu: Number(cpu.replace("%", "")) / 100, memory: mebibytes(memory) });
          samples.set(service, list);
        }
        resolve();
      });
    });
  // Read through a function: stopping changes it during the waits.
  const running = () => !stopped;
  void (async () => {
    while (running()) {
      await once();
      await pause(5000);
    }
  })();
  return () => {
    stopped = true;
  };
}

interface Person {
  readonly n: number;
  readonly note: number;
  readonly document: Y.Doc;
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  /** The paragraph this person writes in. */
  text?: Y.XmlText;
  sent: number;
}

const latencies: number[] = [];
const token = /u(\d+)n(\d+)t(\d+)/g;
/** Whether a target was missed, or the run could not finish. */
let failed = true;

try {
  const started = Date.now();
  compose(["up", "--detach", "--wait", "--wait-timeout", "300", ...(build ? ["--build"] : [])]);
  for (
    let tries = 0;
    !(await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    ));
    tries++
  ) {
    if (tries === 30) throw new Error("The server did not answer on the host's port.");
    await pause(1000);
  }
  const code = /this code: ([A-Z0-9-]+)/.exec(compose(["logs", "--no-color", "server"]))?.[1];
  if (code === undefined) throw new Error("No setup code in the server's log.");
  const admin = await api<{ token: string; workspace: { id: string } }>(
    "/api/setup",
    {
      code,
      name: "Ada",
      email: "ada@example.org",
      password: "a long password",
      workspace: "Load",
    },
    "10.0.0.1",
  );
  const workspace = admin.workspace.id;
  console.log(`Set up in ${String(Date.now() - started)} ms; making ${String(people)} people.`);

  // Each person: an invitation of their own, accepted as a new account.
  const tokens: string[] = [];
  for (let first = 0; first < people; first += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, people - first) }, async (_, i) => {
        const n = first + i;
        const invitation = await api<{ token: string }>(
          `/api/workspaces/${workspace}/invitations`,
          { role: "member" },
          "10.0.0.1",
          admin.token,
        );
        const accepted = await api<{ token: string }>(
          "/api/invitations/accept",
          {
            token: invitation.token,
            name: `Person ${String(n)}`,
            email: `person${String(n)}@example.org`,
            password: "a long password",
          },
          addressOf(n),
        );
        return accepted.token;
      }),
    );
    tokens.push(...batch);
  }

  // Ten to a note, each on a socket of their own, as each app has one.
  const notes = Array.from({ length: Math.ceil(people / perNote) }, () => crypto.randomUUID());
  const url = `${base.replace(/^http/, "ws")}/api/sync`;
  const everyone: Person[] = tokens.map((session, n) => {
    const note = Math.floor(n / perNote);
    const document = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: `${workspace}/${notes[note] ?? ""}`,
      document,
      token: session,
    });
    provider.attach();
    provider.awareness?.setLocalStateField("user", { name: `Person ${String(n)}` });
    const person: Person = { n, note, document, socket, provider, sent: 0 };
    document.getXmlFragment("content").observeDeep((events, transaction) => {
      if (transaction.local) return;
      const now = Date.now();
      for (const event of events) {
        if (!(event.target instanceof Y.XmlText)) continue;
        for (const change of event.delta) {
          if (typeof change.insert !== "string") continue;
          for (const match of change.insert.matchAll(token)) {
            if (Number(match[1]) !== n) latencies.push(now - Number(match[3]));
          }
        }
      }
    });
    return person;
  });
  const deadline = Date.now() + 120_000;
  while (!everyone.every((person) => person.provider.isSynced)) {
    if (Date.now() > deadline) throw new Error("Not everyone synced within two minutes.");
    await pause(200);
  }
  // Each opens a paragraph of their own at the end of the note.
  for (const person of everyone) {
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    const fragment = person.document.getXmlFragment("content");
    fragment.insert(fragment.length, [paragraph]);
    person.text = text;
  }
  await pause(5000);
  latencies.length = 0;
  console.log(
    `${String(people)} people on ${String(notes.length)} notes; writing for ${String(seconds)} s.`,
  );

  const samples = new Map<string, Sample[]>();
  const stopSampling = sampleStats(samples);
  const end = Date.now() + seconds * 1000;
  const lag: number[] = [];
  await Promise.all(
    everyone.map(async (person) => {
      await pause(Math.random() * 3000);
      while (Date.now() < end) {
        const due = Date.now();
        const text = person.text;
        if (text === undefined) break;
        person.sent += 1;
        text.insert(
          text.length,
          ` u${String(person.n)}n${String(person.sent)}t${String(Date.now())}`,
        );
        person.provider.awareness?.setLocalStateField("cursor", { at: text.length });
        const wait = 2000 + Math.random() * 2000;
        await pause(wait);
        // How late this client's own timer ran: the harness's share of the latency.
        lag.push(Date.now() - due - wait);
      }
    }),
  );
  stopSampling();
  // Then everyone's notes settle, and each should be the same for all, with every word.
  await pause(5000);
  const sent = everyone.reduce((sum, person) => sum + person.sent, 0);
  let lost = 0;
  let differ = 0;
  for (let note = 0; note < notes.length; note++) {
    const there = everyone.filter((person) => person.note === note);
    const texts = new Set(
      there.map((person) => person.document.getXmlFragment("content").toJSON()),
    );
    if (texts.size !== 1) differ += 1;
    const words = [...(there[0]?.document.getXmlFragment("content").toJSON() ?? "").matchAll(token)]
      .length;
    lost += there.reduce((sum, person) => sum + person.sent, 0) - words;
  }
  for (const person of everyone) {
    person.provider.destroy();
    person.socket.destroy();
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const lagSorted = [...lag].sort((a, b) => a - b);
  const stats = Object.fromEntries(
    [...samples].map(([service, list]) => [
      service,
      {
        cpuMean: list.reduce((sum, sample) => sum + sample.cpu, 0) / list.length,
        cpuMax: Math.max(...list.map((sample) => sample.cpu)),
        memoryMaxMiB: Math.max(...list.map((sample) => sample.memory)),
      },
    ]),
  );
  const p95 = percentile(sorted, 95);
  const report = {
    people,
    notes: notes.length,
    seconds,
    wordsSent: sent,
    deliveries: sorted.length,
    latencyMs: {
      p50: percentile(sorted, 50),
      p95,
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? NaN,
    },
    harnessTimerLagMs: { p50: percentile(lagSorted, 50), p95: percentile(lagSorted, 95) },
    containers: stats,
    notesDiffering: differ,
    wordsLost: lost,
    met: { latency: p95 < latencyLimit, sameForAll: differ === 0, nothingLost: lost === 0 },
  };
  failed = !(p95 < latencyLimit && differ === 0 && lost === 0);
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  try {
    compose(["down", "--volumes"]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}
process.exit(failed ? 1 : 0);

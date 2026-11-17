// Measures the Android app (ADR 0087) on a device or an emulator: how long it
// takes to open to the last note, cold, and its memory once idle, the app's
// process and its WebView's renderer together. It drives the app's page in
// its WebView over adb, as the smoke test does, so it needs a build whose
// WebView is open to DevTools: the `perf` build, optimized as a release.
//
//   pnpm --filter @nether/mobile build:page
//   (cd apps/mobile && npx cap sync android && cd android && ./gradlew assemblePerf)
//   pnpm --filter @nether/perf android --notes 5000 --out perf-android-report.json
//
// The first run writes the reference vault into the app, note by note,
// through its own plugin, then opens it once so its index is whole, and
// opens a note, which each cold start then opens to. Numbers from an
// emulator compare one change with another; the targets are for a phone.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { _android as android } from "@playwright/test";
import { generateVault } from "@nether/vault-generator";

const app = "io.github.fzn0x.nether";
const { values } = parseArgs({
  // pnpm passes on a "--" before the harness's own arguments.
  args: process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== "--"),
  options: {
    apk: {
      type: "string",
      default: fileURLToPath(
        new URL(
          "../../../apps/mobile/android/app/build/outputs/apk/perf/app-perf.apk",
          import.meta.url,
        ),
      ),
    },
    notes: { type: "string", default: "5000" },
    runs: { type: "string", default: "5" },
    idle: { type: "string", default: "60" },
    out: { type: "string" },
  },
});
const notes = Number(values.notes);
const runs = Number(values.runs);
const idleSeconds = Number(values.idle);

/** Phone targets (ADR 0087): opening at 5,000 notes and at 50,000, and idle memory. */
const openLimit = notes > 5_000 ? 3_000 : 1_500;
const memoryLimit = 300;

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";
const adb =
  ["adb", "adb.exe"]
    .map((name) => join(sdk, "platform-tools", name))
    .find((path) => sdk !== "" && existsSync(path)) ?? "adb";

function shell(...args: string[]): string {
  return execFileSync(adb, ["shell", ...args], { encoding: "utf8", maxBuffer: 16 << 20 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (list: readonly number[]) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const [attached] = await android.devices();
if (attached === undefined) throw new Error("No device is attached.");
const device = attached;

/** The page in the app's WebView: this process's, never one Playwright knows from before an end. */
async function page() {
  const pid = shell("pidof", app).trim();
  const webView = await device.webView(
    { socketName: `webview_devtools_remote_${pid}` },
    { timeout: 120_000 },
  );
  const opened = await webView.page();
  opened.setDefaultTimeout(600_000);
  return opened;
}

/** The milliseconds since the process started at which the page reached a mark, from the log. */
async function mark(name: string, timeout: number): Promise<number> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const log = execFileSync(adb, ["logcat", "-d", "-s", "NetherMarks:I"], { encoding: "utf8" });
    const found = new RegExp(`NetherMarks: ${name} (\\d+)`).exec(log);
    if (found?.[1] !== undefined) return Number(found[1]);
    if (Date.now() > deadline) throw new Error(`The page never reached ${name}.`);
    await sleep(200);
  }
}

/** The PSS, in megabytes, of a process by its ID, as dumpsys counts it. */
function pss(pid: string): number {
  const found =
    /TOTAL PSS:\s+(\d+)/.exec(shell("dumpsys", "meminfo", pid)) ??
    /TOTAL\s+(\d+)/.exec(shell("dumpsys", "meminfo", pid));
  return found?.[1] === undefined ? 0 : Number(found[1]) / 1024;
}

execFileSync(adb, ["install", "-r", values.apk], { stdio: "inherit" });
shell("pm", "clear", app);
shell("logcat", "-c");
shell("am", "start", "-W", "-n", `${app}/.MainActivity`);
let shown = await page();

// The reference vault, written into the app through its own plugin.
await shown.getByRole("textbox", { name: "Name" }).fill("Reference");
await shown.getByRole("button", { name: "New vault" }).click();
await shown.getByRole("button", { name: "Notes and menus", exact: true }).waitFor();
const id = await shown.evaluate(async () => {
  const plugins = (globalThis as unknown as { Capacitor: { Plugins: Record<string, unknown> } })
    .Capacitor.Plugins;
  const vaults = plugins.NetherVaults as { vaults(): Promise<{ last?: string }> };
  return (await vaults.vaults()).last ?? "";
});
const files = [...generateVault({ notes, seed: 1 })];
console.log(`Writing ${String(files.length)} files into the vault.`);
for (let start = 0; start < files.length; start += 200) {
  await shown.evaluate(
    async ({ vault, batch }) => {
      const plugins = (globalThis as unknown as { Capacitor: { Plugins: Record<string, unknown> } })
        .Capacitor.Plugins;
      const vaults = plugins.NetherVaults as {
        write(options: { id: string; path: string; text: string; base: string }): Promise<unknown>;
      };
      for (const file of batch) {
        await vaults.write({ id: vault, path: file.path, text: file.content, base: "" });
      }
    },
    { vault: id, batch: files.slice(start, start + 200) },
  );
}

// Opened once, until every note is read, and a note opened for each start to open to.
shell("am", "force-stop", app);
shell("logcat", "-c");
shell("am", "start", "-W", "-n", `${app}/.MainActivity`);
shown = await page();
console.log("Reading every note into the index, once.");
await mark("notes-read", 3_600_000);
const target = files.find((file) => file.path.endsWith(".md"));
if (target === undefined) throw new Error("The vault has no note.");
const title = target.path.slice(target.path.lastIndexOf("/") + 1, -3);
await shown.getByRole("button", { name: "Open a note" }).click();
await shown.getByRole("combobox").fill(title);
await shown.keyboard.press("Enter");
await shown.getByRole("textbox", { name: `${title}, note text` }).waitFor();
await sleep(3_000);

const launches: number[] = [];
const opens: number[] = [];
for (let run = 1; run <= runs; run++) {
  shell("am", "force-stop", app);
  await sleep(2_000);
  shell("logcat", "-c");
  const started = shell("am", "start", "-W", "-n", `${app}/.MainActivity`);
  const launch = /TotalTime:\s+(\d+)/.exec(started)?.[1];
  launches.push(Number(launch ?? Number.NaN));
  opens.push(await mark("note-shown", 120_000));
  console.log(
    `Run ${String(run)}: first frame ${String(launch)} ms, the note shown at ${String(opens.at(-1))} ms.`,
  );
}

console.log(`Idling ${String(idleSeconds)} s.`);
await sleep(idleSeconds * 1_000);
const appPid = shell("pidof", app).trim();
// The WebView's renderer, a process of its own; no other app's WebView runs while measuring.
const renderers = shell("ps", "-A", "-o", "PID,NAME")
  .split("\n")
  .filter((line) => line.includes("sandboxed_process"))
  .map((line) => line.trim().split(/\s+/)[0] ?? "")
  .filter((pid) => pid !== "");
const memory = [appPid, ...renderers].reduce((sum, pid) => sum + pss(pid), 0);

const report = {
  device: shell("getprop", "ro.product.model").trim(),
  android: shell("getprop", "ro.build.version.release").trim(),
  notes,
  firstFrameMs: median(launches),
  openToTheNoteMs: median(opens),
  openLimitMs: openLimit,
  idleMemoryMb: Math.round(memory * 10) / 10,
  memoryLimitMb: memoryLimit,
  runs: { launches, opens },
};
console.log(JSON.stringify(report, null, 2));
if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
await device.close();
if (report.openToTheNoteMs > openLimit || report.idleMemoryMb > memoryLimit) process.exitCode = 1;

// The Android app on a device or an emulator (ADR 0087): installs the debug
// APK, starts it fresh, makes a vault and a note through the page in its
// WebView, which Playwright drives over adb, checks that the back button
// closes the drawer, and that what was typed is there after the app is
// ended, as the system ends apps:
//
// 1. sent home, then forced to stop: the page saved as the app left;
// 2. forced to stop a second and a half after typing, without leaving: the
//    note's document reached the index, and its file, by then.
//
// Then, with a server on this machine (sync-server.ts), which the emulator
// reaches at 10.0.2.2 over plain HTTP, as only the debug build may:
//
// 3. signed in with a password, the workspace opened from the welcome
//    screen as a vault on the phone gets the server's note, and a note
//    typed on the phone reaches the server; ended and started again, the
//    app is still signed in, and a note made on the server then arrives.
//
//   pnpm --filter @nether/mobile smoke [path/to/app-debug.apk]
//
// It needs adb on the PATH, or ANDROID_HOME, and one device attached.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { _android as android } from "@playwright/test";

const app = "io.github.fzn0x.nether";
const apk =
  process.argv[2] ??
  fileURLToPath(new URL("../android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url));
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb =
  sdk !== undefined && existsSync(join(sdk, "platform-tools", "adb"))
    ? join(sdk, "platform-tools", "adb")
    : sdk !== undefined && existsSync(join(sdk, "platform-tools", "adb.exe"))
      ? join(sdk, "platform-tools", "adb.exe")
      : "adb";

function shell(...args) {
  return execFileSync(adb, ["shell", ...args], { encoding: "utf8" });
}

const first = "First words, typed on the phone.";
const second = "Second words, typed just before the app was ended.";
const timeout = 60_000;

const [device] = await android.devices();
if (device === undefined) throw new Error("No device is attached: start an emulator first.");

/**
 * Starts the app and gives the page in its WebView: this process's, by its
 * DevTools socket, never one Playwright still knows from before an end.
 */
async function start() {
  shell("am", "start", "-W", "-n", `${app}/.MainActivity`);
  const pid = shell("pidof", app).trim();
  const webView = await device.webView(
    { socketName: `webview_devtools_remote_${pid}` },
    { timeout },
  );
  const page = await webView.page();
  page.setDefaultTimeout(timeout);
  return page;
}

/** Ends the app as the system does, without asking it. */
async function end() {
  shell("am", "force-stop", app);
  // The WebView's DevTools socket goes with the process.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

/** Waits until `check` says yes, asking again every second, or fails with `what`. */
async function until(what, check) {
  const deadline = Date.now() + timeout;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * The server on this machine, once it listens: its addresses, and requests
 * to Team's notes through the REST API as Ada, who set it up.
 */
async function startServer() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("sync-server.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const ready = await new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("{")) resolve(JSON.parse(line));
    });
    child.on("exit", (code) => {
      reject(new Error(`The server stopped before it listened: ${String(code)}.`));
    });
  });
  return {
    ...ready,
    async api(path, init = {}) {
      const response = await fetch(`${ready.url}/api/v1/workspaces/${ready.workspace}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${ready.token}`, ...init.headers },
      });
      if (!response.ok) throw new Error(`${path}: the server answered ${String(response.status)}.`);
      return response;
    },
    stop() {
      child.kill();
    },
  };
}

const synced = "Typed on the phone, then synced.";

let page;
let server;
try {
  console.log(`Installing ${apk}`);
  execFileSync(adb, ["install", "-r", apk], { stdio: "inherit" });
  shell("pm", "clear", app);
  shell("logcat", "-c");
  // A page draws no frames on a screen that is asleep.
  shell("input", "keyevent", "KEYCODE_WAKEUP");
  shell("wm", "dismiss-keyguard");
  shell("settings", "put", "system", "screen_off_timeout", "1800000");

  page = await start();
  await page.getByRole("textbox", { name: "Name" }).fill("Smoke");
  await page.getByRole("button", { name: "New vault" }).click();
  // The back button closes the drawer, as Escape does, and leaves the app open.
  const menu = page.getByRole("button", { name: "Notes and menus", exact: true });
  await menu.click();
  const drawer = page.getByRole("complementary", { name: "Smoke" });
  await drawer.waitFor({ state: "visible" });
  shell("input", "keyevent", "KEYCODE_BACK");
  await drawer.waitFor({ state: "hidden" });
  console.log("The back button closed the drawer.");
  await menu.click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New note" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Durable");
  await dialog.getByRole("button", { name: "Create" }).click();
  const editor = page.getByRole("textbox", { name: "Durable, note text" });
  await editor.click();
  await page.keyboard.type(first);
  console.log("Typed the first words; sending the app home, then ending it.");

  // 1. Home, then ended: the page saves as the app leaves the screen.
  shell("input", "keyevent", "KEYCODE_HOME");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await end();
  page = await start();
  const again = page.getByRole("textbox", { name: "Durable, note text" });
  await again.getByText(first).waitFor();
  console.log("The first words were there after the app was ended from the home screen.");

  // 2. Ended on screen, a moment after typing.
  await again.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(second);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await end();
  page = await start();
  await page.getByRole("textbox", { name: "Durable, note text" }).getByText(second).waitFor();
  console.log("The second words were there after the app was ended on screen.");

  // 3. Signed in to a server, from a fresh start.
  server = await startServer();
  const host = new URL(server.fromEmulator).host;
  shell("pm", "clear", app);
  page = await start();
  await page.getByRole("button", { name: "Sign in to a server" }).click();
  const servers = page.getByRole("dialog", { name: "Servers" });
  await servers.getByRole("textbox", { name: "Server address" }).fill(server.fromEmulator);
  await servers.getByRole("button", { name: "Continue" }).click();
  await servers.getByRole("textbox", { name: "Email address" }).fill("ada@example.org");
  await servers.getByLabel("Password").fill("a long password");
  await servers.getByRole("button", { name: "Sign in", exact: true }).click();
  await servers.getByText(`Signed in to ${host} as Ada.`).waitFor();
  await page.keyboard.press("Escape");
  await servers.waitFor({ state: "hidden" });
  console.log("Signed in with a password, natively, the token kept by the Keystore's key.");

  await page.getByRole("button", { name: `Open Team, on ${host}` }).click();
  await page.getByRole("button", { name: "Notes and menus", exact: true }).click();
  const team = page.getByRole("complementary", { name: "Team" });
  await team.getByText("From the server", { exact: true }).first().waitFor();
  console.log("The workspace opened as a vault on the phone, with the server's note.");

  await page.getByRole("button", { name: "New note", exact: true }).click();
  const made = page.getByRole("dialog", { name: "New note" });
  await made.getByRole("textbox", { name: "Name" }).fill("From the phone");
  await made.getByRole("button", { name: "Create" }).click();
  await page.getByRole("textbox", { name: "From the phone, note text" }).click();
  await page.keyboard.type(synced);
  await until("the phone's note on the server", async () => {
    const { notes } = await (await server.api(`/notes`)).json();
    const note = notes.find((each) => each.title === "From the phone");
    if (note === undefined) return false;
    const text = await (
      await server.api(`/notes/${note.id}`, { headers: { accept: "text/markdown" } })
    ).text();
    return text.includes(synced);
  });
  console.log("The note typed on the phone reached the server.");

  // Ended and started again: still signed in, it syncs what the server has since.
  await end();
  page = await start();
  await server.api(`/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Later from the server.md", markdown: "Made while away.\n" }),
  });
  // The app opens the vault again at its last note; the drawer opens once
  // the vault shows, not while it is still opening.
  await page.getByRole("textbox", { name: "From the phone, note text" }).waitFor();
  await page.getByRole("button", { name: "Notes and menus", exact: true }).click();
  const teamAgain = page.getByRole("complementary", { name: "Team" });
  await teamAgain.waitFor();
  await teamAgain.getByText("Later from the server", { exact: true }).first().waitFor();
  console.log("Started again, the app was still signed in, and the server's new note arrived.");

  const marks = execFileSync(adb, ["logcat", "-d", "-s", "NetherMarks:I"], { encoding: "utf8" });
  console.log(marks.trim());
  console.log("The smoke test passed.");
} catch (error) {
  if (page !== undefined) {
    await page.screenshot({ path: "smoke-failure.png" }).catch(() => undefined);
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  server?.stop();
  await device.close();
}

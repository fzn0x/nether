// The Android app on a device or an emulator (ADR 0087): installs the debug
// APK, starts it fresh, makes a vault and a note through the page in its
// WebView, which Playwright drives over adb, and checks that what was typed
// is there after the app is ended, as the system ends apps:
//
// 1. sent home, then forced to stop: the page saved as the app left;
// 2. forced to stop a second and a half after typing, without leaving: the
//    note's document reached the index, and its file, by then.
//
//   pnpm --filter @nether/mobile smoke [path/to/app-debug.apk]
//
// It needs adb on the PATH, or ANDROID_HOME, and one device attached.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** Starts the app and gives the page in its WebView. */
async function start() {
  shell("am", "start", "-W", "-n", `${app}/.MainActivity`);
  const webView = await device.webView({ pkg: app }, { timeout });
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

let page;
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
  await page.getByRole("button", { name: "Notes and menus", exact: true }).click();
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
  await device.close();
}

// What the phone hands the app (ADR 0087), as the page's `captures`: the
// app icon's shortcuts, through @capawesome/capacitor-app-shortcuts, and
// what the share sheet handed the plugin's `NetherInbox`. The shortcut that
// started the app is kept by its plugin until the page listens, which it
// does as this module loads, before any vault opens. The inbox is read as
// the page first listens, as a share comes in on Android, and as the app
// comes back on screen, which is when iOS's share extension has written to
// it. A capture is written into the vault's folder through the plugin's
// `NetherVaults`, its files moved in from the inbox without crossing the
// bridge.
import type { AppShortcutsPlugin } from "@capawesome/capacitor-app-shortcuts";
import { DeviceFiles } from "@nether/storage";
import type { CaptureShortcutLabel, Captures } from "./backend.ts";
import { type Capture, type CaptureShortcut, type Shared, isCaptureShortcut } from "./capture.ts";
import { filesTarget } from "./captureFiles.ts";
import type { InboxCapture, NetherInboxPlugin, NetherVaultsPlugin } from "./mobile.ts";
import { phoneFolder } from "./mobileFiles.ts";

/** What the page's captures are made of on a phone, each stood in for in the tests. */
export interface PhoneCaptureParts {
  readonly inbox: NetherInboxPlugin;
  readonly vaults: NetherVaultsPlugin;
  readonly shortcuts: Pick<AppShortcutsPlugin, "set" | "addListener">;
  /** `android` or `ios`, as Capacitor names the platform. */
  readonly platform: string;
  /** Runs `listener` as the app comes back on screen; returns what stops it. */
  readonly onResume: (listener: () => void) => () => void;
  /** Asks the vault with this ID, if it is open, to look at its folder again. */
  readonly rescan: (vault: string) => void;
  /** Puts the app away, back to the app that shared, on Android. */
  readonly minimize: () => void;
}

/** Each shortcut's icon: one of Android's own drawables, and an SF Symbol on iOS. */
const icons: Readonly<Record<CaptureShortcut, { readonly android: string; readonly ios: string }>> =
  {
    capture: { android: "ic_menu_edit", ios: "square.and.pencil" },
    newNote: { android: "ic_menu_add", ios: "doc.badge.plus" },
    dayNote: { android: "ic_menu_today", ios: "calendar" },
    search: { android: "ic_menu_search", ios: "magnifyingglass" },
  };

/** The shortcuts as the plugin takes them. */
export function shortcutsOf(labels: readonly CaptureShortcutLabel[]) {
  return labels.map((label) => ({
    id: label.id,
    title: label.title,
    description: label.description,
    androidIcon: icons[label.id].android,
    iosIcon: icons[label.id].ios,
  }));
}

/** A capture of the inbox as the page takes it. */
export function sharedOf(capture: InboxCapture): Shared {
  return {
    id: capture.id,
    at: capture.at,
    text: capture.text ?? "",
    files: capture.files,
    ...(capture.title === undefined || capture.title === "" ? {} : { title: capture.title }),
    ...(capture.url === undefined || capture.url === "" ? {} : { url: capture.url }),
    ...(capture.vault === undefined || capture.vault === "" ? {} : { vault: capture.vault }),
    ...(capture.newVault === undefined || capture.newVault === ""
      ? {}
      : { newVault: capture.newVault }),
  };
}

/**
 * Moves a file of the inbox into a vault under the first free name beside
 * `path`, numbered as attachments are; gives the path it went to.
 */
export async function adoptFile(
  vaults: NetherVaultsPlugin,
  id: string,
  path: string,
  from: string,
): Promise<string> {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 0; ; n++) {
    const target = n === 0 ? path : `${stem} ${String(n)}${ext}`;
    const { result, file } = await vaults.adopt({ id, path: target, from });
    if (result === "exists") continue;
    if (file === undefined) throw new Error(`${target}: the move gave nothing back.`);
    return file.path;
  }
}

export function phoneCaptures(parts: PhoneCaptureParts): Captures {
  const listeners = new Set<(capture: Capture) => void>();
  /** What came while no one listened, given to the next listener. */
  const waiting: Capture[] = [];
  /** The inbox's captures handed to the page in this run of the app, each once. */
  const handed = new Set<string>();
  const hand = (capture: Capture) => {
    if (listeners.size === 0) waiting.push(capture);
    for (const listener of listeners) listener(capture);
  };

  // At once: the plugin keeps the shortcut that started the app until then.
  void parts.shortcuts.addListener("click", ({ shortcutId }) => {
    if (isCaptureShortcut(shortcutId)) hand({ kind: "shortcut", shortcut: shortcutId });
  });

  /** Reads the inbox, and hands the page what it has not had yet. */
  const read = async () => {
    try {
      const { captures } = await parts.inbox.pending();
      for (const capture of captures) {
        if (handed.has(capture.id)) continue;
        handed.add(capture.id);
        hand({ kind: "shared", shared: sharedOf(capture) });
      }
    } catch {
      // The inbox is read again as the app comes back.
    }
  };
  /** One read at a time, each after the last. */
  let reading: Promise<void> = Promise.resolve();
  const look = () => {
    reading = reading.then(read);
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    if (parts.platform === "android") void parts.inbox.addListener("shared", look);
    parts.onResume(look);
    look();
  };

  return {
    listen(listener) {
      listeners.add(listener);
      for (const capture of waiting.splice(0)) listener(capture);
      start();
      return () => {
        listeners.delete(listener);
      };
    },
    target(vault) {
      const files = new DeviceFiles(phoneFolder(parts.vaults, vault.id));
      return Promise.resolve(
        filesTarget(files, (path, file) => adoptFile(parts.vaults, vault.id, path, file.path)),
      );
    },
    done: (id) => parts.inbox.drop({ id }),
    filed: parts.rescan,
    setShortcuts: (labels) => parts.shortcuts.set({ shortcuts: shortcutsOf(labels) }),
    ...(parts.platform === "android" ? { leave: parts.minimize } : {}),
  };
}

// The mobile apps' backend (ADR 0087), loaded in their build alone: the
// desktop app's model on a phone. Vaults of the phone's own, each a folder
// of Markdown files in the app's storage, reached through the app's plugin
// (mobile.ts), with its index in SQLite through @capacitor-community/sqlite.
// It works with no account. Images and PDFs load from the files' own URLs.
// Before the app leaves the screen, the page saves what it holds, in the
// time the system gives; as it comes back, each open vault looks at its
// folder again, for what another app changed. Signing in and sync come
// with the apps' fourth part, and exports through the share sheet with the
// fifth: until then the build leaves them out (features.ts).
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { BackgroundTask } from "@capawesome/capacitor-background-task";
import { DeviceFiles, SqliteStore } from "@nether/storage";
import type { Backend, Connection, Exporter, VaultMedia } from "./backend.ts";
import { t } from "./messages.ts";
import { NetherVaults, type PhoneVault } from "./mobile.ts";
import { phoneFolder } from "./mobileFiles.ts";
import { openMobileIndex, pluginConnections } from "./mobileIndex.ts";
import type { VaultInfo } from "./mygo.ts";
import { webImporter } from "./webImports.ts";

function vaultOf(vault: PhoneVault): VaultInfo {
  return { id: vault.id, name: vault.name, path: vault.path };
}

/** A path's segments escaped for a URL, its slashes kept. */
function escapePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Exports come with the share sheet, in the apps' fifth part; until then they say so. */
const laterExporter: Exporter = {
  choose: () => Promise.reject(new Error(t("mobileExportLater"))),
  add: () => Promise.reject(new Error(t("mobileExportLater"))),
  finish: () => Promise.reject(new Error(t("mobileExportLater"))),
  printPdf: () => Promise.reject(new Error(t("mobileExportLater"))),
  saveText: () => Promise.reject(new Error(t("mobileExportLater"))),
  cancel: () => Promise.resolve(),
};

/** The vaults open now, each told to look again as the app comes back. */
const open = new Set<DeviceFiles>();
/** What the page saves before the app leaves the screen. */
const leaving = new Set<() => Promise<void>>();

let listening = false;

/** Follows the app leaving the screen and coming back, once. */
function followTheApp(): void {
  if (listening) return;
  listening = true;
  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      for (const files of open) files.rescan();
      return;
    }
    if (leaving.size === 0) return;
    // The system lets the app finish within its time: on iOS about 30 seconds.
    let given: (id: string) => void = () => undefined;
    const taskId = new Promise<string>((resolve) => {
      given = resolve;
    });
    const save = async () => {
      try {
        await Promise.allSettled([...leaving].map((each) => each()));
      } finally {
        BackgroundTask.finish({ taskId: await taskId });
      }
    };
    void BackgroundTask.beforeExit(() => {
      void save();
    }).then(given);
  });
}

/** Not before the apps' fourth part, which signs in. */
function later<T>(): Promise<T> {
  return Promise.reject(new Error(t("mobileSignInLater")));
}

export const mobile: Backend = {
  kind: "mobile",
  async startup() {
    // The phone opens to the vault it had open last.
    const { vaults, last } = await NetherVaults.vaults();
    const vault = vaults.find((each) => each.id === last);
    return vault === undefined ? null : { vault: vaultOf(vault), note: "" };
  },
  async recent() {
    return (await NetherVaults.vaults()).vaults.map(vaultOf);
  },
  // There is no folder to choose: the welcome screen asks for a name.
  choose: () => Promise.resolve(null),
  async open(idOrName) {
    const { vaults } = await NetherVaults.vaults();
    const known = vaults.find((each) => each.id === idOrName);
    return vaultOf(
      await NetherVaults.openVault(known === undefined ? { name: idOrName } : { id: known.id }),
    );
  },
  forget: (id) => NetherVaults.forgetVault({ id }),
  async connect(vault): Promise<Connection> {
    followTheApp();
    const files = new DeviceFiles(phoneFolder(NetherVaults, vault.id));
    const store = await SqliteStore.open(
      await openMobileIndex(await pluginConnections(), vault.id),
    );
    const { path: root } = await NetherVaults.root({ id: vault.id });
    const base = `${Capacitor.convertFileSrc(root).replace(/\/$/, "")}/`;
    const media: VaultMedia = { url: (path) => base + escapePath(path) };
    open.add(files);
    return {
      files,
      store,
      media,
      exporter: laterExporter,
      importer: webImporter(async (dest, data) => (await files.attach(dest, data)).path),
    };
  },
  onBackground(save) {
    followTheApp();
    leaving.add(save);
    return () => {
      leaving.delete(save);
    };
  },
  fetchPreview: () => Promise.reject(new Error(t("previewNeedsApp"))),
  openUrl(url) {
    window.open(url, "_blank", "noopener");
    return Promise.resolve();
  },
  serverFetch: () => later(),
  servers: () => Promise.resolve([]),
  saveServer: () => later(),
  serverToken: () => Promise.resolve(undefined),
  forgetServer: () => Promise.resolve(),
  serverKey: () => Promise.resolve(undefined),
  saveServerKey: () => later(),
  loopback: () => later(),
  syncSocket: () => Promise.resolve(globalThis.WebSocket),
  // AI comes to the phones in a part of its own: with no provider, nothing of it shows (ADR 0068).
  aiSettings: () => Promise.resolve({ providers: [], default: "" }),
  saveAiProvider: () => Promise.reject(new Error(t("mobileAiLater"))),
  setAiKey: () => Promise.reject(new Error(t("mobileAiLater"))),
  removeAiProvider: () => Promise.resolve(),
  setDefaultAiProvider: () => Promise.resolve(),
  aiAccess: () => Promise.reject(new Error(t("mobileAiLater"))),
  // The stores update the apps.
  updateSettings: () => Promise.resolve({ available: false, automatic: false }),
  setAutomaticUpdates: () => Promise.resolve(),
  checkForUpdates: () => Promise.resolve(),
  mark(name) {
    void NetherVaults.mark({ name });
  },
  settle() {
    // The WebView's memory is its own.
  },
};

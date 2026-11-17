// The mobile apps' backend (ADR 0087), loaded in their build alone: the
// desktop app's model on a phone. Vaults of the phone's own, each a folder
// of Markdown files in the app's storage, reached through the app's plugin
// (mobile.ts), with its index in SQLite through @capacitor-community/sqlite.
// It works with no account. Images and PDFs load from the files' own URLs.
// Before the app leaves the screen, the page saves what it holds, in the
// time the system gives; as it comes back, each open vault looks at its
// folder again, for what another app changed, and sync starts again at
// once. Android's back button and gesture close what is open, then put the
// app away.
//
// Servers are reached natively (mobileHttp.ts), signed in to with a bearer
// token kept in the system's secure storage (mobileServers.ts), and a
// provider's sign-in comes back to the app's own scheme (mobileSignIn.ts).
// Exports through the share sheet come with the apps' fifth part: until then
// the build leaves them out (features.ts).
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { BackgroundTask } from "@capawesome/capacitor-background-task";
import { DeviceFiles, SqliteStore } from "@nether/storage";
import type { Backend, Connection, Exporter, VaultMedia } from "./backend.ts";
import { t } from "./messages.ts";
import { NetherVaults, type PhoneVault } from "./mobile.ts";
import { phoneFolder } from "./mobileFiles.ts";
import { nativeFetch } from "./mobileHttp.ts";
import { openMobileIndex, pluginConnections } from "./mobileIndex.ts";
import { phoneServers, secureSecrets } from "./mobileServers.ts";
import { type Handoff, returnScheme, schemeWait } from "./mobileSignIn.ts";
import type { VaultInfo } from "./mygo.ts";
import { type VaultLink, linkVaultStore } from "./sync.ts";
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
/** What runs as the app comes back on screen, or the network comes back. */
const resuming = new Set<() => void>();
/** The workspaces each new vault links to as it opens, by the vault's ID. */
const linking = new Map<string, VaultLink>();

function resume(): void {
  for (const listener of resuming) listener();
}

let listening = false;

/** Follows the app leaving the screen and coming back, once. */
function followTheApp(): void {
  if (listening) return;
  listening = true;
  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      for (const files of open) files.rescan();
      resume();
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
  void App.addListener("backButton", goBack);
  window.addEventListener("online", resume);
}

/** What the back button and gesture close first: a menu, a dialog, or the drawer. */
const closable = '[role="menu"], [role="dialog"], .vault.drawer-open';

/**
 * The back button and gesture on Android: they close what is open, as
 * Escape does where the focus is, and otherwise put the app away, as the
 * system's own back does at an app's first screen.
 */
export function goBack(): void {
  if (document.querySelector(closable) === null) {
    void App.minimizeApp();
    return;
  }
  const target =
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

/** Listens to a plugin's event, giving what stops it, as the handoff takes it. */
function stopper(added: Promise<{ remove: () => Promise<void> }>): () => void {
  return () => {
    void added.then((handle) => handle.remove());
  };
}

/** A provider's sign-in, on this phone's system. */
const handoff: Handoff = {
  ...(Capacitor.getPlatform() === "ios"
    ? {
        sheet: async (url: string) =>
          (await NetherVaults.signIn({ url, scheme: returnScheme })).url,
      }
    : {}),
  openTab: (url) => Browser.open({ url }),
  onAddress: (listener) =>
    stopper(
      App.addListener("appUrlOpen", ({ url }) => {
        listener(url);
      }),
    ),
  onTabClosed: (listener) => stopper(Browser.addListener("browserFinished", listener)),
};

const servers = phoneServers(NetherVaults, secureSecrets());

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
  async openWorkspace(link) {
    const vault = await NetherVaults.openVault({ name: link.workspaceName, fresh: true });
    linking.set(vault.id, link);
    return vaultOf(vault);
  },
  async connect(vault): Promise<Connection> {
    followTheApp();
    const files = new DeviceFiles(phoneFolder(NetherVaults, vault.id));
    const store = await SqliteStore.open(
      await openMobileIndex(await pluginConnections(), vault.id),
    );
    // A workspace opened on the phone syncs from its first opening.
    const link = linking.get(vault.id);
    if (link !== undefined) {
      await linkVaultStore(store, link);
      linking.delete(vault.id);
    }
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
  onResume(listener) {
    followTheApp();
    resuming.add(listener);
    return () => {
      resuming.delete(listener);
    };
  },
  fetchPreview: () => Promise.reject(new Error(t("previewNeedsApp"))),
  // In the system's browser view, over the app: a Custom Tab, or Safari's.
  openUrl: (url) => Browser.open({ url }),
  serverFetch: nativeFetch((options) => CapacitorHttp.request(options)),
  ...servers,
  loopback: () => Promise.resolve(schemeWait(handoff)),
  // The WebView's own.
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

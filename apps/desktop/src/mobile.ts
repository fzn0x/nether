// The mobile apps' own plugin (ADR 0087), `NetherVaults`, in apps/mobile:
// Java on Android and Swift on iOS, what Go is on the desktop. It keeps the
// list of vaults on the phone, and of the servers signed in to, without
// their tokens, and does to each vault's folder only what needs the disk:
// lists, reads with each file's SHA-256, writes in one step after checking
// the file is still what the page read, moves, and makes and removes
// folders. Paths are the vault's, separated by slashes; bytes cross the
// bridge as base64. On iOS it also opens a provider's sign-in in the
// system's sheet. It writes exports' ZIPs from the vault's files, and moves
// a capture's files in from the plugin's inbox, `NetherInbox`, which keeps
// what the share sheet hands the app.
import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";
import type { FileHash, FileInfo, FileText } from "@nether/storage";
import type { SharedFile } from "./capture.ts";
import type { ExportEntry, ServerAccount } from "./mygo.ts";

/** A vault on the phone: its ID, from its `.nether/vault.json`, its name, and its folder's name. */
export interface PhoneVault {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface NetherVaultsPlugin {
  /** The vaults on the phone, the latest opened first, and the one opened last. */
  vaults(): Promise<{ readonly vaults: readonly PhoneVault[]; readonly last?: string }>;
  /**
   * Opens a vault by its ID, or by a name, making it when none has the name;
   * with `fresh`, always a new folder, numbered after the name when its
   * folder is there, as for a workspace opened on the phone.
   */
  openVault(options: {
    readonly id?: string;
    readonly name?: string;
    readonly fresh?: boolean;
  }): Promise<PhoneVault>;
  /** Takes a vault off the list; its folder stays, and opening its name finds it again. */
  forgetVault(options: { readonly id: string }): Promise<void>;
  /** The vault's folder on the disk, for the URLs its files load from. */
  root(options: { readonly id: string }): Promise<{ readonly path: string }>;
  walk(options: {
    readonly id: string;
    readonly folder: string;
  }): Promise<{ readonly files: readonly FileInfo[] }>;
  folders(options: {
    readonly id: string;
    readonly folder: string;
  }): Promise<{ readonly folders: readonly string[] }>;
  stat(options: {
    readonly id: string;
    readonly paths: readonly string[];
  }): Promise<{ readonly files: readonly FileInfo[] }>;
  readText(options: {
    readonly id: string;
    readonly paths: readonly string[];
  }): Promise<{ readonly files: readonly FileText[] }>;
  readBytes(options: {
    readonly id: string;
    readonly path: string;
  }): Promise<{ readonly file?: FileHash & { readonly data: string } }>;
  /** Writes `text`, or `data` in base64. */
  write(options: {
    readonly id: string;
    readonly path: string;
    readonly text?: string;
    readonly data?: string;
    readonly base: string;
  }): Promise<{ readonly result: "written" | "exists" | "changed"; readonly file?: FileHash }>;
  move(options: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
  }): Promise<{ readonly result: "moved" | "exists" | "missing"; readonly file?: FileInfo }>;
  delete(options: {
    readonly id: string;
    readonly path: string;
  }): Promise<{ readonly deleted: boolean }>;
  makeFolder(options: {
    readonly id: string;
    readonly path: string;
  }): Promise<{ readonly result: "made" | "exists" }>;
  removeFolder(options: {
    readonly id: string;
    readonly path: string;
  }): Promise<{ readonly result: "removed" | "missing" | "full" }>;
  /** Writes a point the page reached to the system's log, with the time since the app started. */
  mark(options: { readonly name: string }): Promise<void>;
  /** The servers signed in to, with their accounts and without their tokens, the latest first. */
  servers(): Promise<{ readonly servers: readonly ServerAccount[] }>;
  /** Puts a server's account first on the list, in place of any of the same address. */
  saveServer(options: { readonly account: ServerAccount }): Promise<void>;
  /** Takes a server off the list. */
  forgetServer(options: { readonly url: string }): Promise<void>;
  /**
   * iOS only: opens a provider's sign-in in ASWebAuthenticationSession,
   * which takes the scheme back itself; gives the address it came back to,
   * none when cancelled.
   */
  signIn(options: {
    readonly url: string;
    readonly scheme: string;
  }): Promise<{ readonly url?: string }>;
  /**
   * Moves a file the app keeps for a capture, at `from`, into the vault at
   * `path`, unless a file is there: the capture's own files never cross the
   * bridge. `from` must be in the app's inbox.
   */
  adopt(options: {
    readonly id: string;
    readonly path: string;
    readonly from: string;
  }): Promise<{ readonly result: "written" | "exists"; readonly file?: FileInfo }>;
  /** Starts an export's ZIP in the app's cache, as `name.zip`; gives its token. */
  exportStart(options: { readonly name: string }): Promise<{ readonly token: string }>;
  /** Adds to an export's ZIP text the page made, or a file of the vault by its path, `source`. */
  exportAdd(options: {
    readonly token: string;
    readonly id: string;
    readonly entries: readonly ExportEntry[];
  }): Promise<void>;
  /** Completes an export's ZIP; gives where its file is, for the share sheet. */
  exportFinish(options: { readonly token: string }): Promise<{ readonly path: string }>;
  /** Drops an export's ZIP, unfinished. */
  exportCancel(options: { readonly token: string }): Promise<void>;
  /** Writes a text the page made into the app's cache as a file named `name`, for the share sheet; gives where. */
  exportText(options: {
    readonly name: string;
    readonly text: string;
  }): Promise<{ readonly path: string }>;
}

export const NetherVaults = registerPlugin<NetherVaultsPlugin>("NetherVaults");

/** What another app shared to Nether, kept by the app's inbox until it is filed. */
export interface InboxCapture {
  readonly id: string;
  /** When it was shared, in milliseconds since 1970. */
  readonly at: number;
  readonly text?: string;
  readonly title?: string;
  readonly url?: string;
  /** Each file shared, kept in the inbox, by its path on the phone. */
  readonly files: readonly SharedFile[];
  /** The vault iOS's share extension chose. */
  readonly vault?: string;
  /** A vault for the share extension to make, by its name, when the phone had none. */
  readonly newVault?: string;
}

/**
 * The plugin's `NetherInbox`: what the share sheet hands the app. On
 * Android, shares come to the app's activity, which copies their files
 * into its cache and tells the page; on iOS, the share extension writes
 * them to the App Group's inbox, which the page reads as the app opens or
 * comes back.
 */
export interface NetherInboxPlugin {
  /** What was shared and is not filed or dropped yet, the oldest first. */
  pending(): Promise<{ readonly captures: readonly InboxCapture[] }>;
  /** Forgets a capture, with the files kept for it. */
  drop(options: { readonly id: string }): Promise<void>;
  /** On Android, a share came in, which `pending` now gives. */
  addListener(event: "shared", listener: () => void): Promise<PluginListenerHandle>;
}

export const NetherInbox = registerPlugin<NetherInboxPlugin>("NetherInbox");

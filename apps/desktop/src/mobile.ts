// The mobile apps' own plugin (ADR 0087), `NetherVaults`, in apps/mobile:
// Java on Android and Swift on iOS, what Go is on the desktop. It keeps the
// list of vaults on the phone, and does to each vault's folder only what
// needs the disk: lists, reads with each file's SHA-256, writes in one step
// after checking the file is still what the page read, moves, and makes and
// removes folders. Paths are the vault's, separated by slashes; bytes cross
// the bridge as base64.
import { registerPlugin } from "@capacitor/core";
import type { FileHash, FileInfo, FileText } from "@nether/storage";

/** A vault on the phone: its ID, from its `.nether/vault.json`, its name, and its folder's name. */
export interface PhoneVault {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface NetherVaultsPlugin {
  /** The vaults on the phone, the latest opened first, and the one opened last. */
  vaults(): Promise<{ readonly vaults: readonly PhoneVault[]; readonly last?: string }>;
  /** Opens a vault by its ID, or by a name, making it when none has the name. */
  openVault(options: { readonly id?: string; readonly name?: string }): Promise<PhoneVault>;
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
}

export const NetherVaults = registerPlugin<NetherVaultsPlugin>("NetherVaults");

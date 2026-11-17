// Which plugins are on in a vault, and their settings (ADR 0055).
// `.nether/plugins.json` maps a plugin's ID to whether it is on: a built-in
// plugin it does not name is on, and one from a folder only once it is on
// there and this device approved its code (ADR 0058). A plugin's settings
// are its `.nether/plugins/<id>/data.json`. None of it syncs, like the rest
// of `.nether`.
import { type Manifest, readManifest } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import { useCallback, useEffect, useState } from "react";
import {
  type Approval,
  type FolderEntry,
  isApproved,
  readApprovals,
  readFolders,
  writeApprovals,
} from "./folders.ts";
import type { BuiltinPlugin } from "./host.ts";

/** A built-in plugin with its manifest read. */
export interface Builtin {
  readonly plugin: BuiltinPlugin;
  readonly manifest: Manifest;
}

/** The built-in plugins whose manifests read; one that does not is left out. */
export function readBuiltins(plugins: readonly BuiltinPlugin[]): readonly Builtin[] {
  return plugins.flatMap((plugin) => {
    const { manifest } = readManifest(plugin.manifest);
    return manifest === undefined ? [] : [{ plugin, manifest }];
  });
}

export interface PluginState {
  /** Whether each plugin the vault names is on. */
  readonly on: Readonly<Record<string, boolean>>;
  /** Each plugin's settings as the vault keeps them, by ID. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The plugins in the vault's folders. */
  readonly folders: readonly FolderEntry[];
  /** What this device approved of them, by ID. */
  readonly approvals: Readonly<Record<string, Approval>>;
}

/** What `.nether/plugins.json` says, its entries that are not true or false left out. */
export function readOn(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

/**
 * Whether a built-in plugin is on: unless the vault turned it off, or, for
 * one that starts off, as integrations do (ADR 0090), once it turned it on.
 */
export function isOn(state: Pick<PluginState, "on">, id: string, startsOff = false): boolean {
  return state.on[id] ?? !startsOff;
}

/**
 * Whether a plugin from a folder runs: when nothing keeps it from it, the
 * vault has it on, and this device approved it as it is.
 */
export function isFolderOn(
  state: Pick<PluginState, "on" | "approvals">,
  entry: FolderEntry,
): boolean {
  const id = entry.manifest?.id;
  return (
    id !== undefined &&
    entry.problems.length === 0 &&
    state.on[id] === true &&
    isApproved(entry, state.approvals[id])
  );
}

const dataOf = (id: string) => `plugins/${id}/data`;

/** Reads the vault's plugins: which are on, its folders, and the settings of those with any. */
async function readState(
  vault: Vault,
  vaultId: string,
  builtins: readonly Builtin[],
): Promise<PluginState> {
  const builtinIds = new Set(builtins.map((each) => each.manifest.id));
  const [on, folders] = await Promise.all([
    vault.readData("plugins"),
    readFolders(vault, builtinIds),
  ]);
  const withSettings = [
    ...builtins.map((each) => each.manifest),
    ...folders.flatMap((each) => (each.manifest === undefined ? [] : [each.manifest])),
  ].filter((manifest) => manifest.contributes.settings.length > 0);
  const stored = await Promise.all(withSettings.map((each) => vault.readData(dataOf(each.id))));
  return {
    on: readOn(on),
    settings: Object.fromEntries(withSettings.map((each, at) => [each.id, stored[at]])),
    folders,
    approvals: readApprovals(vaultId),
  };
}

/**
 * The vault's plugins, read when it opens, and again when asked: which are
 * on, those in its folders and what this device approved of them, and the
 * settings of those that have any. Undefined until read.
 */
export function usePluginState(
  vault: Vault | undefined,
  vaultId: string,
  builtins: readonly Builtin[],
): {
  readonly state: PluginState | undefined;
  /** Reads the vault's plugins again, as when one was put in its folder. */
  readonly reload: () => void;
  /**
   * Keeps which plugins are on, and what this device approved of those from
   * folders; rejects with why it could not.
   */
  readonly saveOn: (
    on: Readonly<Record<string, boolean>>,
    approvals?: Readonly<Record<string, Approval>>,
  ) => Promise<void>;
  /** Keeps a plugin's settings; rejects with why it could not. */
  readonly saveSettings: (id: string, values: unknown) => Promise<void>;
} {
  const [state, setState] = useState<PluginState | undefined>();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (vault === undefined) return;
    let current = true;
    void readState(vault, vaultId, builtins).then((read) => {
      if (current) setState(read);
    });
    return () => {
      current = false;
    };
  }, [vault, vaultId, builtins, reads]);
  const reload = useCallback(() => {
    setReads((count) => count + 1);
  }, []);

  const saveOn = useCallback(
    async (
      on: Readonly<Record<string, boolean>>,
      approvals?: Readonly<Record<string, Approval>>,
    ) => {
      if (vault === undefined) return;
      // The approval first: a plugin the vault has on runs only once this device approved it.
      if (approvals !== undefined) writeApprovals(vaultId, approvals);
      await vault.writeData("plugins", on);
      setState((last) =>
        last === undefined ? last : { ...last, on, approvals: approvals ?? last.approvals },
      );
    },
    [vault, vaultId],
  );
  const saveSettings = useCallback(
    async (id: string, values: unknown) => {
      if (vault === undefined) return;
      await vault.writeData(dataOf(id), values);
      setState((last) =>
        last === undefined ? last : { ...last, settings: { ...last.settings, [id]: values } },
      );
    },
    [vault],
  );
  return { state, reload, saveOn, saveSettings };
}

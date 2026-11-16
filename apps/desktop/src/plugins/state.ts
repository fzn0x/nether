// Which plugins are on in a vault, and their settings (ADR 0055).
// `.nether/plugins.json` maps a plugin's ID to whether it is on: a built-in
// plugin it does not name is on. A plugin's settings are its
// `.nether/plugins/<id>/data.json`. Neither syncs, like the rest of
// `.nether`.
import { type Manifest, readManifest } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import { useCallback, useEffect, useState } from "react";
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

/** Whether a built-in plugin is on: unless the vault turned it off. */
export function isOn(state: PluginState, id: string): boolean {
  return state.on[id] ?? true;
}

const dataOf = (id: string) => `plugins/${id}/data`;

/**
 * The vault's plugins, read when it opens: which are on, and the settings
 * of those of `builtins` that have any. Undefined until read.
 */
export function usePluginState(
  vault: Vault | undefined,
  builtins: readonly Builtin[],
): {
  readonly state: PluginState | undefined;
  /** Keeps which plugins are on; rejects with why it could not. */
  readonly saveOn: (on: Readonly<Record<string, boolean>>) => Promise<void>;
  /** Keeps a plugin's settings; rejects with why it could not. */
  readonly saveSettings: (id: string, values: unknown) => Promise<void>;
} {
  const [state, setState] = useState<PluginState | undefined>();
  useEffect(() => {
    if (vault === undefined) return;
    let current = true;
    const withSettings = builtins.filter((each) => each.manifest.contributes.settings.length > 0);
    void Promise.all([
      vault.readData("plugins"),
      ...withSettings.map((each) => vault.readData(dataOf(each.manifest.id))),
    ]).then(([on, ...stored]) => {
      if (!current) return;
      setState({
        on: readOn(on),
        settings: Object.fromEntries(
          withSettings.map((each, at) => [each.manifest.id, stored[at]]),
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [vault, builtins]);

  const saveOn = useCallback(
    async (on: Readonly<Record<string, boolean>>) => {
      if (vault === undefined) return;
      await vault.writeData("plugins", on);
      setState((last) => (last === undefined ? last : { ...last, on }));
    },
    [vault],
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
  return { state, saveOn, saveSettings };
}

// The properties the app changes on this device, which built-in plugins
// watch (ADR 0072): a row's status set in a cell, say, which its database's
// triggers follow. A change that arrives by sync, from another app's edit
// of the file or through the REST API is not the app's, and is not told;
// nor is what a watcher writes itself.
import type { JsonValue, NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import type { Vault } from "@nether/storage";
import { useCallback, useSyncExternalStore } from "react";
import { KeyedRegistry } from "./keyed.ts";

/** A property of a note the app changed on this device, once it is written. */
export interface PropertyChange {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  readonly note: NoteId;
  readonly key: string;
  /** Its value before; undefined when the note had none. */
  readonly before: JsonValue | undefined;
  /** Its value after; undefined when the note has none now. */
  readonly after: JsonValue | undefined;
}

/** What a plugin runs for each change; it rejects with why it could not. */
export type PropertyWatcher = (change: PropertyChange) => Promise<void>;

interface Watching {
  readonly plugin: string;
  readonly watch: PropertyWatcher;
}

export class PropertyChangeRegistry extends KeyedRegistry<Watching> {
  /** Adds a plugin's watcher; returns what takes it away again. */
  add(plugin: string, watch: PropertyWatcher): () => void {
    return this.addAt(plugin, { plugin, watch }, () => `The plugin ${plugin} watches already.`);
  }

  /** Whether a plugin watches the app's changes: without one, no trigger runs. */
  watched(): boolean {
    return this.all().length > 0;
  }

  /** Tells each watcher of a change; resolves once all are done, and rejects with the first that failed. */
  async changed(change: PropertyChange): Promise<void> {
    const results = await Promise.allSettled(this.all().map((each) => each.watch(change)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }

  /** Tells each watcher of every property that differs between two lists of a note's properties. */
  async changedFrom(
    change: Omit<PropertyChange, "key" | "before" | "after">,
    before: readonly { readonly key: string; readonly value: JsonValue }[],
    after: readonly { readonly key: string; readonly value: JsonValue }[],
  ): Promise<void> {
    const keys = new Set([...before, ...after].map((entry) => entry.key));
    const valueIn = (list: typeof before, key: string) =>
      list.find((entry) => entry.key === key)?.value;
    const changes = [...keys].flatMap((key) => {
      const was = valueIn(before, key);
      const now = valueIn(after, key);
      return JSON.stringify(was) === JSON.stringify(now) ? [] : [{ key, before: was, after: now }];
    });
    for (const each of changes) await this.changed({ ...change, ...each });
  }
}

/** Whether a plugin watches the app's changes, as that changes. */
export function useWatched(changes: PropertyChangeRegistry): boolean {
  return useSyncExternalStore(
    useCallback((listener: () => void) => changes.subscribe(listener), [changes]),
    () => changes.watched(),
  );
}

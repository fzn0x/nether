// The property types plugins add (ADR 0057), each `plugin-id/type`, which
// store as one of the app's types: the type menus list them, and a value
// of one shows in its plugin's view. Without its plugin, a value shows
// and edits as the type it stores as.
import type { JsonValue, StoredType } from "@nether/core";
import type { PropertyViewProps } from "@nether/plugin-api";
import { useCallback, useSyncExternalStore } from "react";
import { KeyedRegistry } from "./keyed.ts";

/** A plugin's view, mounted for a value. */
export interface MountedPropertyHandle {
  update(props: PropertyViewProps): Promise<void>;
  unmount(): void;
}

/** What shows a property type's values, once its plugin runs. */
export interface PropertyTypeDrawing {
  /** Mounts the plugin's view in `element`; `onChange` is told the value it sets. */
  mount(
    element: HTMLElement,
    props: PropertyViewProps,
    onChange: (value: JsonValue) => void,
  ): Promise<MountedPropertyHandle>;
}

export interface PropertyTypeProcessor {
  /** As the vault writes it, `plugin-id/type`. */
  readonly type: `${string}/${string}`;
  /** The ID of the plugin that adds it. */
  readonly plugin: string;
  /** The app's type it stores as. */
  readonly stores: StoredType;
  /** Its name, in the app's language. */
  readonly name: () => string;
  /** Starts the plugin, if it has not started, and gives what shows its values. */
  readonly load: () => Promise<PropertyTypeDrawing>;
}

export class PropertyTypeRegistry extends KeyedRegistry<PropertyTypeProcessor> {
  /** Adds a property type; returns what takes it away again. */
  add(processor: PropertyTypeProcessor): () => void {
    return this.addAt(
      processor.type,
      processor,
      () => `A property type ${processor.type} is there already.`,
    );
  }

  get(type: string): PropertyTypeProcessor | undefined {
    return this.at(type);
  }
}

/** The property types plugins add, as they change. */
export function usePropertyTypes(types: PropertyTypeRegistry): readonly PropertyTypeProcessor[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => types.subscribe(listener), [types]),
    () => types.all(),
  );
}

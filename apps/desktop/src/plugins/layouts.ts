// The database layouts plugins add (ADR 0056): the built-in plugin's board,
// gallery, list, calendar and timeline, by their names, and other plugins'
// by `plugin-id/layout`. The table is the app's own, where every view
// falls back. A plugin's code loads when a view of its layout first shows.
import type { JsonValue, NoteId, PropertyDefinition, View } from "@nether/core";
import type { Group, Row } from "@nether/database";
import type { JsonObject, LayoutProps } from "@nether/plugin-api";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { KeyedRegistry } from "./keyed.ts";

/** What a built-in plugin's live view of a layout is given, which only the host gives (not the SDK). */
export interface LayoutHostProps {
  readonly view: View;
  readonly rows: readonly Row[];
  readonly groups?: readonly Group[];
  /** The properties the view shows, in order. */
  readonly visible: readonly PropertyDefinition[];
  readonly onOpen: (row: NoteId) => void;
  /** Moves a row from a group to another, as a board's card. */
  readonly onMove: (row: NoteId, from: JsonValue, to: JsonValue) => void;
  /** Makes a row in a group. */
  readonly onCreate: (value: JsonValue) => void;
  /** Makes a row on a calendar's day, where the view's date can be set. */
  readonly onCreateOn?: (day: string) => void;
  /** A row's cover image, as a gallery shows it. */
  readonly coverOf: (row: Row) => string | undefined;
}

/** A built-in plugin's live view of a layout. */
export type LayoutHost = (props: LayoutHostProps) => ReactNode;

/** What a plugin's view of a layout changes, through the app. */
export interface LayoutActions {
  readonly openRow: (row: string) => void;
  readonly setValue: (row: string, key: string, value: JsonValue) => void;
  readonly setOptions: (options: JsonObject) => void;
}

/** A plugin's view, mounted for a layout. */
export interface MountedLayoutHandle {
  update(props: LayoutProps): Promise<void>;
  unmount(): void;
}

/** What shows a layout, once its plugin runs: a built-in's live view, or a view mounted in an element. */
export interface LayoutDrawing {
  readonly view?: LayoutHost;
  readonly mount?: (
    element: HTMLElement,
    props: LayoutProps,
    actions: LayoutActions,
  ) => Promise<MountedLayoutHandle>;
}

export interface LayoutProcessor {
  /** As a database's schema names it: `board`, or `plugin-id/layout`. */
  readonly layout: string;
  /** The ID of the plugin that adds it. */
  readonly plugin: string;
  /** Its name, in the app's language. */
  readonly name: () => string;
  /** Starts the plugin, if it has not started, and gives what shows the layout. */
  readonly load: () => Promise<LayoutDrawing>;
}

export class LayoutRegistry extends KeyedRegistry<LayoutProcessor> {
  /** Adds a layout; returns what takes it away again. */
  add(processor: LayoutProcessor): () => void {
    return this.addAt(
      processor.layout,
      processor,
      (other) => `The plugin ${other.plugin} shows the ${processor.layout} layout already.`,
    );
  }

  get(layout: string): LayoutProcessor | undefined {
    return this.at(layout);
  }
}

/** The layouts plugins add, as they change. */
export function useLayouts(layouts: LayoutRegistry): readonly LayoutProcessor[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => layouts.subscribe(listener), [layouts]),
    () => layouts.all(),
  );
}

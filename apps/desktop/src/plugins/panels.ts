// The panels plugins add (ADR 0055), each `plugin-id:panel`: tabs in the
// sidebar after the app's own, and sections beside the note open. The app
// gives each its name and landmark, and the plugin's view fills it. A
// plugin's code loads when one of its panels first shows.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import type { PanelPlace, PanelProps } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from "react";
import type { NotePart } from "../noteLinks.ts";
import { KeyedRegistry } from "./keyed.ts";

/** What a built-in plugin's live view of a panel is given, which only the host gives (not the SDK). */
export interface PanelViewProps {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  /** Beside a note, the note open. */
  readonly note?: NoteId;
  /** Opens a note, or a part of one, as a link does. */
  readonly openNote: (id: NoteId, part?: NotePart) => void;
  /** Shows the notes with a tag, as a tag in a note does. */
  readonly openTag: (tag: string) => void;
  /** Asks for the name this device goes by, where the app can. */
  readonly askMyName?: () => void;
}

/** A built-in plugin's live view of a panel. */
export type PanelHostView = (props: PanelViewProps) => ReactNode;

/** A plugin's view, mounted in a panel. */
export interface MountedPanelView {
  update(props: PanelProps): Promise<void>;
  unmount(): void;
}

/** What fills a panel, once its plugin runs: a built-in's live view, or a view mounted in an element. */
export interface PanelDrawing {
  readonly view?: PanelHostView;
  readonly mount?: (element: HTMLElement, props: PanelProps) => Promise<MountedPanelView>;
}

export interface PanelProcessor {
  /** `plugin-id:panel`. */
  readonly id: string;
  /** The ID of the plugin that adds it. */
  readonly plugin: string;
  readonly place: PanelPlace;
  readonly folded: boolean;
  /** Its tab's name, or its heading, in the app's language. */
  readonly name: () => string;
  /** Starts the plugin, if it has not started, and gives what fills the panel. */
  readonly load: () => Promise<PanelDrawing>;
}

export class PanelRegistry extends KeyedRegistry<PanelProcessor> {
  /** Adds a panel; returns what takes it away again. */
  add(processor: PanelProcessor): () => void {
    return this.addAt(processor.id, processor, () => `A panel ${processor.id} is there already.`);
  }

  get(id: string): PanelProcessor | undefined {
    return this.at(id);
  }
}

/** The panels plugins add in a place, in the order they came, as they change. */
export function usePanels(panels: PanelRegistry, place: PanelPlace): readonly PanelProcessor[] {
  const all = useSyncExternalStore(
    useCallback((listener: () => void) => panels.subscribe(listener), [panels]),
    () => panels.all(),
  );
  return useMemo(() => all.filter((panel) => panel.place === place), [all, place]);
}

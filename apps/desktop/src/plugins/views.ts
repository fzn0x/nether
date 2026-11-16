// The views plugins add (ADR 0055), each `plugin-id:view`, which fill a
// pane: of the files with one of their extensions, opened in a tab as a
// note is, or of their own, opened by a command. A plugin's code loads
// when one of its views first shows.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import type { PaneViewProps } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import type { VaultMedia } from "../backend.ts";
import type { NotePart } from "../noteLinks.ts";
import { KeyedRegistry } from "./keyed.ts";

/** What a built-in plugin's live view of a pane is given, which only the host gives (not the SDK). */
export interface PaneViewHostProps {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  readonly media: VaultMedia;
  /** For a view of files, the file open, by its path. */
  readonly path?: string;
  /**
   * Where in the file a link asked to go: what followed its `#`, as
   * `page=3`, and a key new each time it is asked, even for the same place.
   */
  readonly at?: { readonly part: string; readonly key: number } | undefined;
  /** Resolves once the vault's links are in the graph, starting them loading if they have not. */
  readonly linksLoaded?: () => Promise<void>;
  /** The note open in the focused pane, if one is. */
  readonly note?: NoteId;
  /** Opens a note, or a part of one, here, in a new tab or in the pane to the right. */
  readonly openNote: (id: NoteId, part?: NotePart, where?: "here" | "tab" | "right") => void;
  /** Closes a view of its own, going back to the notes open. */
  readonly close: () => void;
}

/** A built-in plugin's live view of a pane. */
export type PaneViewHost = (props: PaneViewHostProps) => ReactNode;

/** A plugin's view, mounted in a pane. */
export interface MountedPaneViewHandle {
  update(props: PaneViewProps): Promise<void>;
  unmount(): void;
}

/** What fills a pane, once its plugin runs: a built-in's live view, or a view mounted in an element. */
export interface PaneViewDrawing {
  readonly view?: PaneViewHost;
  readonly mount?: (element: HTMLElement, props: PaneViewProps) => Promise<MountedPaneViewHandle>;
}

export interface ViewProcessor {
  /** `plugin-id:view`. */
  readonly id: string;
  /** The ID of the plugin that adds it. */
  readonly plugin: string;
  /** Lowercase, without the dot; none for a view of its own. */
  readonly extensions: readonly string[];
  /** Its name, in the app's language. */
  readonly name: () => string;
  /** Starts the plugin, if it has not started, and gives what fills the pane. */
  readonly load: () => Promise<PaneViewDrawing>;
}

/** A file's extension, lowercase, without the dot; empty for a name with none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export class ViewRegistry extends KeyedRegistry<ViewProcessor> {
  /** Adds a view; returns what takes it away again. */
  add(processor: ViewProcessor): () => void {
    return this.addAt(processor.id, processor, () => `A view ${processor.id} is there already.`);
  }

  get(id: string): ViewProcessor | undefined {
    return this.at(id);
  }

  /** The view that opens a file by its path, by its extension. */
  forFile(path: string): ViewProcessor | undefined {
    const extension = extensionOf(path);
    return extension === ""
      ? undefined
      : this.all().find((view) => view.extensions.includes(extension));
  }
}

/** The views plugins add, as they change. */
export function useViews(views: ViewRegistry): readonly ViewProcessor[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => views.subscribe(listener), [views]),
    () => views.all(),
  );
}

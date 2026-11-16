// The block types plugins add (ADR 0055), each `plugin-id/type`: the
// slash menu inserts one, and its plugin's view shows it in a note. A
// plugin's code loads when a block of a type it adds first shows.
import type { BlockEntry } from "@nether/editor";
import type { BlockViewProps, JsonObject } from "@nether/plugin-api";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { CodeBlockProcessor, CodeBlockRegistry, SlashOffer } from "./codeBlocks.ts";
import { KeyedRegistry } from "./keyed.ts";

/** A plugin's view, mounted in a block. */
export interface MountedBlock {
  update(props: BlockViewProps): Promise<void>;
  unmount(): void;
}

/** What shows a block type, once its plugin runs. */
export interface BlockDrawing {
  /** Mounts the plugin's view in `element`; `onChange` is told what the plugin changes the block to. */
  mount(
    element: HTMLElement,
    props: BlockViewProps,
    onChange: (attrs: JsonObject) => void,
  ): Promise<MountedBlock>;
}

export interface BlockProcessor {
  /** As a note's file names it, `plugin-id/type`. */
  readonly type: string;
  /** The ID of the plugin that adds it. */
  readonly plugin: string;
  /** Its slash menu entry. */
  readonly slash: SlashOffer;
  /** What a new block holds. */
  readonly attrs: JsonObject;
  /** Starts the plugin, if it has not started, and gives what shows the type. */
  readonly load: () => Promise<BlockDrawing>;
}

export class BlockRegistry extends KeyedRegistry<BlockProcessor> {
  /** Adds a block type; returns what takes it away again. */
  add(processor: BlockProcessor): () => void {
    return this.addAt(
      processor.type,
      processor,
      () => `A block type ${processor.type} is there already.`,
    );
  }

  get(type: string): BlockProcessor | undefined {
    return this.at(type);
  }
}

/** What plugins add to the slash menu: their code blocks first, then their blocks. */
export function slashEntries(
  codeBlocks: readonly CodeBlockProcessor[],
  blocks: readonly BlockProcessor[],
): BlockEntry[] {
  return [
    ...codeBlocks.flatMap(({ language, slash }) =>
      slash === undefined
        ? []
        : [
            {
              id: `code:${language}`,
              title: slash.name(),
              keywords: slash.keywords(),
              insert: { codeBlock: language, text: slash.text },
            },
          ],
    ),
    ...blocks.map(({ type, slash, attrs }) => ({
      id: `block:${type}`,
      title: slash.name(),
      keywords: slash.keywords(),
      insert: { pluginBlock: type, attrs },
    })),
  ];
}

/** What plugins add to the slash menu, as it changes. */
export function useSlashEntries(
  codeBlocks: CodeBlockRegistry,
  blocks: BlockRegistry,
): readonly BlockEntry[] {
  const languages = useSyncExternalStore(
    useCallback((listener: () => void) => codeBlocks.subscribe(listener), [codeBlocks]),
    () => codeBlocks.all(),
  );
  const types = useSyncExternalStore(
    useCallback((listener: () => void) => blocks.subscribe(listener), [blocks]),
    () => blocks.all(),
  );
  return useMemo(() => slashEntries(languages, types), [languages, types]);
}

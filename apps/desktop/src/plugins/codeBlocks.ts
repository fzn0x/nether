// The code block languages plugins draw, each by one plugin (ADR 0055).
// A note open in the app shows what a plugin draws below the block's code,
// and an HTML page in the code's place. A plugin's code loads when a block
// in a language its manifest declares is first drawn.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import type { CodeBlockContext, CodeBlockOutput } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import type { ReactNode } from "react";
import type { VaultMedia } from "../backend.ts";

/** What a built-in plugin's live view of a code block is given, below its code in a note. */
export interface CodeBlockViewProps {
  readonly source: string;
  readonly vault: Vault;
  readonly media: VaultMedia;
  readonly graph: LinkGraph;
  /** Opens a note, as a link in the block's note does. */
  readonly openNote: (id: NoteId) => void;
}

/** A built-in plugin's live view of a code block, which only the host gives (not the SDK). */
export type CodeBlockView = (props: CodeBlockViewProps) => ReactNode;

/** What draws a language, once its plugin runs: HTML, a live view in the editor, or both. */
export interface CodeBlockDrawing {
  readonly render?: (source: string, context: CodeBlockContext) => Promise<CodeBlockOutput>;
  /** In the editor, in place of `render`. */
  readonly view?: CodeBlockView;
}

export interface CodeBlockProcessor {
  /** Lowercase, as the manifest declares it. */
  readonly language: string;
  /** The ID of the plugin that draws it. */
  readonly plugin: string;
  /** Starts the plugin, if it has not started, and gives what draws the language. */
  readonly load: () => Promise<CodeBlockDrawing>;
}

export class CodeBlockRegistry {
  readonly #processors = new Map<string, CodeBlockProcessor>();
  readonly #listeners = new Set<() => void>();

  /** Adds what draws a language; returns what takes it away again. */
  add(processor: CodeBlockProcessor): () => void {
    const taken = this.#processors.get(processor.language);
    if (taken !== undefined) {
      throw new Error(
        `The plugin ${taken.plugin} draws ${processor.language} code blocks already.`,
      );
    }
    this.#processors.set(processor.language, processor);
    this.#changed();
    return () => {
      if (this.#processors.get(processor.language) !== processor) return;
      this.#processors.delete(processor.language);
      this.#changed();
    };
  }

  /** What draws a fence's language, whatever its case. */
  get(language: string): CodeBlockProcessor | undefined {
    return this.#processors.get(language.toLowerCase());
  }

  /**
   * A code block as HTML in its place on a light page, as an export shows
   * it; nothing, which leaves its code, when no plugin draws its language
   * as HTML or the plugin cannot draw it.
   */
  async html(language: string, info: string, source: string): Promise<string | undefined> {
    const processor = this.get(language);
    if (processor === undefined) return undefined;
    try {
      const { render } = await processor.load();
      const output = await render?.(source, {
        language: processor.language,
        info,
        theme: "light",
        target: "html",
      });
      return output !== undefined && output !== null && "html" in output ? output.html : undefined;
    } catch {
      return undefined;
    }
  }

  /** Calls `listener` when a language is added or taken away; returns what stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

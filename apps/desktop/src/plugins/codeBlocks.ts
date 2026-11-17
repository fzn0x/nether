// The code block languages plugins draw, each by one plugin (ADR 0055).
// A note open in the app shows what a plugin draws below the block's code,
// and an HTML page in the code's place. A plugin's code loads when a block
// in a language its manifest declares is first drawn.
import type { LinkTarget, NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import type { CodeBlockContext, CodeBlockOutput } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import type { ReactNode } from "react";
import type { VaultMedia } from "../backend.ts";
import { KeyedRegistry } from "./keyed.ts";

/** A note a button makes (ADR 0072). */
export interface NoteRequest {
  /** Its folder, from the vault's; "" for the vault's own. */
  readonly folder: string;
  /** Its name, without `.md`; none for the app's name for a new note. */
  readonly name?: string | undefined;
  /** The template it is made from, as the template settings name one. */
  readonly template?: string | undefined;
  /** Whether it opens once made. */
  readonly open: boolean;
  /** Whether a note there already opens, in place of a new one beside it. */
  readonly openIfExists: boolean;
}

/** How a command a button names ran: it did, the app has none, or it cannot run now. */
export type CommandRun = "ran" | "missing" | "unavailable";

/** A command a button asks about before it runs it (ADR 0072). */
export interface CommandTitle {
  /** Its name as the palette shows it now. */
  readonly title: string;
  /** Whether a plugin from the vault adds it, so a button asks each time it runs it. */
  readonly fromVault: boolean;
}

/** What a live view may do from the note its block is in, as a button does (ADR 0072). */
export interface CodeBlockNote {
  /** The note the block is in. */
  readonly id: NoteId;
  /** Runs a command of the registry by its ID, as the palette runs it. */
  readonly runCommand: (command: string) => CommandRun;
  /** A command of the registry by its ID, as a button asks about it; none when there is none. */
  readonly describeCommand: (command: string) => CommandTitle | undefined;
  /** Makes a note, or opens the one there; rejects with why it could not. */
  readonly createNote: (request: NoteRequest) => Promise<void>;
  /** Opens what a link names, as a link in the note does: a note, a part of one, or a file. */
  readonly openLink: (target: LinkTarget) => void;
}

/** What a built-in plugin's live view of a code block is given, below its code in a note. */
export interface CodeBlockViewProps {
  readonly source: string;
  readonly vault: Vault;
  readonly media: VaultMedia;
  readonly graph: LinkGraph;
  /** Opens a note, as a link in the block's note does. */
  readonly openNote: (id: NoteId) => void;
  /** What the view may do from the block's note; none where it is not in one. */
  readonly note?: CodeBlockNote | undefined;
}

/** A built-in plugin's live view of a code block, which only the host gives (not the SDK). */
export type CodeBlockView = (props: CodeBlockViewProps) => ReactNode;

/** What draws a language, once its plugin runs: HTML, a live view in the editor, or both. */
export interface CodeBlockDrawing {
  readonly render?: (source: string, context: CodeBlockContext) => Promise<CodeBlockOutput>;
  /** In the editor, in place of `render`. */
  readonly view?: CodeBlockView;
}

/** How the slash menu offers something a plugin adds, in the app's language. */
export interface SlashOffer {
  readonly name: () => string;
  readonly keywords: () => string;
}

export interface CodeBlockProcessor {
  /** Lowercase, as the manifest declares it. */
  readonly language: string;
  /** The ID of the plugin that draws it. */
  readonly plugin: string;
  /** Its slash menu entry, inserting a block in the language with `text`, if it has one. */
  readonly slash?: SlashOffer & { readonly text: string };
  /** Starts the plugin, if it has not started, and gives what draws the language. */
  readonly load: () => Promise<CodeBlockDrawing>;
}

export class CodeBlockRegistry extends KeyedRegistry<CodeBlockProcessor> {
  /** Adds what draws a language; returns what takes it away again. */
  add(processor: CodeBlockProcessor): () => void {
    return this.addAt(
      processor.language,
      processor,
      (taken) => `The plugin ${taken.plugin} draws ${processor.language} code blocks already.`,
    );
  }

  /** What draws a fence's language, whatever its case. */
  get(language: string): CodeBlockProcessor | undefined {
    return this.at(language.toLowerCase());
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
}

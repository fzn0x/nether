// A note's Yjs state as the Markdown file Nether writes for it (ADR 0059):
// read through the editor's own schema and written by @nether/markdown, as
// the desktop app writes a note that came from the server, so the API gives
// the same text a vault on disk has. The editor's code is large, so the
// server loads this module when the API first reads a note.
import { type JsonValue, newBlockId } from "@nether/core";
import { documentBlocks, documentProperties } from "@nether/editor/document";
import { serializeMarkdown } from "@nether/markdown";
import * as Y from "yjs";

/** A note as the API gives it: its Markdown, and its properties in their order. */
export interface ReadNote {
  readonly markdown: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

/** A note's state as Markdown, its properties as YAML frontmatter. */
export function readNote(state: Uint8Array | undefined): ReadNote {
  const document = new Y.Doc();
  try {
    if (state !== undefined) Y.applyUpdate(document, state);
    const properties = documentProperties(document);
    const markdown = serializeMarkdown({
      properties,
      content: documentBlocks(document, newBlockId),
    }).text;
    return {
      markdown,
      properties: Object.fromEntries(properties.map((entry) => [entry.key, entry.value])),
    };
  } finally {
    document.destroy();
  }
}

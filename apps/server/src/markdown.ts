// A note's Yjs state as the Markdown file Nether writes for it (ADR 0059):
// read through the editor's own schema and written by @nether/markdown, as
// the desktop app writes a note that came from the server, so the API gives
// the same text a vault on disk has. Markdown written through the API goes
// into a note's document the way the desktop app takes a file edited in
// another app: its blocks aligned with the document's, so unchanged blocks
// keep their IDs, and the document changes by the fewest edits. The
// editor's code is large, so the server loads this module when the API
// first reads or writes a note.
import { createHash } from "node:crypto";
import { type JsonValue, type PropertyEntry, newBlockId } from "@nether/core";
import {
  documentBlocks,
  documentProperties,
  setDocumentBlocks,
  setDocumentProperties,
} from "@nether/editor/document";
import {
  type ParsedMarkdown,
  alignBlocks,
  parseMarkdown,
  serializeMarkdown,
} from "@nether/markdown";
import * as Y from "yjs";

/** A note as the API gives it: its Markdown, and its properties in their order. */
export interface ReadNote {
  readonly markdown: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  /** The note's entity tag: its Markdown's hash, as `If-Match` sends it back. */
  readonly tag: string;
}

/** The entity tag of a note's Markdown: a quoted part of its SHA-256. */
export function noteTag(markdown: string): string {
  return `"${createHash("sha256").update(markdown).digest("base64url").slice(0, 27)}"`;
}

/** A note's document as Markdown, its properties as YAML frontmatter. */
export function documentNote(document: Y.Doc): ReadNote {
  const properties = documentProperties(document);
  const markdown = serializeMarkdown({
    properties,
    content: documentBlocks(document, newBlockId),
  }).text;
  return {
    markdown,
    properties: Object.fromEntries(properties.map((entry) => [entry.key, entry.value])),
    tag: noteTag(markdown),
  };
}

/** A note's state as Markdown, its properties as YAML frontmatter. */
export function readNote(state: Uint8Array | undefined): ReadNote {
  const document = new Y.Doc();
  try {
    if (state !== undefined) Y.applyUpdate(document, state);
    return documentNote(document);
  } finally {
    document.destroy();
  }
}

/**
 * Markdown sent to be a note, with `properties` set over its frontmatter's:
 * the note, or why it cannot be one, as a frontmatter that does not read.
 */
export function parseNote(
  markdown: string,
  properties: Readonly<Record<string, JsonValue>> = {},
): ParsedMarkdown | { readonly error: string } {
  const parsed = parseMarkdown(markdown);
  if (parsed.frontmatterError !== undefined) {
    return { error: `Its frontmatter does not read as YAML: ${parsed.frontmatterError}` };
  }
  const given = Object.entries(properties);
  if (given.length === 0) return parsed;
  const set = new Map(given);
  const entries: PropertyEntry[] = parsed.properties.map((entry) =>
    set.has(entry.key) ? { key: entry.key, value: set.get(entry.key) ?? null } : entry,
  );
  for (const [key, value] of given) {
    if (!parsed.properties.some((entry) => entry.key === key)) entries.push({ key, value });
  }
  return { ...parsed, properties: entries };
}

/**
 * Makes a note's document hold `note`: for a new note, its blocks as they
 * are; for one with content, aligned with the blocks it has, so those that
 * stay keep their IDs, and with them their links and comments.
 */
export function writeNote(document: Y.Doc, note: ParsedMarkdown): void {
  const ours = documentBlocks(document, newBlockId);
  const content = ours.length === 0 ? note.content : alignBlocks(note, ours).content;
  setDocumentBlocks(document, content);
  setDocumentProperties(document, note.properties);
}

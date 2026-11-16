// A PDF's highlights in the vault (ADR 0061): the callouts that link to a
// passage of it, in whatever notes hold them, found through the link
// index; and adding, commenting on and removing one, each a write of its
// note, read again and written again when another app changed it meanwhile.
import { type BlockId, type ContentBlock, type NoteId, newBlockId, walkBlocks } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import { parseMarkdown } from "@nether/markdown";
import {
  type Highlight,
  type PdfPassage,
  addHighlight,
  commentBlocks,
  highlightCallout,
  highlightsNote,
  namesPassage,
  readHighlight,
  readHighlights,
  rewrite,
  withComment,
  withoutHighlight,
  writePdfPlace,
} from "@nether/pdf";
import { ChangedOnDisk, type Vault } from "@nether/storage";

/** A highlight, and the note that holds it. */
export interface NoteHighlight {
  readonly note: NoteId;
  readonly highlight: Highlight;
}

/** The notes whose links name a passage of the PDF at `path`, as the link index has them. */
export function notesWithPassages(vault: Vault, graph: LinkGraph, path: string): NoteId[] {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const found: NoteId[] = [];
  for (const note of graph.notes()) {
    const names = note.index.links.some(
      (link) =>
        namesPassage(link.heading) &&
        link.target.toLowerCase().endsWith(name) &&
        vault.resolveFile(link.target, note.path) === path,
    );
    if (names) found.push(note.id);
  }
  return found;
}

/** The highlights of the PDF at `path` that some notes hold, the notes in path order. */
export async function readPdfHighlights(
  vault: Vault,
  notes: Iterable<NoteId>,
  path: string,
): Promise<NoteHighlight[]> {
  const entries = [...new Set(notes)]
    .flatMap((id) => {
      const entry = vault.note(id);
      return entry === undefined ? [] : [entry];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const found: NoteHighlight[] = [];
  for (const entry of entries) {
    const file = await vault.read(entry.id);
    if (file.missing === true || file.binary === true) continue;
    for (const highlight of readHighlights(parseMarkdown(file.text).content)) {
      if (vault.resolveFile(highlight.target, entry.path) === path) {
        found.push({ note: entry.id, highlight });
      }
    }
  }
  return found;
}

/** The note new highlights go in: the one that holds most of them, the first when as many. */
export function highlightsHome(highlights: readonly NoteHighlight[]): NoteId | undefined {
  const counts = new Map<NoteId, number>();
  for (const { note } of highlights) counts.set(note, (counts.get(note) ?? 0) + 1);
  let best: NoteId | undefined;
  for (const [note, count] of counts) {
    if (best === undefined || count > (counts.get(best) ?? 0)) best = note;
  }
  return best;
}

/** The path of a new note for a PDF's highlights: beside it, by the name given, the first free. */
export function highlightsNotePath(vault: Vault, path: string, name: string): string {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = `${folder}${name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim()}`;
  let candidate = `${base}.md`;
  for (let n = 2; vault.fileInfo(candidate) !== undefined; n++) {
    candidate = `${base} ${String(n)}.md`;
  }
  return candidate;
}

/** What a new highlight says: where, its words, and the link's name. */
export interface HighlightInput {
  readonly passage: PdfPassage;
  readonly words: string;
  /** The link's name, as Obsidian writes it: "paper, page 3". */
  readonly name: string;
}

/**
 * Changes a note's blocks; reads and writes it again when another app
 * changed it meanwhile. False when `change` finds nothing to change.
 */
async function changeNote(
  vault: Vault,
  note: NoteId,
  change: (content: readonly ContentBlock[]) => ContentBlock[] | undefined,
): Promise<boolean> {
  for (;;) {
    const file = await vault.read(note);
    if (file.missing === true || file.binary === true) return false;
    const parsed = parseMarkdown(file.text);
    const content = change(parsed.content);
    if (content === undefined) return false;
    try {
      await vault.write(note, rewrite(parsed, content), file.hash);
      return true;
    } catch (error) {
      if (!(error instanceof ChangedOnDisk)) throw error;
    }
  }
}

/**
 * Adds a highlight of the PDF at `path` at the end of the note `home`, or
 * of a new note beside the PDF, `newNote` its name; gives the note and the
 * highlight's ID.
 */
export async function addPdfHighlight(
  vault: Vault,
  path: string,
  home: NoteId | undefined,
  newNote: string,
  input: HighlightInput,
): Promise<{ readonly note: NoteId; readonly id: BlockId }> {
  const callout = (from: string, taken: ReadonlySet<string>) =>
    highlightCallout({
      id: newBlockId(taken),
      target: vault.linkTo(path, from),
      passage: input.passage,
      name: input.name,
      words: input.words,
    });
  const entry = home === undefined ? undefined : vault.note(home);
  if (entry === undefined) {
    const notePath = highlightsNotePath(vault, path, newNote);
    const made = callout(notePath, new Set());
    const created = await vault.create(notePath, highlightsNote(made));
    return { note: created.id, id: made.id };
  }
  for (;;) {
    const file = await vault.read(entry.id);
    if (file.missing === true || file.binary === true) {
      throw new Error(`${entry.title} cannot hold highlights now.`);
    }
    const parsed = parseMarkdown(file.text);
    const taken = new Set<string>([...walkBlocks(parsed.content)].map((block) => block.id));
    const made = callout(entry.path, taken);
    try {
      await vault.write(entry.id, addHighlight(parsed, made), file.hash);
      return { note: entry.id, id: made.id };
    } catch (error) {
      if (!(error instanceof ChangedOnDisk)) throw error;
    }
  }
}

/** Writes a highlight's comment, from Markdown; false when its note no longer has it. */
export function setHighlightComment(
  vault: Vault,
  note: NoteId,
  id: BlockId,
  markdown: string,
): Promise<boolean> {
  return changeNote(vault, note, (content) => withComment(content, id, commentBlocks(markdown)));
}

/** Takes a highlight out of its note; false when the note no longer has it. */
export function removePdfHighlight(vault: Vault, note: NoteId, id: BlockId): Promise<boolean> {
  return changeNote(vault, note, (content) => withoutHighlight(content, id));
}

/** A link to a highlight, `[[Note#^id]]`, the note by its title where that finds it, else its path. */
export function highlightLink(vault: Vault, graph: LinkGraph, note: NoteId, id: BlockId): string {
  const path = vault.note(note)?.path ?? "";
  const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const name = graph.resolve(title, "") === note ? title : path.replace(/\.md$/i, "");
  return `[[${name}#^${id}]]`;
}

/**
 * The PDF a block of a note highlights, and where, as the part of a link
 * after its `#`; undefined when the block is not a highlight of a file
 * of the vault.
 */
export async function highlightedPassage(
  vault: Vault,
  note: NoteId,
  block: BlockId,
): Promise<{ readonly path: string; readonly part: string } | undefined> {
  const entry = vault.note(note);
  if (entry === undefined) return undefined;
  const file = await vault.read(note);
  if (file.missing === true || file.binary === true) return undefined;
  for (const each of walkBlocks(parseMarkdown(file.text).content)) {
    if (each.id !== block || each.type !== "callout") continue;
    const highlight = readHighlight(each);
    const path =
      highlight === undefined ? undefined : vault.resolveFile(highlight.target, entry.path);
    return highlight === undefined || path === undefined
      ? undefined
      : { path, part: writePdfPlace(highlight.passage) };
  }
  return undefined;
}

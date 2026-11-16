// Highlights as Markdown (ADR 0061): a callout of Obsidian's `quote` kind
// whose title is a link to the passage, as Copy link to selection writes
// it; its first paragraph the words highlighted, and what follows the
// comment. Read from a note's blocks, made, commented and removed there.
//
//   > [!quote] [[paper.pdf#page=3&selection=4,0,5,20|paper, page 3]]
//   > The words highlighted.
//   >
//   > A comment.
//
//   ^k3x9q2ab
import {
  type BlockId,
  type Callout,
  type ContentBlock,
  type Inline,
  newBlockId,
  replaceBlock,
  walkBlocks,
} from "@nether/core";
import { type ParsedMarkdown, parseMarkdown, serializeMarkdown } from "@nether/markdown";
import { type PdfPassage, readPdfPlace, writePdfPlace } from "./link.ts";
import { normalizeWords } from "./text.ts";

/** The callout kind a highlight is, one of Obsidian's own. */
export const highlightKind = "quote";

/** A highlight, as a note holds it. */
export interface Highlight {
  /** The callout's block ID, which links to it name. */
  readonly id: BlockId;
  /** The PDF its link names, as written: `paper.pdf`, `Papers/paper.pdf`. */
  readonly target: string;
  readonly passage: PdfPassage;
  /** The words highlighted. */
  readonly words: string;
  /** The comment's blocks, none for no comment. */
  readonly comment: readonly ContentBlock[];
}

export function inlineWords(content: readonly Inline[]): string {
  return normalizeWords(
    content
      .map((inline) => {
        switch (inline.type) {
          case "text":
            return inline.text;
          case "hardBreak":
            return " ";
          case "wikiLink":
            return inline.alias ?? ("title" in inline.target ? inline.target.title : "");
          case "tag":
            return `#${inline.name}`;
          case "math":
            return inline.latex;
          case "raw":
            return inline.markdown;
        }
      })
      .join(""),
  );
}

/** The link a callout's title is, alone but for white space. */
function titleLink(title: readonly Inline[]): Extract<Inline, { type: "wikiLink" }> | undefined {
  const rest = title.filter((inline) => !(inline.type === "text" && inline.text.trim() === ""));
  const [only] = rest;
  return rest.length === 1 && only?.type === "wikiLink" ? only : undefined;
}

/** The highlight a block is, if it is one. */
export function readHighlight(block: ContentBlock): Highlight | undefined {
  if (block.type !== "callout" || block.attrs.kind !== highlightKind) return undefined;
  const link = titleLink(block.content);
  if (link === undefined || !("title" in link.target) || link.target.heading === undefined) {
    return undefined;
  }
  const place = readPdfPlace(link.target.heading);
  if (place?.selection === undefined) return undefined;
  const [first, ...rest] = block.children ?? [];
  const quoted = first?.type === "paragraph";
  return {
    id: block.id,
    target: link.target.title,
    passage: {
      page: place.page,
      selection: place.selection,
      ...(place.color === undefined ? {} : { color: place.color }),
    },
    words: quoted ? inlineWords(first.content) : "",
    comment: quoted ? rest : (block.children ?? []),
  };
}

/** The highlights among a note's blocks, at any depth, in order. */
export function readHighlights(content: readonly ContentBlock[]): Highlight[] {
  const found: Highlight[] = [];
  for (const block of walkBlocks(content)) {
    if (block.type !== "callout") continue;
    const highlight = readHighlight(block);
    if (highlight !== undefined) found.push(highlight);
  }
  return found;
}

/** What a highlight is made of. */
export interface NewHighlight {
  readonly id: BlockId;
  /** The link to the PDF from the note the highlight goes in: `paper.pdf`. */
  readonly target: string;
  readonly passage: PdfPassage;
  /** The link's name, as Obsidian writes it: "paper, page 3". */
  readonly name: string;
  readonly words: string;
  readonly comment?: readonly ContentBlock[];
}

/** A highlight's callout. */
export function highlightCallout(highlight: NewHighlight): Callout {
  const words = normalizeWords(highlight.words);
  const taken = new Set<string>([highlight.id]);
  const quote: ContentBlock = {
    id: newBlockId(taken),
    type: "paragraph",
    content: words === "" ? [] : [{ type: "text", text: words }],
  };
  return {
    id: highlight.id,
    type: "callout",
    attrs: { kind: highlightKind },
    content: [
      {
        type: "wikiLink",
        target: { title: highlight.target, heading: writePdfPlace(highlight.passage) },
        alias: highlight.name,
      },
    ],
    children: [quote, ...(highlight.comment ?? [])],
  };
}

/** A comment's blocks, from the Markdown it was written as. */
export function commentBlocks(markdown: string): ContentBlock[] {
  return markdown.trim() === "" ? [] : [...parseMarkdown(markdown.trim()).content];
}

/** A comment's Markdown, as its blocks write it. */
export function commentMarkdown(comment: readonly ContentBlock[]): string {
  if (comment.length === 0) return "";
  return serializeMarkdown({ properties: [], content: comment }).text.trim();
}

/**
 * A note's blocks with a highlight's comment changed; undefined when the
 * note has no such highlight, or one without its words, whose comment
 * would read as its words.
 */
export function withComment(
  content: readonly ContentBlock[],
  id: BlockId,
  comment: readonly ContentBlock[],
): ContentBlock[] | undefined {
  const block = [...walkBlocks(content)].find(
    (each): each is Callout => each.id === id && each.type === "callout",
  );
  if (block === undefined || readHighlight(block) === undefined) return undefined;
  const [quote] = block.children ?? [];
  if (quote?.type !== "paragraph") return undefined;
  return replaceBlock(content, id, { ...block, children: [quote, ...comment] });
}

/**
 * A note's blocks with a highlight's color changed, PDF++'s `&color=` in
 * its link; none for the default. Undefined when the note has no such highlight.
 */
export function withColor(
  content: readonly ContentBlock[],
  id: BlockId,
  color: string | undefined,
): ContentBlock[] | undefined {
  const block = [...walkBlocks(content)].find(
    (each): each is Callout => each.id === id && each.type === "callout",
  );
  const highlight = block === undefined ? undefined : readHighlight(block);
  if (block === undefined || highlight === undefined) return undefined;
  const { page, selection } = highlight.passage;
  const heading = writePdfPlace({ page, selection, ...(color === undefined ? {} : { color }) });
  const title = block.content.map((inline) =>
    inline.type === "wikiLink" && "title" in inline.target
      ? { ...inline, target: { ...inline.target, heading } }
      : inline,
  );
  return replaceBlock(content, id, { ...block, content: title });
}

function without(blocks: readonly ContentBlock[], id: BlockId): ContentBlock[] | undefined {
  for (const [index, block] of blocks.entries()) {
    if (block.id === id) return blocks.toSpliced(index, 1);
    if ("children" in block && block.type !== "table" && block.type !== "columns") {
      const children = without(block.children ?? [], id);
      if (children !== undefined) {
        return blocks.with(index, { ...block, children });
      }
    }
  }
  return undefined;
}

/** A note's blocks without a highlight; undefined when the note has no such highlight. */
export function withoutHighlight(
  content: readonly ContentBlock[],
  id: BlockId,
): ContentBlock[] | undefined {
  const block = [...walkBlocks(content)].find((each) => each.id === id);
  if (block?.type !== "callout" || readHighlight(block) === undefined) return undefined;
  return without(content, id);
}

/** A note's text with a highlight added at its end, its ID written. */
export function addHighlight(parsed: ParsedMarkdown, highlight: Callout): string {
  return serializeMarkdown(
    { ...parsed, content: [...parsed.content, highlight] },
    { source: parsed.source, writeIds: new Set([...parsed.writtenIds, highlight.id]) },
  ).text;
}

/** A new note's text: a PDF's first highlight. */
export function highlightsNote(highlight: Callout): string {
  return serializeMarkdown(
    { properties: [], content: [highlight] },
    { writeIds: new Set([highlight.id]) },
  ).text;
}

/** A note's text with its blocks changed, the IDs it wrote kept. */
export function rewrite(parsed: ParsedMarkdown, content: readonly ContentBlock[]): string {
  return serializeMarkdown(
    { ...parsed, content },
    { source: parsed.source, writeIds: parsed.writtenIds },
  ).text;
}

// Links to a passage in a note's prose (ADR 0062): any wiki link that names
// a selection of a PDF, in any block but a highlight's own callout title,
// as Obsidian's Copy as quote and PDF++'s templates write them. They show
// on the PDF as the notes' own text, found by their selection alone.
import {
  type Block,
  type BlockId,
  type ContentBlock,
  type Inline,
  inlineContent,
} from "@nether/core";
import { inlineWords, readHighlight } from "./highlights.ts";
import { type PdfMarked, markedOf, readPdfPlace } from "./link.ts";
import { normalizeWords } from "./text.ts";

/** A link to a passage, in a block of a note. */
export interface PassageLink {
  /** The block the link is in. */
  readonly block: BlockId;
  /** The PDF it names, as written: `paper.pdf`, `Papers/paper.pdf`. */
  readonly target: string;
  /** Its passage of words, or its box (ADR 0067). */
  readonly passage: PdfMarked;
  /**
   * What its block says without it and without a callout's `[!PDF|yellow]`;
   * where that leaves nothing, what the next block says, as PDF++'s Quote
   * in callout writes the words in a quote after the link.
   */
  readonly words: string;
}

/** Every inline a block holds, its own and those of the blocks inside it. */
function allInlines(block: Block): Inline[] {
  const own = [...inlineContent(block)];
  if (!("children" in block)) return own;
  return [...own, { type: "hardBreak" }, ...block.children.flatMap((child) => allInlines(child))];
}

/** What a block says around one of its links: the link and a callout's marker left out. */
function wordsAround(content: readonly Inline[], link: Inline): string {
  const text = inlineWords(content.filter((inline) => inline !== link));
  return normalizeWords(
    text
      .replace(/^\[![^\]]*\][+-]?/, "")
      // PDF++'s Quote puts the link in brackets of its own.
      .replace(/\(\s*\)/g, ""),
  );
}

/** The links to a passage among a note's blocks, at any depth, in order. */
export function readPassageLinks(content: readonly ContentBlock[]): PassageLink[] {
  const found: PassageLink[] = [];
  const visit = (blocks: readonly Block[]) => {
    for (const [index, block] of blocks.entries()) {
      // A highlight's title is the highlight; what its body links to still counts.
      const own =
        block.type === "callout" && readHighlight(block) !== undefined ? [] : inlineContent(block);
      for (const inline of own) {
        if (inline.type !== "wikiLink" || !("title" in inline.target)) continue;
        const passage =
          inline.target.heading === undefined
            ? undefined
            : markedOf(readPdfPlace(inline.target.heading));
        if (passage === undefined) continue;
        const next = blocks[index + 1];
        const words = wordsAround(own, inline);
        found.push({
          block: block.id,
          target: inline.target.title,
          passage,
          words: words !== "" || next === undefined ? words : inlineWords(allInlines(next)),
        });
      }
      // An embed of a passage or a box, as PDF++ embeds a box (ADR 0067).
      if (block.type === "embed" && "title" in block.attrs.target) {
        const { title, heading } = block.attrs.target;
        const passage = heading === undefined ? undefined : markedOf(readPdfPlace(heading));
        const next = blocks[index + 1];
        if (passage !== undefined) {
          found.push({
            block: block.id,
            target: title,
            passage,
            words: next === undefined ? "" : inlineWords(allInlines(next)),
          });
        }
      }
      if ("children" in block) visit(block.children);
    }
  };
  visit(content);
  return found;
}

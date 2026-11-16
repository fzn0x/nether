// A page's words, as pdf.js gives them, item by item (ADR 0061): the words
// of a passage, the places some words are on a page, and where a
// highlight's passage is now, by its selection and by its words.
import type { PdfPassage, PdfSelection } from "./link.ts";

/** A text item of a page, as pdf.js gives it: its text, and whether a line ends after it. */
export interface TextItem {
  readonly str: string;
  readonly hasEOL?: boolean;
}

/** A page's words, each run of white space one space, with where each character came from. */
export interface PageText {
  readonly text: string;
  /** For each character of `text`, its item and its offset in it. */
  readonly at: readonly (readonly [number, number])[];
}

const space = /\s/;

/** Words with each run of white space made one space, and none at either end. */
export function normalizeWords(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A page's words, items one after another and a line's end as white space. */
export function pageText(items: readonly TextItem[]): PageText {
  let text = "";
  const at: (readonly [number, number])[] = [];
  const gap = (index: number, offset: number) => {
    if (text === "" || text.endsWith(" ")) return;
    text += " ";
    at.push([index, offset]);
  };
  for (const [index, item] of items.entries()) {
    for (let offset = 0; offset < item.str.length; offset++) {
      const char = item.str.charAt(offset);
      if (space.test(char)) {
        gap(index, offset);
      } else {
        text += char;
        at.push([index, offset]);
      }
    }
    if (item.hasEOL === true) gap(index, item.str.length);
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    at.pop();
  }
  return { text, at };
}

/** Whether a selection names characters of the page's items. */
export function fitsPage(items: readonly TextItem[], selection: PdfSelection): boolean {
  const { beginIndex, beginOffset, endIndex, endOffset } = selection;
  const first = items[beginIndex];
  const last = items[endIndex];
  return (
    first !== undefined &&
    last !== undefined &&
    beginIndex <= endIndex &&
    beginOffset <= first.str.length &&
    endOffset <= last.str.length &&
    (beginIndex < endIndex || beginOffset < endOffset)
  );
}

/** The words of a passage on a page; undefined when its selection is not on the page. */
export function passageWords(
  items: readonly TextItem[],
  selection: PdfSelection,
): string | undefined {
  if (!fitsPage(items, selection)) return undefined;
  const { beginIndex, beginOffset, endIndex, endOffset } = selection;
  let text = "";
  for (let index = beginIndex; index <= endIndex; index++) {
    const item = items[index];
    if (item === undefined) break;
    const from = index === beginIndex ? beginOffset : 0;
    const to = index === endIndex ? endOffset : item.str.length;
    text += item.str.slice(from, to);
    if (index < endIndex && item.hasEOL === true) text += " ";
  }
  return normalizeWords(text);
}

/** Lower case, a character at a time, so that every character keeps its place. */
function folded(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    const lower = char.toLowerCase();
    out += lower.length === 1 ? lower : char;
  }
  return out;
}

/**
 * Every place some words are on a page, in reading order, white space
 * aside, and case aside unless `matchCase`.
 */
export function findOnPage(
  items: readonly TextItem[],
  words: string,
  options: { readonly matchCase?: boolean } = {},
): PdfSelection[] {
  const wanted = normalizeWords(words);
  if (wanted === "") return [];
  const page = pageText(items);
  const haystack = options.matchCase === true ? page.text : folded(page.text);
  const needle = options.matchCase === true ? wanted : folded(wanted);
  const found: PdfSelection[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    const begin = page.at[at];
    const end = page.at[at + needle.length - 1];
    if (begin === undefined || end === undefined) continue;
    found.push({
      beginIndex: begin[0],
      beginOffset: begin[1],
      endIndex: end[0],
      endOffset: end[1] + 1,
    });
  }
  return found;
}

/** The page numbers from one page outwards, nearest first, before after when as near. */
export function pagesOutwards(page: number, pageCount: number): number[] {
  const order: number[] = [];
  for (let distance = 0; order.length < pageCount && distance < pageCount; distance++) {
    for (const each of distance === 0 ? [page] : [page - distance, page + distance]) {
      if (each >= 1 && each <= pageCount) order.push(each);
    }
  }
  return order;
}

/**
 * Where a highlight's passage is now (ADR 0061): at its selection when its
 * words are there; else where its words are, on its page, then on the
 * others, nearest first; else at its selection, when that is on its page.
 * Undefined when neither is in the PDF.
 */
export async function locatePassage(
  passage: PdfPassage,
  words: string,
  pageCount: number,
  itemsOf: (page: number) => Promise<readonly TextItem[]>,
): Promise<PdfPassage | undefined> {
  const wanted = normalizeWords(words);
  const own = passage.page <= pageCount ? await itemsOf(passage.page) : [];
  const there = passageWords(own, passage.selection);
  if (there !== undefined && (wanted === "" || there === wanted)) return passage;
  if (wanted !== "") {
    for (const page of pagesOutwards(Math.min(passage.page, pageCount), pageCount)) {
      const items = page === passage.page ? own : await itemsOf(page);
      const [first] = findOnPage(items, wanted, { matchCase: true });
      if (first !== undefined) return { page, selection: first };
    }
  }
  return there === undefined ? undefined : passage;
}

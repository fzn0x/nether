// A place in a PDF, as Obsidian links to it (ADR 0061): a page,
// `paper.pdf#page=3`, or a passage on it, as Copy link to selection
// writes it, `paper.pdf#page=3&selection=4,0,5,20`, or a box of it, as
// PDF++ writes one, `&rect=72,400,300,600` (ADR 0067), with PDF++'s color
// after it, `&color=red` (ADR 0062). An embed's size, Obsidian's `height`
// and PDF++'s `width`, is read apart; anything else is left alone.

/**
 * A passage on a page: the first and last of the page's text items, as
 * pdf.js gives them without marked content and without normalizing, from
 * 0, with the offset of its first character in the first and the offset
 * after its last character in the last.
 */
export interface PdfSelection {
  readonly beginIndex: number;
  readonly beginOffset: number;
  readonly endIndex: number;
  readonly endOffset: number;
}

/**
 * A box of a page, as PDF++'s `rect` has it: its lower-left and
 * upper-right corners, `x1, y1, x2, y2`, in the PDF's own units.
 */
export type PdfRect = readonly [number, number, number, number];

/** A place in a PDF: a page, from 1, a passage or a box on it, and its color. */
export interface PdfPlace {
  readonly page: number;
  readonly selection?: PdfSelection;
  readonly rect?: PdfRect;
  /** PDF++'s `color`, as written: a name of its palette, or `r,g,b`. */
  readonly color?: string;
}

/** A place with its passage of words. */
export interface PdfPassage extends PdfPlace {
  readonly selection: PdfSelection;
}

/** A place with its box, a highlight of an area. */
export interface PdfArea extends PdfPlace {
  readonly rect: PdfRect;
}

/** What a highlight or a link marks: a passage of words, or a box. */
export type PdfMarked = PdfPassage | PdfArea;

/** Whether a place marks a box rather than words; a place with both marks its words. */
export function isArea(place: PdfPlace): place is PdfArea {
  return place.selection === undefined && place.rect !== undefined;
}

/** What a place marks, if it marks a passage or a box. */
export function markedOf(place: PdfPlace | undefined): PdfMarked | undefined {
  if (place === undefined) return undefined;
  if (place.selection !== undefined) return { ...place, selection: place.selection };
  if (place.rect !== undefined) return { ...place, rect: place.rect };
  return undefined;
}

const count = /^\d{1,9}$/;

function whole(text: string | null): number | undefined {
  return text !== null && count.test(text.trim()) ? Number(text.trim()) : undefined;
}

function readSelection(text: string | null): PdfSelection | undefined {
  if (text === null) return undefined;
  const numbers = text.split(",").map((part) => whole(part));
  if (numbers.length !== 4) return undefined;
  const [beginIndex, beginOffset, endIndex, endOffset] = numbers;
  if (
    beginIndex === undefined ||
    beginOffset === undefined ||
    endIndex === undefined ||
    endOffset === undefined ||
    endIndex < beginIndex
  ) {
    return undefined;
  }
  return { beginIndex, beginOffset, endIndex, endOffset };
}

function readRect(text: string | null): PdfRect | undefined {
  if (text === null) return undefined;
  const numbers = text.split(",").map((part) => (part.trim() === "" ? NaN : Number(part)));
  const [x1, y1, x2, y2] = numbers;
  if (
    numbers.length !== 4 ||
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    !numbers.every(Number.isFinite) ||
    x1 === x2 ||
    y1 === y2
  ) {
    return undefined;
  }
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/**
 * The place the part of a link after its `#` names in a PDF; undefined
 * when it names no page. A passage or a box that does not read leaves its page.
 */
export function readPdfPlace(part: string): PdfPlace | undefined {
  const params = new URLSearchParams(part.startsWith("#") ? part.slice(1) : part);
  const page = whole(params.get("page"));
  if (page === undefined || page < 1) return undefined;
  const selection = readSelection(params.get("selection"));
  const rect = readRect(params.get("rect"));
  const color = params.get("color")?.trim() ?? "";
  return {
    page,
    ...(selection === undefined ? {} : { selection }),
    ...(rect === undefined ? {} : { rect }),
    ...(color === "" ? {} : { color }),
  };
}

/** An embed's size, in pixels, from the part of its link after `#`: Obsidian's `height`, PDF++'s `width`. */
export function readEmbedSize(part: string | undefined): {
  readonly width?: number;
  readonly height?: number;
} {
  const params = new URLSearchParams(part?.replace(/^#/, "") ?? "");
  const width = whole(params.get("width"));
  const height = whole(params.get("height"));
  return {
    ...(width === undefined || width === 0 ? {} : { width }),
    ...(height === undefined || height === 0 ? {} : { height }),
  };
}

/** The part of a link after its `#` for a place, as Obsidian writes it, and PDF++ its color. */
export function writePdfPlace(place: PdfPlace): string {
  let part = `page=${String(place.page)}`;
  if (place.selection !== undefined) {
    const { beginIndex, beginOffset, endIndex, endOffset } = place.selection;
    part += `&selection=${[beginIndex, beginOffset, endIndex, endOffset].join(",")}`;
  }
  // PDF++ writes a box in whole units.
  if (place.rect !== undefined) part += `&rect=${place.rect.map((n) => Math.round(n)).join(",")}`;
  return place.color === undefined ? part : `${part}&color=${place.color}`;
}

/** Whether the part of a link after its `#` names a passage or a box, as a highlight's link does. */
export function namesPassage(part: string | undefined): boolean {
  // Most links are to notes: those without a selection or a box are told at once.
  if (part === undefined || !(part.includes("selection=") || part.includes("rect="))) return false;
  return markedOf(readPdfPlace(part)) !== undefined;
}

/** Whether a file is a PDF, by its path's extension. */
export function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

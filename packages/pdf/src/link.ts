// A place in a PDF, as Obsidian links to it (ADR 0061): a page,
// `paper.pdf#page=3`, or a passage on it, as Copy link to selection
// writes it, `paper.pdf#page=3&selection=4,0,5,20`, with PDF++'s color
// after it, `&color=red` (ADR 0062). What else the part after `#` says,
// as `height=400`, is left alone.

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

/** A place in a PDF: a page, from 1, a passage on it, and the passage's color. */
export interface PdfPlace {
  readonly page: number;
  readonly selection?: PdfSelection;
  /** PDF++'s `color`, as written: a name of its palette, or `r,g,b`. */
  readonly color?: string;
}

/** A place with its passage, which a highlight always has. */
export interface PdfPassage extends PdfPlace {
  readonly selection: PdfSelection;
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

/**
 * The place the part of a link after its `#` names in a PDF; undefined
 * when it names no page. A passage that does not read leaves its page.
 */
export function readPdfPlace(part: string): PdfPlace | undefined {
  const params = new URLSearchParams(part.startsWith("#") ? part.slice(1) : part);
  const page = whole(params.get("page"));
  if (page === undefined || page < 1) return undefined;
  const selection = readSelection(params.get("selection"));
  const color = params.get("color")?.trim() ?? "";
  return {
    page,
    ...(selection === undefined ? {} : { selection }),
    ...(color === "" ? {} : { color }),
  };
}

/** The part of a link after its `#` for a place, as Obsidian writes it, and PDF++ its color. */
export function writePdfPlace(place: PdfPlace): string {
  let part = `page=${String(place.page)}`;
  if (place.selection !== undefined) {
    const { beginIndex, beginOffset, endIndex, endOffset } = place.selection;
    part += `&selection=${[beginIndex, beginOffset, endIndex, endOffset].join(",")}`;
  }
  return place.color === undefined ? part : `${part}&color=${place.color}`;
}

/** Whether the part of a link after its `#` names a passage, as a highlight's link does. */
export function namesPassage(part: string | undefined): boolean {
  // Most links are to notes: those without a selection are told at once.
  if (part?.includes("selection=") !== true) return false;
  return readPdfPlace(part)?.selection !== undefined;
}

/** Whether a file is a PDF, by its path's extension. */
export function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

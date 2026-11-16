export {
  type PdfPassage,
  type PdfPlace,
  type PdfSelection,
  isPdf,
  namesPassage,
  readPdfPlace,
  writePdfPlace,
} from "./link.ts";
export {
  type PageText,
  type TextItem,
  findOnPage,
  fitsPage,
  locatePassage,
  normalizeWords,
  pageText,
  pagesOutwards,
  passageWords,
} from "./text.ts";
export {
  type Highlight,
  type NewHighlight,
  addHighlight,
  commentBlocks,
  commentMarkdown,
  highlightCallout,
  highlightKind,
  highlightsNote,
  readHighlight,
  readHighlights,
  rewrite,
  withColor,
  withComment,
  withoutHighlight,
} from "./highlights.ts";
export {
  type HighlightColor,
  colorValue,
  defaultColor,
  highlightColors,
  offeredColor,
} from "./colors.ts";

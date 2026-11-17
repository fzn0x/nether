// Reading the tab a clip is of (ADR 0066), in the tab itself: the selection
// as it is, or the whole page through Mozilla's Readability, the library
// of Firefox's Reader View, on a copy of the page so menus and footers stay
// behind. Links and images keep addresses that work away from the page.
import { Readability } from "@mozilla/readability";

/** What a clip reads of a page. */
export interface Page {
  readonly url: string;
  readonly title: string;
  /** The HTML to turn into Markdown: the selection's, or the article's. */
  readonly html: string;
  /** Whether it is the selection, rather than the whole page. */
  readonly selected: boolean;
  /** Whether the page has a selection to clip at all. */
  readonly hasSelection: boolean;
  /** Who wrote it, when the page names them. */
  readonly byline?: string;
}

/**
 * Makes each link's and image's address absolute against the page, and
 * drops what would not work in a note: script links, and image sources
 * that depend on the screen.
 */
export function absolute(root: ParentNode, base: string): void {
  for (const element of root.querySelectorAll("a[href], img[src], img[srcset], source")) {
    for (const name of ["href", "src"]) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      try {
        const url = new URL(value, base);
        if (url.protocol === "javascript:") element.removeAttribute(name);
        else element.setAttribute(name, url.href);
      } catch {
        element.removeAttribute(name);
      }
    }
    element.removeAttribute("srcset");
  }
}

/** The HTML of the selection's ranges, joined, with addresses made absolute. */
function selectionHtml(document: Document, selection: Selection | null): string {
  if (selection === null || selection.isCollapsed || selection.toString().trim() === "") return "";
  const holder = document.createElement("div");
  for (let at = 0; at < selection.rangeCount; at++) {
    holder.append(selection.getRangeAt(at).cloneContents());
  }
  absolute(holder, document.baseURI);
  return holder.innerHTML;
}

/**
 * A page's title as a note's: its first heading, when the title is that
 * heading and more, as `How tides work | The Sea Paper` is; else the title.
 */
function titleOf(document: Document, found: string): string {
  const title = found.trim() === "" ? document.title.trim() : found.trim();
  const heading = document.querySelector("h1")?.textContent.replace(/\s+/g, " ").trim() ?? "";
  return heading !== "" && heading.length < title.length && title.includes(heading)
    ? heading
    : title;
}

/** Reads a page: its selection unless `whole`, else its article, else its body. */
export function readPage(document: Document, selection: Selection | null, whole: boolean): Page {
  const url = document.location.href;
  const chosen = selectionHtml(document, selection);
  const base = { url, hasSelection: chosen !== "" };
  if (chosen !== "" && !whole) {
    return { ...base, title: titleOf(document, ""), html: chosen, selected: true };
  }
  const copy = document.cloneNode(true) as Document;
  const article = new Readability(copy).parse();
  const holder = document.createElement("div");
  if (article !== null && typeof article.content === "string" && article.content !== "") {
    holder.innerHTML = article.content;
  } else {
    holder.innerHTML = document.body.innerHTML;
    for (const hidden of holder.querySelectorAll("script, style, noscript, template")) {
      hidden.remove();
    }
  }
  absolute(holder, document.baseURI);
  const byline = article?.byline?.trim() ?? "";
  return {
    ...base,
    title: titleOf(document, article?.title ?? ""),
    html: holder.innerHTML,
    selected: false,
    ...(byline === "" ? {} : { byline }),
  };
}

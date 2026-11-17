// What a clip saves (ADR 0066): the page's HTML as Markdown, by the
// importer's own `htmlToMarkdown` (ADR 0030), so a clipped page reads as
// an imported one; and around it, a new note's frontmatter of where it
// came from and when, or the heading it is added to a note under.
import type { JsonValue, PropertyEntry } from "@nether/core";
import { safeName, writeFrontmatter } from "@nether/markdown";
import { htmlToMarkdown } from "@nether/markdown/html-import";
import type { Page } from "./page.ts";

/** The longest title a clip's file name takes. */
const longestTitle = 120;

/** A page's HTML as Markdown, ending with one line break. */
export function pageMarkdown(page: Pick<Page, "html">): string {
  const { markdown } = htmlToMarkdown(page.html);
  const text = markdown.trim();
  return text === "" ? "" : `${text}\n`;
}

/** A day as the frontmatter writes it, `2026-11-17`, in the browser's own time zone. */
export function dayOf(date: Date): string {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The properties a clip gives a new note or a row: where it came from, when, and by whom. */
export function clipProperties(page: Page, clipped: Date): Record<string, JsonValue> {
  return {
    source: page.url,
    clipped: dayOf(clipped),
    ...(page.byline === undefined ? {} : { author: page.byline }),
  };
}

/** A title as a note's file name takes it, never too long for one. */
export function clipTitle(title: string): string {
  const name = safeName(title);
  if (name.length <= longestTitle) return name;
  return name.slice(0, longestTitle).replace(/[. ]+$/, "");
}

/** Where a new note of a clip goes: its folder, and its title as a file name. */
export function clipPath(folder: string, title: string): string {
  const parts = folder
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => safeName(part));
  return [...parts, `${clipTitle(title)}.md`].join("/");
}

/** A new note's text: the clip's properties as frontmatter, then its Markdown. */
export function newNoteText(page: Page, markdown: string, clipped: Date): string {
  const entries: PropertyEntry[] = Object.entries(clipProperties(page, clipped)).map(
    ([key, value]) => ({ key, value }),
  );
  const yaml = writeFrontmatter(undefined, [], entries) ?? "";
  return `---\n${yaml.replace(/\n$/, "")}\n---\n${markdown}`;
}

/** Text as a link's label, with the brackets that would end it escaped. */
function label(text: string): string {
  return text.replace(/[[\]\\]/g, (character) => `\\${character}`);
}

/**
 * A note's text with a clip added at its end: a heading of the page's
 * title, linking to it, then the clip's Markdown.
 */
export function appendedText(existing: string, page: Page, markdown: string): string {
  const before = existing.replace(/\s+$/, "");
  const heading = `## [${label(page.title.trim() === "" ? page.url : page.title.trim())}](<${page.url}>)`;
  const section = `${heading}\n\n${markdown}`;
  return before === "" ? section : `${before}\n\n${section}`;
}

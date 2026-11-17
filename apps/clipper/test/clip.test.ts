// What a clip saves (ADR 0066): the page as Markdown, read as the importer
// reads a page; a new note's frontmatter of where it came from; the heading
// it is added to a note under; and the paths and titles a note can have.
import { parseMarkdown } from "@nether/markdown";
import { describe, expect, it } from "vitest";
import {
  appendedText,
  clipPath,
  clipProperties,
  clipTitle,
  dayOf,
  newNoteText,
  pageMarkdown,
} from "../src/clip.ts";
import type { Page } from "../src/page.ts";

const page: Page = {
  url: "https://sea.example/2026/tides?ref=feed",
  title: "How tides work",
  html: [
    "<h2>The moon</h2>",
    '<p>It <strong>pulls</strong> the sea, as <a href="https://sea.example/moon">this page</a> says.</p>',
    "<ul><li>High tide</li><li>Low tide</li></ul>",
    '<img src="https://sea.example/moon.png" alt="Moon">',
  ].join(""),
  selected: false,
  hasSelection: false,
  byline: "Ada Lovelace",
};

const clipped = new Date(2026, 10, 17, 9, 30);

describe("pageMarkdown", () => {
  it("writes the page's HTML as the importer writes a page", () => {
    expect(pageMarkdown(page)).toBe(
      [
        "## The moon",
        "",
        "It **pulls** the sea, as [this page](https://sea.example/moon) says.",
        "",
        "- High tide",
        "- Low tide",
        "",
        "![Moon](https://sea.example/moon.png)",
        "",
      ].join("\n"),
    );
    expect(pageMarkdown({ html: "<div>  </div>" })).toBe("");
  });
});

describe("a new note", () => {
  it("has the clip's source, date and author as frontmatter, then its Markdown", () => {
    expect(clipProperties(page, clipped)).toEqual({
      source: "https://sea.example/2026/tides?ref=feed",
      clipped: "2026-11-17",
      author: "Ada Lovelace",
    });
    const text = newNoteText(page, "Some text.\n", clipped);
    const parsed = parseMarkdown(text);
    expect(parsed.frontmatterError).toBeUndefined();
    expect(parsed.properties).toEqual([
      { key: "source", value: "https://sea.example/2026/tides?ref=feed" },
      { key: "clipped", value: "2026-11-17" },
      { key: "author", value: "Ada Lovelace" },
    ]);
    expect(text.endsWith("---\nSome text.\n")).toBe(true);
    const { byline, ...anonymous } = page;
    expect(byline).toBe("Ada Lovelace");
    expect(clipProperties(anonymous, clipped)).not.toHaveProperty("author");
  });

  it("goes to a folder, at its title as a file's name", () => {
    expect(clipPath("Clips", "How tides work")).toBe("Clips/How tides work.md");
    expect(clipPath(" /Reading/ 2026 / ", "What: a guide? [part 1]")).toBe(
      "Reading/2026/What a guide part 1.md",
    );
    expect(clipPath("", "...")).toBe("Untitled.md");
    expect(clipTitle("x".repeat(300))).toHaveLength(120);
    expect(dayOf(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("appendedText", () => {
  it("adds the clip under a heading of the page's title, linking to it", () => {
    expect(appendedText("# Reading list\n\nStarted.\n\n\n", page, "Some text.\n")).toBe(
      "# Reading list\n\nStarted.\n\n## [How tides work](<https://sea.example/2026/tides?ref=feed>)\n\nSome text.\n",
    );
    expect(appendedText("", { ...page, title: "A [bracket]" }, "Text.\n")).toBe(
      "## [A \\[bracket\\]](<https://sea.example/2026/tides?ref=feed>)\n\nText.\n",
    );
  });
});

import { parseMarkdown } from "@nether/markdown";
import { describe, expect, it } from "vitest";
import { readPassageLinks } from "../src/index.ts";

const selection = { beginIndex: 32, beginOffset: 0, endIndex: 32, endOffset: 14 };

describe("links to a passage in a note's prose", () => {
  it("reads Obsidian's Copy as quote, its words before the link", () => {
    const [link] = readPassageLinks(
      parseMarkdown(
        "> Obsidian is awesome [[Gemmy.pdf#page=1&selection=32,0,32,14|Gemmy, page 1]]\n",
      ).content,
    );
    expect(link).toMatchObject({
      target: "Gemmy.pdf",
      passage: { page: 1, selection },
      words: "Obsidian is awesome",
    });
  });

  it("reads PDF++'s Quote, Callout and Quote in callout, with their colors", () => {
    const note = [
      "> ([[paper.pdf#page=2&selection=0,0,0,5|paper, page 2]])",
      "> Quoted words",
      "",
      "> [!PDF|red] [[paper.pdf#page=3&selection=1,0,1,4&color=red|paper, page 3]]",
      "> Callout words",
      "",
      "> [!PDF|note] [[paper.pdf#page=4&selection=2,0,2,6&color=note|paper, page 4]]",
      "> > Words in a quote",
      ">",
      "> A comment",
      "",
    ].join("\n");
    const links = readPassageLinks(parseMarkdown(note).content);
    expect(links.map((link) => [link.passage.page, link.passage.color, link.words])).toEqual([
      [2, undefined, "Quoted words"],
      [3, "red", "Callout words"],
      [4, "note", "Words in a quote"],
    ]);
  });

  it("reads links in prose, lists, tables and callouts, and several in one block", () => {
    const note = [
      "# Notes",
      "",
      "As [[a.pdf#page=1&selection=0,0,0,1|the paper]] and [[a.pdf#page=2&selection=0,0,0,1]] say.",
      "",
      "- A point [[Papers/a.pdf#page=5&selection=3,1,4,2]]",
      "",
      "| Where | What |",
      "| --- | --- |",
      "| [[a.pdf#page=6&selection=0,0,0,2]] | a cell |",
      "",
      "> [!note] Title [[a.pdf#page=7&selection=0,0,0,3]]",
      "> Body",
      "",
      "Links that are not to a passage: [[a.pdf#page=8]], [[Note#Heading]], [[a.pdf]].",
      "",
    ].join("\n");
    const links = readPassageLinks(parseMarkdown(note).content);
    expect(links.map((link) => [link.target, link.passage.page, link.words])).toEqual([
      ["a.pdf", 1, "As and a.pdf say."],
      ["a.pdf", 2, "As the paper and say."],
      ["Papers/a.pdf", 5, "A point"],
      // A cell's words, or the next cell's.
      ["a.pdf", 6, "a cell"],
      ["a.pdf", 7, "Title"],
    ]);
  });

  it("leaves a highlight's own link out, and keeps the links in its comment", () => {
    const note = [
      "> [!quote] [[a.pdf#page=1&selection=0,0,0,4|a, page 1]]",
      "> Four",
      ">",
      "> See also [[a.pdf#page=9&selection=1,0,1,2]].",
      "",
      "^h1",
      "",
    ].join("\n");
    const links = readPassageLinks(parseMarkdown(note).content);
    expect(links.map((link) => [link.passage.page, link.words])).toEqual([[9, "See also ."]]);
  });

  it("gives a link alone in its block the next block's words, and none when there is none", () => {
    const links = readPassageLinks(
      parseMarkdown("[[a.pdf#page=1&selection=0,0,0,1]]\n\n- first\n- second\n").content,
    );
    expect(links[0]?.words).toBe("first");
    expect(
      readPassageLinks(parseMarkdown("[[a.pdf#page=1&selection=0,0,0,1]]\n").content)[0]?.words,
    ).toBe("");
  });
});

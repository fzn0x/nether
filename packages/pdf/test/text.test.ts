import { describe, expect, it } from "vitest";
import {
  type TextItem,
  findOnPage,
  fitsPage,
  locatePassage,
  normalizeWords,
  pageText,
  pagesOutwards,
  passageWords,
} from "../src/index.ts";

// A page as pdf.js gives it: items, spaces as items of their own, an empty
// item between two, and lines that end after an item.
const page: TextItem[] = [
  { str: "Attention is", hasEOL: false },
  { str: " ", hasEOL: false },
  { str: "all you", hasEOL: true },
  { str: "need, they", hasEOL: false },
  { str: "", hasEOL: false },
  { str: " said.", hasEOL: true },
  { str: "Attention", hasEOL: false },
  { str: "  again.", hasEOL: false },
];

describe("a page's words", () => {
  it("joins items, makes each run of white space one space, and a line's end a space", () => {
    const text = pageText(page);
    expect(text.text).toBe("Attention is all you need, they said. Attention again.");
    expect(text.at).toHaveLength(text.text.length);
    // Where the space after "you" came from: the end of its line.
    expect(text.at[text.text.indexOf("you") + 3]).toEqual([2, 7]);
    expect(pageText([{ str: "  a  ", hasEOL: true }]).text).toBe("a");
    expect(normalizeWords("  two\n\twords ")).toBe("two words");
  });

  it("reads a passage's words, across items and lines", () => {
    expect(passageWords(page, { beginIndex: 2, beginOffset: 0, endIndex: 3, endOffset: 4 })).toBe(
      "all you need",
    );
    expect(passageWords(page, { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 9 })).toBe(
      "Attention",
    );
  });

  it("names no words for a selection that is not on the page", () => {
    const outside = [
      { beginIndex: 8, beginOffset: 0, endIndex: 8, endOffset: 1 },
      { beginIndex: 0, beginOffset: 40, endIndex: 1, endOffset: 1 },
      { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 40 },
      { beginIndex: 0, beginOffset: 3, endIndex: 0, endOffset: 3 },
      { beginIndex: 2, beginOffset: 0, endIndex: 1, endOffset: 1 },
    ];
    for (const selection of outside) {
      expect(fitsPage(page, selection)).toBe(false);
      expect(passageWords(page, selection)).toBeUndefined();
    }
  });
});

describe("finding words on a page", () => {
  it("finds every place, white space and case aside, as selections of its items", () => {
    const found = findOnPage(page, "attention");
    expect(found).toEqual([
      { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 9 },
      { beginIndex: 6, beginOffset: 0, endIndex: 6, endOffset: 9 },
    ]);
    const across = findOnPage(page, "you\n need");
    expect(across).toEqual([{ beginIndex: 2, beginOffset: 4, endIndex: 3, endOffset: 4 }]);
    const [first] = across;
    if (first === undefined) throw new Error("not found");
    expect(passageWords(page, first)).toBe("you need");
  });

  it("matches case when asked, and finds nothing for no words", () => {
    expect(findOnPage(page, "attention", { matchCase: true })).toEqual([]);
    expect(findOnPage(page, "Attention", { matchCase: true })).toHaveLength(2);
    expect(findOnPage(page, "   ")).toEqual([]);
    expect(findOnPage(page, "not there")).toEqual([]);
  });

  it("keeps each character's place when lower case would lengthen it", () => {
    const items = [{ str: "İstanbul and Istanbul" }];
    expect(findOnPage(items, "istanbul")).toEqual([
      { beginIndex: 0, beginOffset: 13, endIndex: 0, endOffset: 21 },
    ]);
  });

  it("does not count a place twice", () => {
    expect(findOnPage([{ str: "aaaa" }], "aa")).toHaveLength(2);
  });
});

describe("finding a highlight's passage again", () => {
  const pages: Record<number, TextItem[]> = {
    1: [{ str: "Nothing here.", hasEOL: true }],
    2: page,
    3: [{ str: "They said all you need", hasEOL: true }],
  };
  const read: number[] = [];
  const itemsOf = (number: number) => {
    read.push(number);
    return Promise.resolve(pages[number] ?? []);
  };
  const selection = { beginIndex: 2, beginOffset: 0, endIndex: 3, endOffset: 4 };

  it("stays at its selection when its words are there", async () => {
    expect(await locatePassage({ page: 2, selection }, "all  you need", 3, itemsOf)).toEqual({
      page: 2,
      selection,
    });
  });

  it("finds its words on its page, then on the nearest page with them", async () => {
    const moved = { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 3 };
    expect(await locatePassage({ page: 2, selection: moved }, "all you", 3, itemsOf)).toEqual({
      page: 2,
      selection: { beginIndex: 2, beginOffset: 0, endIndex: 2, endOffset: 7 },
    });
    read.length = 0;
    expect(await locatePassage({ page: 1, selection: moved }, "They said", 3, itemsOf)).toEqual({
      page: 3,
      selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 9 },
    });
    expect(read).toEqual([1, 2, 3]);
  });

  it("keeps its selection when its words are nowhere, and is lost when neither is there", async () => {
    expect(await locatePassage({ page: 2, selection }, "rewritten", 3, itemsOf)).toEqual({
      page: 2,
      selection,
    });
    const far = { beginIndex: 40, beginOffset: 0, endIndex: 40, endOffset: 2 };
    expect(await locatePassage({ page: 2, selection: far }, "rewritten", 3, itemsOf)).toBe(
      undefined,
    );
    // A page the PDF no longer has: its words are looked for from the last.
    expect(await locatePassage({ page: 9, selection: far }, "They said", 3, itemsOf)).toEqual({
      page: 3,
      selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 9 },
    });
    expect(await locatePassage({ page: 2, selection }, "", 3, itemsOf)).toEqual({
      page: 2,
      selection,
    });
  });

  it("goes outwards from a page, before then after", () => {
    expect(pagesOutwards(3, 5)).toEqual([3, 2, 4, 1, 5]);
    expect(pagesOutwards(1, 3)).toEqual([1, 2, 3]);
    expect(pagesOutwards(1, 0)).toEqual([]);
  });
});

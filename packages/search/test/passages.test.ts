// A note's passages as search by meaning embeds them: under their headings,
// cut at paragraphs' ends, long paragraphs at sentences' ends, with the
// note's title before each, and hashes that change only with their text.
import { describe, expect, it } from "vitest";
import { hashText, passageLength, passagesOf, passagesPerNote } from "../src/passages.ts";

function words(count: number, word = "word"): string {
  return Array.from({ length: count }, () => word).join(" ");
}

describe("passagesOf", () => {
  it("makes none of a note with no text", () => {
    expect(passagesOf("Empty", "")).toEqual([]);
    expect(passagesOf("Empty", "---\ntags: [a]\n---\n\n\n")).toEqual([]);
    expect(passagesOf("Headings", "# One\n\n## Two\n")).toEqual([]);
  });

  it("keeps each passage under its headings, with the note's title first", () => {
    const passages = passagesOf(
      "Garden",
      [
        "Before any heading.",
        "",
        "# Soil",
        "",
        "Loam holds water.",
        "",
        "## Clay",
        "",
        "Clay drains slowly.",
        "",
        "# Seeds",
        "",
        "Sow in spring.",
      ].join("\n"),
    );
    expect(passages.map((passage) => passage.headings)).toEqual([
      [],
      ["Soil"],
      ["Soil", "Clay"],
      ["Seeds"],
    ]);
    expect(passages.map((passage) => passage.input)).toEqual([
      "Garden\n\nBefore any heading.",
      "Garden > Soil\n\nLoam holds water.",
      "Garden > Soil > Clay\n\nClay drains slowly.",
      "Garden > Seeds\n\nSow in spring.",
    ]);
    expect(passages.map((passage) => passage.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it("leaves the frontmatter out, and reads headings in code as code", () => {
    const passages = passagesOf(
      "Code",
      "---\ntitle: x\n---\nText.\n\n```sh\n# not a heading\necho hi\n```\n\n~~~\n## nor this\n~~~",
    );
    expect(passages).toHaveLength(1);
    expect(passages[0]?.headings).toEqual([]);
    expect(passages[0]?.input).toContain("# not a heading");
    expect(passages[0]?.input).toContain("## nor this");
    expect(passages[0]?.input).not.toContain("title: x");
  });

  it("cuts a section at a paragraph's end once it passes a passage's length", () => {
    const paragraph = words(60);
    const markdown = Array.from({ length: 12 }, () => paragraph).join("\n\n");
    const passages = passagesOf("Long", markdown);
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      const text = passage.input.slice("Long\n\n".length);
      expect(text.split("\n\n").every((part) => part === paragraph)).toBe(true);
      expect(text.length).toBeLessThan(passageLength + paragraph.length + 2);
    }
    const kept = passages.flatMap((passage) =>
      passage.input.slice("Long\n\n".length).split("\n\n"),
    );
    expect(kept).toHaveLength(12);
  });

  it("cuts a paragraph longer than two passages at its sentences' ends", () => {
    const sentence = `${words(30)}.`;
    const paragraph = Array.from({ length: 20 }, () => sentence).join(" ");
    const passages = passagesOf("Prose", paragraph);
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      const text = passage.input.slice("Prose\n\n".length);
      expect(text.length).toBeLessThanOrEqual(passageLength * 2);
      expect(text.endsWith(".")).toBe(true);
    }
  });

  it("cuts a sentence with no end at a space", () => {
    const passages = passagesOf("Run-on", words(800));
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      const text = passage.input.slice("Run-on\n\n".length);
      expect(text.startsWith("word")).toBe(true);
      expect(text.endsWith("word")).toBe(true);
    }
  });

  it("makes at most so many passages of one note", () => {
    const markdown = Array.from(
      { length: passagesPerNote + 20 },
      (_, at) => `# H${String(at)}\n\nText.`,
    ).join("\n\n");
    expect(passagesOf("Many", markdown)).toHaveLength(passagesPerNote);
  });

  it("shows the start of a passage's text, its spaces folded", () => {
    const [passage] = passagesOf("Preview", `# Head\n\nOne\nline   and\tanother ${words(100)}`);
    expect(passage?.preview.startsWith("One line and another word")).toBe(true);
    expect(passage?.preview.length).toBe(200);
  });

  it("hashes a passage by its input, so a new heading or title changes it", () => {
    const [first] = passagesOf("A", "# H\n\nSame text.");
    const [renamed] = passagesOf("B", "# H\n\nSame text.");
    const [again] = passagesOf("A", "# H\n\nSame text.");
    expect(first?.hash).toBe(again?.hash);
    expect(first?.hash).not.toBe(renamed?.hash);
    expect(first?.hash).toBe(hashText("A > H\n\nSame text."));
  });
});

describe("hashText", () => {
  it("gives sixteen hex digits, the same for the same text", () => {
    expect(hashText("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText("x")).toBe(hashText("x"));
    expect(hashText("x")).not.toBe(hashText("y"));
    expect(hashText("")).toMatch(/^[0-9a-f]{16}$/);
  });
});

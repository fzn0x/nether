import { describe, expect, it } from "vitest";
import { localize, readManifest } from "../src/manifest.ts";

const good = {
  id: "word-count",
  name: { en: "Word count", fr: "Nombre de mots" },
  version: "1.0.2",
  api: "^0.1",
  description: "Counts the words of a note.",
  author: "Ada",
  authorUrl: "https://example.org",
  contributes: {
    commands: [
      { id: "count", name: "Count words", menu: "note", keys: ["Mod+Shift+K"] },
      { id: "reset_all", name: { en: "Reset" } },
    ],
    codeBlocks: [
      { language: "abc", name: { en: "Tune" }, keywords: "music notation", text: "X:1" },
      { language: "c++" },
    ],
    blocks: [
      { type: "board", name: "Board", keywords: { en: "kanban" }, attrs: { columns: [] } },
      { type: "tallyCount", name: "Tally" },
    ],
  },
};

describe("readManifest", () => {
  it("reads a manifest, with a command's menu and keys defaulted", () => {
    const { manifest, problems } = readManifest(good);
    expect(problems).toBeUndefined();
    expect(manifest?.contributes.commands).toEqual([
      { id: "count", name: "Count words", menu: "note", keys: ["Mod+Shift+K"] },
      { id: "reset_all", name: { en: "Reset" }, menu: "plugins", keys: [] },
    ]);
    expect(manifest?.contributes.codeBlocks).toEqual([
      {
        language: "abc",
        slash: { name: { en: "Tune" }, keywords: "music notation", text: "X:1" },
      },
      { language: "c++" },
    ]);
    expect(manifest?.contributes.blocks).toEqual([
      {
        type: "board",
        slash: { name: "Board", keywords: { en: "kanban" } },
        attrs: { columns: [] },
      },
      { type: "tallyCount", slash: { name: "Tally" }, attrs: {} },
    ]);
    expect(manifest?.author).toBe("Ada");
  });

  it("reads one that adds nothing", () => {
    const { manifest } = readManifest({ id: "a", name: "A", version: "0.0.1", api: "0.1.0" });
    expect(manifest?.contributes).toEqual({
      commands: [],
      codeBlocks: [],
      blocks: [],
      panels: [],
    });
    expect(manifest).not.toHaveProperty("description");
  });

  it("lists everything wrong at once", () => {
    const { manifest, problems } = readManifest({
      id: "Word Count",
      name: "",
      version: "1.0",
      api: "latest",
      description: 3,
      author: 1,
      authorUrl: false,
      contributes: [],
    });
    expect(manifest).toBeUndefined();
    expect(problems).toEqual([
      "id is not lowercase words joined by hyphens.",
      "name is not a name.",
      "version is not a version, as 1.0.0.",
      "api is not a range of versions, as ^0.1.",
      "description is not text.",
      "author is not text.",
      "authorUrl is not text.",
      "contributes is not an object.",
    ]);
  });

  it("says what is wrong with its commands", () => {
    const { problems } = readManifest({
      ...good,
      contributes: {
        commands: [
          "count",
          { id: "has space", name: "A" },
          { id: "a", name: { "not a tag": "A" } },
          { id: "a", name: "A", menu: "edit", keys: "Mod+K" },
        ],
      },
    });
    expect(problems).toEqual([
      "contributes.commands[0] is not an object.",
      "contributes.commands[1].id is not letters, digits, hyphens and underscores.",
      "contributes.commands[2].name is not a name.",
      'contributes.commands[3].id "a" is there twice.',
      "contributes.commands[3].menu is not one of file, note, view, sync, settings, plugins.",
      "contributes.commands[3].keys is not a list of shortcuts.",
    ]);
    expect(readManifest({ ...good, contributes: { commands: {} } }).problems).toEqual([
      "contributes.commands is not a list.",
    ]);
  });

  it("says what is wrong with its code blocks", () => {
    const { problems } = readManifest({
      ...good,
      contributes: {
        codeBlocks: [
          { language: "Mermaid" },
          { language: "" },
          3,
          { language: "abc" },
          { language: "abc" },
        ],
      },
    });
    expect(problems).toEqual([
      "contributes.codeBlocks[0].language is not a code block's language in lowercase, as mermaid.",
      "contributes.codeBlocks[1].language is not a code block's language in lowercase, as mermaid.",
      "contributes.codeBlocks[2] is not an object.",
      'contributes.codeBlocks[4].language "abc" is there twice.',
    ]);
    expect(readManifest({ ...good, contributes: { codeBlocks: "abc" } }).problems).toEqual([
      "contributes.codeBlocks is not a list.",
    ]);
  });

  it("gives a code block's slash entry empty text unless it says some", () => {
    const { manifest } = readManifest({
      ...good,
      contributes: { codeBlocks: [{ language: "abc", name: "Tune" }] },
    });
    expect(manifest?.contributes.codeBlocks).toEqual([
      { language: "abc", slash: { name: "Tune", text: "" } },
    ]);
  });

  it("says what is wrong with its blocks and their slash entries", () => {
    const { problems } = readManifest({
      ...good,
      contributes: {
        codeBlocks: [{ language: "abc", name: "", keywords: 3, text: 4 }],
        blocks: [
          { type: "Board", name: "A" },
          { type: "board" },
          { type: "board", name: "B", attrs: [] },
          { type: "list", name: "L", attrs: { at: Number.NaN } },
        ],
      },
    });
    expect(problems).toEqual([
      "contributes.codeBlocks[0].text is not text.",
      "contributes.codeBlocks[0].keywords is not text.",
      "contributes.codeBlocks[0].name is not a name.",
      "contributes.blocks[0].type is not a lowercase letter, then letters, digits and hyphens.",
      "contributes.blocks[1].name is not a name.",
      'contributes.blocks[2].type "board" is there twice.',
      "contributes.blocks[2].attrs is not a JSON object.",
      "contributes.blocks[3].attrs is not a JSON object.",
    ]);
  });

  it("keeps blocks from a plugin whose ID starts with a digit, as a block's type cannot", () => {
    expect(
      readManifest({ ...good, id: "3d", contributes: { blocks: [{ type: "scene", name: "S" }] } })
        .problems,
    ).toEqual(["id starts with a digit, which a plugin that adds blocks cannot."]);
    expect(readManifest({ ...good, id: "3d", contributes: {} }).problems).toBeUndefined();
  });

  it("reads panels, each in its place, folded only when it says so", () => {
    const { manifest } = readManifest({
      ...good,
      contributes: {
        panels: [
          { id: "stats", name: "Statistics", place: "sidebar" },
          { id: "words", name: { en: "Words" }, place: "note", folded: true },
        ],
      },
    });
    expect(manifest?.contributes.panels).toEqual([
      { id: "stats", name: "Statistics", place: "sidebar", folded: false },
      { id: "words", name: { en: "Words" }, place: "note", folded: true },
    ]);
  });

  it("says what is wrong with its panels", () => {
    const { problems } = readManifest({
      ...good,
      contributes: {
        panels: [
          { id: "a b", name: "A", place: "note" },
          { id: "a", place: "toolbar", folded: "yes" },
          { id: "a", name: "A", place: "note" },
        ],
      },
    });
    expect(problems).toEqual([
      "contributes.panels[0].id is not letters, digits, hyphens and underscores.",
      "contributes.panels[1].name is not a name.",
      "contributes.panels[1].place is not one of sidebar, note.",
      "contributes.panels[1].folded is not true or false.",
      'contributes.panels[2].id "a" is there twice.',
    ]);
  });

  it("refuses what is not an object", () => {
    expect(readManifest([]).problems).toEqual(["The manifest is not an object."]);
    expect(readManifest(null).problems).toEqual(["The manifest is not an object."]);
  });
});

describe("localize", () => {
  const name = { en: "Count", fr: "Compter", "pt-BR": "Contar" };

  it("picks the language, then its main language, then English, then the first", () => {
    expect(localize(name, "fr")).toBe("Compter");
    expect(localize(name, "pt-br")).toBe("Contar");
    expect(localize(name, "fr-CA")).toBe("Compter");
    expect(localize(name, "de")).toBe("Count");
    expect(localize({ ja: "数える", ko: "세다" }, "de")).toBe("数える");
    expect(localize("Count", "fr")).toBe("Count");
  });
});

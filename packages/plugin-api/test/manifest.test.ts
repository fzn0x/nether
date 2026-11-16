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
    codeBlocks: [{ language: "abc" }, { language: "c++" }],
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
    expect(manifest?.contributes.codeBlocks).toEqual([{ language: "abc" }, { language: "c++" }]);
    expect(manifest?.author).toBe("Ada");
  });

  it("reads one that adds nothing", () => {
    const { manifest } = readManifest({ id: "a", name: "A", version: "0.0.1", api: "0.1.0" });
    expect(manifest?.contributes).toEqual({ commands: [], codeBlocks: [] });
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

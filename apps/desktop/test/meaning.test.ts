// Search by meaning on a vault: its choice kept on this device, its notes
// embedded as passages in the background, only changed passages sent
// again, deleted notes forgotten, the provider's errors waited out, and a
// search that finds the note closest in meaning and lets its signs go.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  type Embed,
  MeaningIndexer,
  MeaningSearch,
  meaningChoice,
  setMeaningChoice,
} from "../src/meaning.ts";

/** Topics a fake model knows: each is a number of its vector, counting the topic's words. */
const topics = [
  ["soil", "seed", "seeds", "garden", "plant"],
  ["loop", "function", "code", "compile"],
  ["melody", "chord", "song", "music"],
];

function vectorOf(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  return topics.map((topic) => words.filter((word) => topic.includes(word)).length + 0.01);
}

function fakeModel() {
  const sent: string[][] = [];
  const embed: Embed = (inputs) => {
    sent.push([...inputs]);
    return Promise.resolve(inputs.map(vectorOf));
  };
  return { embed, sent };
}

async function setUp() {
  const vault = new Vault(
    new MemoryFiles({
      "Garden.md": "# Beds\n\nTurn the soil before the seeds go in.\n\n# Tools\n\nA spade.",
      "Code.md": "A loop calls the function again.",
      "Songs.md": "The melody rides over the chord.",
    }),
    new MemoryStore(),
  );
  await vault.open();
  const choice = { provider: "local", model: "nomic-embed-text" };
  await setMeaningChoice(vault, choice);
  return { vault, choice };
}

const idOf = (vault: Vault, title: string) => {
  const note = vault.notes().find((each) => each.title === title);
  if (note === undefined) throw new Error(`No ${title}.`);
  return note.id;
};

describe("meaningChoice", () => {
  it("is off until chosen, and kept until turned off", async () => {
    const vault = new Vault(new MemoryFiles({}), new MemoryStore());
    await vault.open();
    expect(await meaningChoice(vault)).toBeUndefined();
    await setMeaningChoice(vault, { provider: "p", model: "m" });
    expect(await meaningChoice(vault)).toEqual({ provider: "p", model: "m" });
    await setMeaningChoice(vault, undefined);
    expect(await meaningChoice(vault)).toBeUndefined();
  });

  it("forgets the kept passages for another model, and keeps them for the same one", async () => {
    const { vault, choice } = await setUp();
    const { embed } = fakeModel();
    await new MeaningIndexer(vault, choice, embed).start();
    expect(await vault.meaning.meaningFiles()).toHaveLength(3);
    await setMeaningChoice(vault, undefined);
    await setMeaningChoice(vault, choice);
    expect(await vault.meaning.meaningFiles()).toHaveLength(3);
    await setMeaningChoice(vault, { ...choice, model: "another" });
    expect(await vault.meaning.meaningFiles()).toEqual([]);
  });
});

describe("MeaningIndexer", () => {
  it("embeds every note's passages, many to a request", async () => {
    const { vault, choice } = await setUp();
    const { embed, sent } = fakeModel();
    const indexer = new MeaningIndexer(vault, choice, embed);
    const seen: number[] = [];
    indexer.subscribe((progress) => seen.push(progress.done));
    await indexer.start();
    indexer.stop();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(4);
    expect(sent[0]).toContain("Garden > Beds\n\nTurn the soil before the seeds go in.");
    expect(indexer.progress).toMatchObject({ done: 3, total: 3, running: false, error: undefined });
    expect(seen.at(-1)).toBe(3);
    const garden = await vault.meaning.notePassages(idOf(vault, "Garden"));
    expect(garden.map((passage) => passage.heading)).toEqual(["Beds", "Tools"]);
  });

  it("sends only the passages whose text changed, and forgets deleted notes", async () => {
    const { vault, choice } = await setUp();
    const { embed, sent } = fakeModel();
    const indexer = new MeaningIndexer(vault, choice, embed);
    await indexer.start();
    const garden = idOf(vault, "Garden");
    const { hash } = await vault.read(garden);
    await vault.write(
      garden,
      "# Beds\n\nTurn the soil before the seeds go in.\n\n# Tools\n\nA spade and a rake.",
      hash,
    );
    await vault.remove(idOf(vault, "Songs"));
    await indexer.start();
    indexer.stop();
    expect(sent.at(-1)).toEqual(["Garden > Tools\n\nA spade and a rake."]);
    const files = (await vault.meaning.meaningFiles()).map((file) => file.note).sort();
    expect(files).toEqual([garden, idOf(vault, "Code")].sort());
  });

  it("waits out the provider's errors, then goes on", async () => {
    const { vault, choice } = await setUp();
    let fails = 1;
    const errors: (string | undefined)[] = [];
    const embed: Embed = (inputs) => {
      if (fails-- > 0) return Promise.reject(new Error("The provider is busy."));
      return Promise.resolve(inputs.map(vectorOf));
    };
    const indexer = new MeaningIndexer(vault, choice, embed, { retryAfter: 5 });
    indexer.subscribe((progress) => errors.push(progress.error));
    await indexer.start();
    indexer.stop();
    expect(errors).toContain("The provider is busy.");
    expect(indexer.progress.error).toBeUndefined();
    expect(await vault.meaning.meaningFiles()).toHaveLength(3);
  });

  it("refuses vectors of another length than the model's first", async () => {
    const { vault, choice } = await setUp();
    let length = 3;
    const embed: Embed = (inputs) =>
      Promise.resolve(inputs.map(() => Array.from({ length }, () => 1)));
    const first = new MeaningIndexer(vault, choice, embed);
    await first.start();
    first.stop();
    length = 5;
    const code = idOf(vault, "Code");
    const { hash } = await vault.read(code);
    await vault.write(code, "Another loop.", hash);
    const second = new MeaningIndexer(vault, choice, embed, { retryAfter: 1000 });
    const run = second.start();
    await expect.poll(() => second.progress.error).toMatch(/were 3 numbers long and are now 5/);
    second.stop();
    await run;
  });

  it("stops mid-pass, keeping what it kept", async () => {
    const { vault, choice } = await setUp();
    const indexer = new MeaningIndexer(
      vault,
      choice,
      () => new Promise<number[][]>(() => undefined),
    );
    const run = indexer.start();
    indexer.stop();
    await run;
    expect(indexer.progress.running).toBe(false);
    expect(await vault.meaning.meaningFiles()).toEqual([]);
  });
});

describe("MeaningSearch", () => {
  it("finds the notes closest in meaning, each by its closest passage", async () => {
    const { vault, choice } = await setUp();
    const { embed } = fakeModel();
    await new MeaningIndexer(vault, choice, embed).start();
    const search = new MeaningSearch(vault);
    const hits = await search.search(vectorOf("where should I plant seeds"));
    expect(hits[0]?.note.title).toBe("Garden");
    expect(hits.map((hit) => hit.note.title).sort()).toEqual(["Code", "Garden", "Songs"]);
    expect(hits[0]).toMatchObject({ heading: "Beds" });
    expect(hits[0]?.preview).toBe("Turn the soil before the seeds go in.");
    expect(hits[0]?.score).toBeGreaterThan(0.9);
    const music = await search.search(vectorOf("a new song"), 1);
    expect(music.map((hit) => hit.note.title)).toEqual(["Songs"]);
  });

  it("holds the signs it read a while, and lets them go", async () => {
    const { vault, choice } = await setUp();
    const { embed } = fakeModel();
    await new MeaningIndexer(vault, choice, embed).start();
    const search = new MeaningSearch(vault, 20);
    expect(search.holding).toBe(false);
    await search.search(vectorOf("chord"));
    expect(search.holding).toBe(true);
    await expect.poll(() => search.holding).toBe(false);
    await search.search(vectorOf("chord"));
    search.forget();
    expect(search.holding).toBe(false);
  });

  it("finds nothing in a vault with no passages", async () => {
    const vault = new Vault(new MemoryFiles({}), new MemoryStore());
    await vault.open();
    expect(await new MeaningSearch(vault).search([1, 0, 0])).toEqual([]);
  });
});

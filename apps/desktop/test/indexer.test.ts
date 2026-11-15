// The link index when its worker cannot load: it says why, rather than
// show it reading the vault's first notes for ever. And the strings the
// notes' indexes share as they load.
import type { NoteIndex } from "@nether/graph";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import { Indexer, shareStrings, type StringPool } from "../src/indexer.ts";

/** A worker that only takes its handlers, as one whose module failed. */
function brokenWorker(): Worker & { fail(message: string): void } {
  const worker = {
    onmessage: null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage: () => undefined,
    terminate: () => undefined,
    fail(message: string) {
      this.onerror?.({ message, preventDefault: () => undefined } as unknown as ErrorEvent);
    },
  };
  return worker as unknown as Worker & { fail(message: string): void };
}

describe("Indexer", () => {
  it("tells its listeners why its worker failed", () => {
    const worker = brokenWorker();
    const indexer = new Indexer(new Vault(new MemoryFiles(), new MemoryStore()), worker);
    let told = 0;
    indexer.subscribe(() => {
      told++;
    });
    expect(indexer.error()).toBeUndefined();
    worker.fail("document is not defined");
    expect(indexer.error()).toBe("document is not defined");
    expect(told).toBe(1);
  });

  it("names a failure that came with no message", () => {
    const worker = brokenWorker();
    const indexer = new Indexer(new Vault(new MemoryFiles(), new MemoryStore()), worker);
    worker.fail("");
    expect(indexer.error()).toBe("The worker stopped.");
  });
});

describe("shareStrings", () => {
  const row = JSON.stringify({
    links: [
      { target: "Roadmap", heading: "Next", embed: false, context: "" },
      { target: "Plan", embed: true, context: "" },
    ],
    tags: ["area/work"],
    aliases: ["Road"],
    headings: [{ level: 1, text: "Summary" }],
    blocks: ["b1"],
    properties: [
      { key: "status", value: "done" },
      { key: "people", value: ["Ada", 3] },
    ],
  });

  it("keeps what each index holds, with one copy of each string in the pool", () => {
    const pool: StringPool = new Map();
    const first = shareStrings(JSON.parse(row) as NoteIndex, pool);
    const second = shareStrings(JSON.parse(row) as NoteIndex, pool);
    expect(first).toEqual(JSON.parse(row));
    expect(second).toEqual(first);
    expect([...pool.keys()].sort()).toEqual(
      [
        "Ada",
        "Next",
        "Plan",
        "Road",
        "Roadmap",
        "Summary",
        "area/work",
        "done",
        "people",
        "status",
      ].sort(),
    );
  });

  it("leaves the shared empty lists alone", () => {
    const none = Object.freeze([]) as readonly never[];
    const index: NoteIndex = {
      links: none,
      tags: none,
      aliases: none,
      headings: none,
      blocks: none,
      properties: none,
    };
    expect(() => shareStrings(index, new Map())).not.toThrow();
  });
});

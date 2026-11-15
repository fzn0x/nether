// The Phase 3 gate: two people co-edit offline and online with no lost
// edits. Ada, the admin, and Grace, a member she invites, each sync a vault
// of their own through a real server. Each makes the edits a seeded random
// sequence picks: a new word written in at a word's boundary, or a word of
// their own taken out again. They edit live, each with the note open;
// offline, both at once, in two notes, each also making a note; and one
// live while the other is offline. Every time both end with the same text:
// every word written and not taken out, once, and no word taken out.
//
// NETHER_GATE_SEED=<n> runs one seed: the same edits, as far as sync's
// timing lets the words around each be the same.
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { MemoryVault, device, password, startServer, stopAll } from "./harness.ts";

afterEach(stopAll);

const seeds =
  (process.env.NETHER_GATE_SEED ?? "") === "" ? [1, 2, 3] : [Number(process.env.NETHER_GATE_SEED)];

/** Random whole numbers below `n`, the same for the same seed (mulberry32). */
function randomFrom(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** A note's words and where each begins, its text being words each followed by a space. */
function words(text: string): { word: string; at: number }[] {
  const found: { word: string; at: number }[] = [];
  let at = 0;
  for (const word of text.split(" ")) {
    if (word !== "") found.push({ word, at });
    at += word.length + 1;
  }
  return found;
}

/** One person's edits, and what each note should keep of them. */
class Writer {
  /** By note, the words this person wrote and has not taken out. */
  readonly written = new Map<string, Set<string>>();
  /** Every word this person took out, of any note. */
  readonly removed = new Set<string>();
  readonly prefix: string;
  readonly vault: MemoryVault;
  readonly pick: (n: number) => number;
  #count = 0;

  constructor(prefix: string, vault: MemoryVault, pick: (n: number) => number) {
    this.prefix = prefix;
    this.vault = vault;
    this.pick = pick;
  }

  /** One edit: mostly a new word, written in at a boundary; one time in five, a word of their own taken out. */
  edit(note: string): void {
    const present = words(this.vault.text(note) ?? "");
    const mine = this.written.get(note) ?? new Set<string>();
    this.written.set(note, mine);
    const own = present.filter(({ word }) => mine.has(word));
    const out = own[this.pick(own.length)];
    if (out !== undefined && this.pick(5) === 0) {
      this.vault.edit(note, (text) => {
        text.delete(out.at, out.word.length + 1);
      });
      mine.delete(out.word);
      this.removed.add(out.word);
      return;
    }
    this.#count += 1;
    const word = `${this.prefix}${String(this.#count)}`;
    // Between words only, so a word is never split by another's.
    const boundaries = [0, ...present.map(({ word: before, at }) => at + before.length + 1)];
    const at = boundaries[this.pick(boundaries.length)] ?? 0;
    this.vault.edit(note, (text) => {
      text.insert(at, `${word} `);
    });
    mine.add(word);
  }
}

function documentOf(vault: MemoryVault, id: string): Y.Doc {
  const note = vault.notes.get(id);
  if (note === undefined) throw new Error(`No note ${id}`);
  return note.document;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ada invites Grace into her workspace as a member, and Grace makes her account. */
async function invite(served: { url: string; token: string; workspaceId: string }) {
  const made = await fetch(`${served.url}/api/workspaces/${served.workspaceId}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${served.token}` },
    body: JSON.stringify({ role: "member", email: "grace@example.org" }),
  });
  const { token } = (await made.json()) as { token: string };
  const accepted = await fetch(`${served.url}/api/invitations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "Grace", email: "grace@example.org", password }),
  });
  if (!accepted.ok) throw new Error(`Grace could not join: ${await accepted.text()}`);
  return ((await accepted.json()) as { token: string }).token;
}

describe("the Phase 3 gate", () => {
  it.each(seeds)(
    "two people co-edit online and offline and lose no edit (seed %i)",
    async (seed) => {
      const pick = randomFrom(seed);
      const served = await startServer();
      const graceToken = await invite(served);
      const adaVault = new MemoryVault();
      const plan = adaVault.write("Plan.md", "start ");
      const notes = adaVault.write("Notes.md", "notes ");
      let ada = await device(served, served.token, adaVault);
      let grace = await device(served, graceToken);
      const writers = [new Writer("a", ada.vault, pick), new Writer("g", grace.vault, pick)];
      const [adaWrites, graceWrites] = writers as [Writer, Writer];
      const first = { [plan]: ["start"], [notes]: ["notes"] };

      /** Waits for both vaults to agree, then checks every note keeps what it should. */
      const settled = async (ids: readonly string[]) => {
        const expected = (id: string) =>
          [
            ...(first[id] ?? []),
            ...writers.flatMap((writer) => [...(writer.written.get(id) ?? [])]),
          ].sort();
        const agree = () =>
          ids.every((id) => {
            const text = ada.vault.text(id);
            return (
              text !== undefined &&
              text === grace.vault.text(id) &&
              JSON.stringify(
                words(text)
                  .map(({ word }) => word)
                  .sort(),
              ) === JSON.stringify(expected(id))
            );
          });
        const deadline = Date.now() + 60_000;
        while (!agree() && Date.now() < deadline) await pause(100);
        for (const id of ids) {
          const kept = words(ada.vault.text(id) ?? "").map(({ word }) => word);
          expect(grace.vault.text(id)).toBe(ada.vault.text(id));
          expect([...kept].sort()).toEqual(expected(id));
          for (const writer of writers) {
            expect(kept.filter((word) => writer.removed.has(word))).toEqual([]);
          }
        }
        expect(grace.vault.paths()).toEqual(ada.vault.paths());
      };

      // Online: both have the plan open and type into it at once.
      await settled([plan, notes]);
      let adaLive = ada.engine.live(plan, documentOf(ada.vault, plan), {
        name: "Ada",
        color: "#1d5c94",
      });
      let graceLive = grace.engine.live(plan, documentOf(grace.vault, plan), {
        name: "Grace",
        color: "#2f6b1f",
      });
      for (let step = 0; step < 80; step++) {
        (pick(2) === 0 ? adaWrites : graceWrites).edit(plan);
        if (pick(4) === 0) await pause(pick(40));
      }
      await settled([plan]);
      adaLive.stop();
      graceLive.stop();

      // Offline: both lose the server, edit both notes, and each makes one.
      await ada.engine.stop();
      await grace.engine.stop();
      for (let step = 0; step < 60; step++) {
        (pick(2) === 0 ? adaWrites : graceWrites).edit(pick(2) === 0 ? plan : notes);
      }
      const adaNew = ada.vault.write("Ada offline.md", "made by Ada ");
      const graceNew = grace.vault.write("Grace offline.md", "made by Grace ");
      first[adaNew] = ["made", "by", "Ada"];
      first[graceNew] = ["made", "by", "Grace"];
      // Back, as when each app starts again with what it kept.
      ada = await device(served, served.token, ada.vault, ada.store);
      grace = await device(served, graceToken, grace.vault, grace.store);
      await settled([plan, notes, adaNew, graceNew]);

      // One live, one offline: Ada types into the open plan while Grace,
      // offline, edits it too.
      await grace.engine.stop();
      adaLive = ada.engine.live(plan, documentOf(ada.vault, plan), {
        name: "Ada",
        color: "#1d5c94",
      });
      for (let step = 0; step < 60; step++) {
        (pick(2) === 0 ? adaWrites : graceWrites).edit(plan);
        if (pick(4) === 0) await pause(pick(40));
      }
      grace = await device(served, graceToken, grace.vault, grace.store);
      graceLive = grace.engine.live(plan, documentOf(grace.vault, plan), {
        name: "Grace",
        color: "#2f6b1f",
      });
      await settled([plan, notes, adaNew, graceNew]);
      adaLive.stop();
      graceLive.stop();
    },
    240_000,
  );
});

// Asking your notes (ADR 0075): which notes and passages a question is
// asked from. The vault's own search finds notes by the question's words,
// one search a word, fused by their ranks, so a note with more of them comes
// first; search by meaning, when it is on for the vault (ADR 0074), adds its
// own ranking. The vault holds only what this person can open, so nothing
// else is found. Each note found is read as the editor holds it, cut into
// passages under its headings, each opening at its first block; the best of
// them go with the question, within a limit of passages and characters.
// And a conversation written as a note, its citations links that Obsidian
// reads too.
import { cleanReply, readAnswer } from "@nether/ai";
import { type ContentBlock, type NoteId, newBlockId } from "@nether/core";
import { documentBlocks } from "@nether/editor";
import { plainText } from "@nether/graph";
import { wikiLinkText } from "@nether/markdown";
import { type SearchQuery, foldText } from "@nether/search";
import type { Vault } from "@nether/storage";
import { t } from "./messages.ts";
import type { NotePart } from "./noteLinks.ts";
import { noteDocuments, whenLoaded } from "./noteDocuments.ts";

/** How much goes with a question: notes read, passages a note, passages, and characters. */
export const askLimits = {
  notes: 6,
  perNote: 2,
  passages: 8,
  length: 700,
  total: 6000,
} as const;

/** A passage of a note, as it goes with a question and as its citation opens it. */
export interface Passage {
  readonly note: NoteId;
  readonly title: string;
  /** The heading it is under, if any. */
  readonly heading: string | undefined;
  /** Where its citation opens the note: its first block. */
  readonly part: NotePart;
  readonly text: string;
}

/** A note search by meaning found, with its closest passage's heading, when it has one. */
export interface MeaningHit {
  readonly note: NoteId;
  readonly heading?: string | undefined;
}

/**
 * Notes found by meaning, the closest first, for when search by meaning is
 * on for the vault (ADR 0074); asking works by words alone without it.
 */
export type MeaningSource = (question: string, limit: number) => Promise<readonly MeaningHit[]>;

/** Words a question has that say nothing of what it is about, in English. */
const common = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in " +
    "into is it its me my no not of on or our should so than that the their them then there " +
    "these they this to was we were what when where which who whom why will with would you your " +
    "about any all also tell say said give list find show please"
  ).split(" "),
);

/** The words a question is searched by: folded, at least two characters, the common ones aside, at most eight. */
export function keywordsOf(question: string): string[] {
  const words = foldText(question)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !common.has(word));
  return [...new Set(words)].slice(0, 8);
}

const byWord = (word: string): SearchQuery => ({
  words: [word],
  phrases: [],
  excluded: [],
  filters: [],
  excludedFilters: [],
});

/** How far down a ranking still counts, as reciprocal rank fusion has it. */
const fusion = 60;

/**
 * The notes a question is asked from, the best first: each word's search
 * ranks notes, and so does search by meaning when it is given; a note gets
 * 1 / (60 + its rank) from each ranking it is in.
 */
export async function findNotes(
  vault: Vault,
  question: string,
  meaning?: MeaningSource,
): Promise<{
  readonly notes: readonly NoteId[];
  readonly meaning: ReadonlyMap<NoteId, MeaningHit>;
}> {
  const scores = new Map<NoteId, number>();
  const rank = (notes: readonly NoteId[]) => {
    for (const [at, note] of notes.entries()) {
      scores.set(note, (scores.get(note) ?? 0) + 1 / (fusion + at + 1));
    }
  };
  for (const word of keywordsOf(question)) {
    rank((await vault.indexes.searchText(byWord(word), 20)).map((hit) => hit.note));
  }
  const close = new Map<NoteId, MeaningHit>();
  if (meaning !== undefined) {
    const hits = await meaning(question, askLimits.notes * 2);
    for (const hit of hits) if (!close.has(hit.note)) close.set(hit.note, hit);
    rank(hits.map((hit) => hit.note));
  }
  const notes = [...scores.entries()]
    .filter(([note]) => vault.note(note) !== undefined)
    .sort((a, b) => b[1] - a[1])
    .slice(0, askLimits.notes)
    .map(([note]) => note);
  return { notes, meaning: close };
}

/** A block's text, as the index reads it. */
function textOf(block: ContentBlock): string {
  return plainText([block]).trim();
}

/**
 * A note cut into passages: blocks gathered under each heading, the heading
 * first, up to the length a passage takes, each opening at its first block.
 */
export function passagesOf(
  note: NoteId,
  title: string,
  blocks: readonly ContentBlock[],
): Passage[] {
  const passages: Passage[] = [];
  let heading: string | undefined;
  let open: { block: string; lines: string[]; length: number } | undefined;
  const close = () => {
    if (open !== undefined && open.length > 0) {
      const text = open.lines.join("\n");
      passages.push({
        note,
        title,
        heading,
        part: { block: open.block },
        text: text.length > askLimits.length ? `${text.slice(0, askLimits.length)}…` : text,
      });
    }
    open = undefined;
  };
  for (const block of blocks) {
    const text = textOf(block);
    if (block.type === "heading") {
      close();
      heading = text === "" ? heading : text;
    }
    if (text === "") continue;
    if (open !== undefined && open.length + text.length + 1 > askLimits.length) close();
    open ??= { block: block.id, lines: [], length: 0 };
    open.lines.push(text);
    open.length += text.length + 1;
  }
  close();
  return passages;
}

/** How many of the question's words a passage has, its note's title counted with it. */
export function scorePassage(passage: Passage, words: readonly string[]): number {
  const text = foldText(`${passage.title}\n${passage.heading ?? ""}\n${passage.text}`);
  return words.filter((word) => text.includes(word)).length;
}

/**
 * The passages a question goes with: for each note found, in order, its
 * best passages, until the limits; a note found with none of the words in
 * any passage, as by its title or its meaning, gives its first, or the one
 * under the heading search by meaning named.
 */
export function choosePassages(
  found: readonly (readonly Passage[])[],
  question: string,
  meaning: ReadonlyMap<NoteId, MeaningHit> = new Map(),
): Passage[] {
  const words = keywordsOf(question);
  const chosen: Passage[] = [];
  let length = 0;
  for (const passages of found) {
    const first = passages[0];
    if (first === undefined) continue;
    const near = meaning.get(first.note)?.heading;
    const scored = passages
      .map((passage, order) => ({
        passage,
        order,
        score:
          scorePassage(passage, words) + (near !== undefined && passage.heading === near ? 2 : 0),
      }))
      .filter((each) => each.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, askLimits.perNote)
      // In the note's order, as it reads.
      .sort((a, b) => a.order - b.order)
      .map((each) => each.passage);
    for (const passage of scored.length === 0 ? [first] : scored) {
      if (chosen.length >= askLimits.passages) return chosen;
      if (length + passage.text.length > askLimits.total) return chosen;
      chosen.push(passage);
      length += passage.text.length;
    }
  }
  return chosen;
}

/** A note's blocks, as the editor holds them, so a passage's block opens in it. */
async function blocksOf(vault: Vault, note: NoteId): Promise<readonly ContentBlock[]> {
  const hold = noteDocuments(vault).open(note);
  try {
    await whenLoaded(hold.note);
    const { state } = hold.note.snapshot;
    return state.status === "ready" ? documentBlocks(state.document, newBlockId) : [];
  } finally {
    hold.release();
  }
}

/** The passages a question is asked from: notes found, read, and their best passages chosen. */
export async function retrieve(
  vault: Vault,
  question: string,
  meaning?: MeaningSource,
): Promise<Passage[]> {
  const found = await findNotes(vault, question, meaning);
  const read: Passage[][] = [];
  for (const note of found.notes) {
    const entry = vault.note(note);
    if (entry === undefined) continue;
    read.push(passagesOf(note, entry.title, await blocksOf(vault, note)));
  }
  return choosePassages(read, question, found.meaning);
}

/** A question asked, its answer, and the passages it went with. */
export interface AskedTurn {
  readonly question: string;
  readonly answer: string;
  readonly passages: readonly Passage[];
  /** `done`; `stopped` by the user; `failed`, with why; or `empty`, when no note was found and nothing sent. */
  readonly status: "done" | "stopped" | "failed" | "empty";
  readonly error?: string;
}

/** The passage a note named in an answer is, when it is among those sent. */
export function namedPassage(passages: readonly Passage[], name: string): Passage | undefined {
  const wanted = name.toLowerCase();
  return passages.find((passage) => passage.title.toLowerCase() === wanted);
}

/** A conversation as a note: each question a section, its citations links to the passages, as Obsidian reads them. */
export function conversationNote(
  turns: readonly AskedTurn[],
  noteTitle: (note: NoteId) => string | undefined,
): string {
  const link = (passage: Passage, alias?: string) =>
    `[[${wikiLinkText(
      passage.heading === undefined || passage.heading === passage.title
        ? { note: passage.note }
        : { note: passage.note, heading: passage.heading },
      alias,
      noteTitle,
    )}]]`;
  const sections = turns
    .filter((turn) => turn.status === "done" || turn.status === "stopped")
    .map((turn) => {
      const answer = readAnswer(cleanReply(turn.answer))
        .map((part) => {
          if (part.kind === "text") return part.text;
          const passage =
            part.kind === "cite"
              ? turn.passages[part.passage - 1]
              : namedPassage(turn.passages, part.name);
          if (passage === undefined) {
            return part.kind === "cite" ? `[${String(part.passage)}]` : part.name;
          }
          return part.kind === "cite" ? link(passage, String(part.passage)) : link(passage);
        })
        .join("");
      const sources = turn.passages
        .map((passage, index) => `${String(index + 1)}. ${link(passage)}`)
        .join("\n");
      return `## ${turn.question}\n\n${answer}\n\n### ${t("askSourcesHeading")}\n\n${sources}\n`;
    });
  return sections.join("\n");
}

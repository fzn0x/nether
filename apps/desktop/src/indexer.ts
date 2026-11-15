// Keeps a vault's link index and search current. What it read of each
// note is kept in the vault's index with the size and modification time
// of the note's file, so opening a vault reads only the notes that changed
// since; the rest it reads in the background, parsing them in a worker,
// and then each note again whenever its file changes or moves.
import type { JsonValue, NoteId, PropertyEntry } from "@nether/core";
import {
  type GraphEntry,
  type Heading,
  LinkGraph,
  type LinkRef,
  type NoteIndex,
} from "@nether/graph";
import type { NoteEntry, NoteIndexRow, Vault } from "@nether/storage";
import type { IndexRequest, IndexResponse } from "./indexer.worker.ts";

/** How many notes go to the worker at once. */
const batchSize = 100;

/** How many kept index rows load at once, the page drawing between them. */
const pageSize = 2000;

/**
 * A note's index as the graph holds it, without the text around each link,
 * which the vault's index keeps apart: on 50,000 notes that text took most
 * of the memory, and of the time to load. The backlinks shown read theirs.
 */
function lean(index: NoteIndex): NoteIndex {
  return index.links.every((link) => link.context === "")
    ? index
    : { ...index, links: index.links.map((link) => ({ ...link, context: "" })) };
}

/** The one empty list every note's empty lists are: most notes have no aliases or blocks of their own. */
const none: readonly never[] = Object.freeze([]);

/** A note's index with its empty lists the shared one, for the graph to hold. */
function shareEmpty(index: NoteIndex): NoteIndex {
  const lists = index as { -readonly [Part in keyof NoteIndex]: NoteIndex[Part] };
  if (lists.links.length === 0) lists.links = none;
  if (lists.tags.length === 0) lists.tags = none;
  if (lists.aliases.length === 0) lists.aliases = none;
  if (lists.headings.length === 0) lists.headings = none;
  if (lists.blocks.length === 0) lists.blocks = none;
  if (lists.properties.length === 0) lists.properties = none;
  return index;
}

/** One copy of each string, for the notes' indexes to share while they load. */
export type StringPool = Map<string, string>;

function shared(pool: StringPool, text: string): string {
  const kept = pool.get(text);
  if (kept !== undefined) return kept;
  pool.set(text, text);
  return text;
}

function sharedValue(pool: StringPool, value: JsonValue): JsonValue {
  if (typeof value === "string") return shared(pool, value);
  if (Array.isArray(value)) {
    const items = value as JsonValue[];
    for (let at = 0; at < items.length; at++) {
      const item = items[at];
      if (typeof item === "string") items[at] = shared(pool, item);
    }
  }
  return value;
}

type Writable<T> = { -readonly [Part in keyof T]: T[Part] };

/**
 * A note's index with its link targets, tags, aliases, headings and
 * properties the pool's copies of them. Each row's JSON gave each its own
 * copy, and they repeat across a vault: on 50,000 notes the copies took
 * 11 MB of the 53 MB their indexes hold, and sharing them takes about
 * 90 ms of the load. A pool lasts one load, so it keeps nothing after.
 */
export function shareStrings(index: NoteIndex, pool: StringPool): NoteIndex {
  for (const link of index.links as Writable<LinkRef>[]) {
    link.target = shared(pool, link.target);
    if (link.heading !== undefined) link.heading = shared(pool, link.heading);
  }
  for (const list of [index.tags, index.aliases] as string[][]) {
    for (const [at, text] of list.entries()) list[at] = shared(pool, text);
  }
  for (const heading of index.headings as Writable<Heading>[]) {
    heading.text = shared(pool, heading.text);
  }
  for (const property of index.properties as Writable<PropertyEntry>[]) {
    property.key = shared(pool, property.key);
    property.value = sharedValue(pool, property.value);
  }
  return index;
}

/** A note's index as its row keeps it: what the graph holds, and apart, the text around each link. */
function indexRow(index: NoteIndex): Pick<NoteIndexRow, "data" | "detail"> {
  return {
    data: JSON.stringify(lean(index)),
    detail: JSON.stringify(index.links.map((link) => link.context)),
  };
}

/** A note's whole index from its row, the text around each link from its detail. */
export function readIndexRow(row: Pick<NoteIndexRow, "data" | "detail">): NoteIndex {
  const index = JSON.parse(row.data) as NoteIndex;
  // A row from before the text was kept apart has it in its data.
  if (row.detail === "") return index;
  const contexts = JSON.parse(row.detail) as unknown;
  if (!Array.isArray(contexts)) return index;
  return {
    ...index,
    links: index.links.map((link, at) => {
      const context: unknown = contexts[at];
      return { ...link, context: typeof context === "string" ? context : "" };
    }),
  };
}

export interface IndexProgress {
  /** Notes read since the index last started reading, and how many it had to read. */
  readonly done: number;
  readonly total: number;
}

interface Known {
  readonly path: string;
  readonly size: number;
  readonly modified: number;
}

export class Indexer {
  readonly graph = new LinkGraph();
  readonly #vault: Vault;
  readonly #worker: Worker;
  readonly #known = new Map<NoteId, Known>();
  readonly #queue = new Set<NoteId>();
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<number, (response: IndexResponse) => void>();
  #batches = 0;
  #progress: IndexProgress = { done: 0, total: 0 };
  #running = false;
  #stopped = false;
  /** Why the worker failed, if it did: no note is read after. */
  #error: string | undefined;
  /** Whether the rows the vault's index kept are still loading. */
  #loading = true;
  #unsubscribe: (() => void) | undefined;

  constructor(vault: Vault, worker: Worker) {
    this.#vault = vault;
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<IndexResponse>) => {
      this.#pending.get(event.data.batch)?.(event.data);
      this.#pending.delete(event.data.batch);
    };
    // A worker that cannot load answers nothing; say so rather than wait.
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.#error = event.message === "" ? "The worker stopped." : event.message;
      for (const listener of this.#listeners) listener();
    };
  }

  /**
   * Loads what the vault's index kept, a part at a time while the vault
   * shows, then reads what changed, and follows the vault.
   */
  async start(): Promise<void> {
    const total = this.#vault.notes().length;
    const loaded: GraphEntry[] = [];
    const pool: StringPool = new Map();
    let rowsRead = 0;
    for (let after = ""; !this.#stopped;) {
      this.#emit({ done: rowsRead, total });
      const rows = await this.#vault.indexes.noteIndexPage(after, pageSize);
      const split: NoteIndexRow[] = [];
      for (const row of rows) {
        const note = this.#vault.note(row.note);
        // A row that cannot be read is read again from the note.
        if (note === undefined || row.data === null) continue;
        try {
          const index = row.data as NoteIndex;
          const kept = lean(index);
          // A row from before the text around links was kept apart, split once.
          if (kept !== index) {
            const { size, modified } = row;
            split.push({ note: row.note, size, modified, ...indexRow(index) });
          }
          loaded.push({
            id: row.note,
            path: note.path,
            index: shareEmpty(shareStrings(kept, pool)),
          });
          this.#known.set(row.note, { path: note.path, size: row.size, modified: row.modified });
        } catch {
          // A row that cannot be read is read again from the note.
        }
      }
      if (split.length > 0) await this.#vault.indexes.putNoteIndexes(split);
      rowsRead += rows.length;
      const last = rows[rows.length - 1];
      if (last === undefined || rows.length < pageSize) break;
      after = last.note;
      // The page draws, and takes input, between parts.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    pool.clear();
    // The graph takes them all as one change, not one a part.
    this.graph.setMany(loaded);
    this.#loading = false;
    this.#emit({ done: 0, total: 0 });
    if (this.#stopped) return;
    this.#unsubscribe = this.#vault.subscribe((changed) => {
      this.#sync(changed);
    });
    this.#sync();
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#worker.terminate();
  }

  /** Waits until every note the vault has is read, as a rename does before it rewrites links. */
  idle(): Promise<void> {
    const done = () => !this.#loading && !this.#running && this.#queue.size === 0;
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        if (!done()) return;
        stop();
        resolve();
      });
    });
  }

  progress(): IndexProgress {
    return this.#progress;
  }

  /** Why links cannot be read, if they cannot. */
  error(): string | undefined {
    return this.#error;
  }

  /** Calls `listener` when the progress changes; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(progress: IndexProgress): void {
    this.#progress = progress;
    for (const listener of this.#listeners) listener();
  }

  /**
   * Finds the notes that are new, changed, moved or gone since the index
   * last saw them: among the notes a change of the vault names, or else
   * among them all, as when the index starts. Looking at all 50,000 on
   * every save took more of the main thread than the save.
   */
  #sync(changed?: readonly NoteId[]): void {
    if (this.#stopped) return;
    const check = (note: NoteEntry) => {
      const known = this.#known.get(note.id);
      // Changed or moved: a move changes the title, which search reads.
      if (
        known?.size !== note.size ||
        known.modified !== note.modified ||
        known.path !== note.path
      ) {
        this.#queue.add(note.id);
      }
    };
    let gone: NoteId[];
    if (changed === undefined) {
      const present = new Set<NoteId>();
      for (const note of this.#vault.notes()) {
        present.add(note.id);
        check(note);
      }
      gone = [...this.#known.keys()].filter((id) => !present.has(id));
    } else {
      gone = [];
      for (const id of changed) {
        const note = this.#vault.note(id);
        if (note !== undefined) check(note);
        else if (this.#known.has(id)) gone.push(id);
      }
    }
    for (const id of gone) {
      this.#known.delete(id);
      this.graph.remove(id);
    }
    if (gone.length > 0) {
      void this.#vault.indexes.deleteNoteIndexes(gone);
      void this.#vault.indexes.deleteNoteTexts(gone);
    }
    if (this.#queue.size > 0 && !this.#running) void this.#read();
  }

  async #read(): Promise<void> {
    this.#running = true;
    let done = 0;
    // One pool for the whole run, as a new vault's first reading is one.
    const pool: StringPool = new Map();
    try {
      while (this.#queue.size > 0 && !this.#stopped) {
        this.#emit({ done, total: done + this.#queue.size });
        const ids = [...this.#queue].slice(0, batchSize);
        for (const id of ids) this.#queue.delete(id);
        const notes: { id: string; text: string }[] = [];
        const seen = new Map<string, Known>();
        await this.#vault.readNotes(ids, (id, file) => {
          if (file.missing === true) return;
          const note = this.#vault.note(id);
          if (note === undefined) return;
          notes.push({ id, text: file.binary === true ? "" : file.text });
          // As the vault knows the note, so the next look finds it unchanged.
          seen.set(id, { path: note.path, size: note.size, modified: note.modified });
        });
        const response = await this.#parse(notes);
        const read: GraphEntry[] = [];
        const rows = response.results.flatMap(({ id, index }) => {
          const known = seen.get(id);
          if (known === undefined) return [];
          const note = id as NoteId;
          read.push({
            id: note,
            path: known.path,
            index: shareEmpty(shareStrings(lean(index), pool)),
          });
          this.#known.set(note, known);
          return [{ note, size: known.size, modified: known.modified, ...indexRow(index) }];
        });
        const texts = response.results.flatMap(({ id, text }) => {
          const known = seen.get(id);
          const title = known?.path.slice(known.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
          return title === undefined ? [] : [{ note: id as NoteId, title, body: text }];
        });
        // The text first: a note whose index row is kept is not read again.
        await this.#vault.indexes.putNoteTexts(texts);
        await this.#vault.indexes.putNoteIndexes(rows);
        // Then the graph, whose backlinks read the text around their links from the rows.
        this.graph.setMany(read);
        done += ids.length;
      }
    } finally {
      this.#running = false;
      this.#emit({ done, total: done });
    }
  }

  #parse(notes: IndexRequest["notes"]): Promise<IndexResponse> {
    const batch = ++this.#batches;
    return new Promise((resolve) => {
      this.#pending.set(batch, resolve);
      this.#worker.postMessage({ batch, notes } satisfies IndexRequest);
    });
  }
}

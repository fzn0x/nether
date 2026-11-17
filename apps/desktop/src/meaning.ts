// Search by meaning (ADR 0074): the vault's notes embedded as passages by a
// provider's embedding model, kept in the vault's index a byte a number, and
// searched by their signs first, then by the cosine of the closest. Off
// until it is turned on for the vault, on this device; the choice, and the
// model the kept passages came from, are kept in the vault's index outside
// its folder, so neither syncs. Nothing of it is in memory until a search
// runs, and the signs a search read are let go two minutes after the last.
import type { NoteId } from "@nether/core";
import {
  type Passage,
  SignIndex,
  packVector,
  packedCosine,
  passagesOf,
  signsOf,
  unitVector,
} from "@nether/search";
import type { MeaningFile, MeaningPassage, NoteEntry, StoredPassage, Vault } from "@nether/storage";

/** The provider and model a vault's notes are embedded with, when search by meaning is on. */
export interface MeaningChoice {
  /** The ID of one of this device's providers. */
  readonly provider: string;
  /** The embedding model, as the provider names it. */
  readonly model: string;
}

/** What the vault's kept passages were embedded with, and their vectors' length once known. */
interface MeaningRecord extends MeaningChoice {
  readonly dimensions: number | undefined;
}

/** Sends texts to the provider's embedding model: one vector each, in their order. */
export type Embed = (inputs: readonly string[], signal: AbortSignal) => Promise<number[][]>;

const choiceKey = "ai.meaning";
const recordKey = "ai.meaning.index";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function choiceOf(value: unknown): MeaningChoice | undefined {
  const kept = value as Partial<MeaningChoice> | undefined;
  return typeof kept?.provider === "string" &&
    kept.provider !== "" &&
    typeof kept.model === "string" &&
    kept.model !== ""
    ? { provider: kept.provider, model: kept.model }
    : undefined;
}

/** The vault's search by meaning, on this device: its provider and model, or none while it is off. */
export async function meaningChoice(vault: Vault): Promise<MeaningChoice | undefined> {
  return choiceOf(readJson(await vault.settings.setting(choiceKey)));
}

/**
 * Turns search by meaning on with a provider and model, or off. Another
 * provider or model than the kept passages came from forgets them, so the
 * vault is embedded again; turning it off keeps them, for turning it on again.
 */
export async function setMeaningChoice(
  vault: Vault,
  choice: MeaningChoice | undefined,
): Promise<void> {
  await vault.settings.setSetting(
    choiceKey,
    choice === undefined ? undefined : encoder.encode(JSON.stringify(choice)),
  );
  if (choice === undefined) return;
  const record = await meaningRecord(vault);
  if (record?.provider === choice.provider && record.model === choice.model) return;
  await vault.meaning.clearPassages();
  await keepRecord(vault, { ...choice, dimensions: undefined });
}

async function meaningRecord(vault: Vault): Promise<MeaningRecord | undefined> {
  const value = readJson(await vault.settings.setting(recordKey));
  const choice = choiceOf(value);
  if (choice === undefined) return undefined;
  const dimensions = (value as { dimensions?: unknown }).dimensions;
  return {
    ...choice,
    dimensions: typeof dimensions === "number" && dimensions > 0 ? dimensions : undefined,
  };
}

async function keepRecord(vault: Vault, record: MeaningRecord): Promise<void> {
  await vault.settings.setSetting(recordKey, encoder.encode(JSON.stringify(record)));
}

/** How far the vault's embedding has come, and the provider's last error while it waits. */
export interface MeaningProgress {
  /** The notes read so far in this pass, of those it has to read. */
  readonly done: number;
  readonly total: number;
  /** Whether a pass is going on now. */
  readonly running: boolean;
  /** Why the provider refused the last request, until one succeeds. */
  readonly error: string | undefined;
}

export interface MeaningIndexerOptions {
  /** How many passages go in one request. */
  readonly batch?: number;
  /** How long after an error it tries again. */
  readonly retryAfter?: number;
  /** How long after a change to the vault it looks at the notes again. */
  readonly settle?: number;
}

/** A passage's bytes as signed numbers, without copying them. */
function signed(bytes: Uint8Array): Int8Array {
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A packed vector as the index keeps it. */
function kept(passage: Passage, vector: readonly number[]): MeaningPassage {
  const packed = packVector(vector);
  return {
    ordinal: passage.ordinal,
    heading: passage.headings.join(" > "),
    hash: passage.hash,
    preview: passage.preview,
    scale: packed.scale,
    vector: new Uint8Array(packed.bytes.buffer, packed.bytes.byteOffset, packed.bytes.byteLength),
    signs: packed.signs,
  };
}

/** What a note waits with until its batch is embedded. */
interface Waiting {
  readonly note: NoteEntry;
  readonly passages: readonly Passage[];
  /** Its passages already kept, by the hash of their text. */
  readonly known: ReadonlyMap<string, StoredPassage>;
}

/**
 * Embeds a vault's notes in the background while search by meaning is on:
 * each note whose file changed since its passages were made is read again,
 * and only its passages whose text changed are sent, a batch at a time,
 * one request at a time. Deleted notes lose their passages.
 */
export class MeaningIndexer {
  readonly #vault: Vault;
  readonly #choice: MeaningChoice;
  readonly #embed: Embed;
  readonly #batch: number;
  readonly #retryAfter: number;
  readonly #settle: number;
  readonly #abort = new AbortController();
  readonly #listeners = new Set<(progress: MeaningProgress) => void>();
  readonly #stored = new Set<() => void>();
  #files: Map<NoteId, MeaningFile> | undefined;
  #dimensions: number | undefined;
  #progress: MeaningProgress = { done: 0, total: 0, running: false, error: undefined };
  #running = false;
  #again = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(
    vault: Vault,
    choice: MeaningChoice,
    embed: Embed,
    options: MeaningIndexerOptions = {},
  ) {
    this.#vault = vault;
    this.#choice = choice;
    this.#embed = embed;
    this.#batch = options.batch ?? 64;
    this.#retryAfter = options.retryAfter ?? 60_000;
    this.#settle = options.settle ?? 2000;
  }

  get progress(): MeaningProgress {
    return this.#progress;
  }

  /** Calls `listener` as the progress changes; gives the way to stop. */
  subscribe(listener: (progress: MeaningProgress) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Calls `listener` whenever passages are kept or forgotten, for a search to read them again. */
  onStored(listener: () => void): () => void {
    this.#stored.add(listener);
    return () => this.#stored.delete(listener);
  }

  /** Starts a pass now, and another after each change to the vault's notes. */
  start(): Promise<void> {
    this.#unsubscribe ??= this.#vault.subscribe(() => {
      if (this.#stopped) return;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => void this.#run(), this.#settle);
    });
    return this.#run();
  }

  /** Stops, mid-pass if need be: what was kept stays, and the next start goes on from there. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#unsubscribe?.();
    this.#abort.abort();
  }

  /** Whether it was stopped; read anew after each wait. */
  #ended(): boolean {
    return this.#stopped;
  }

  /** Whether the vault changed during the pass; read anew after it. */
  #wanted(): boolean {
    return this.#again;
  }

  #emit(change: Partial<MeaningProgress>): void {
    this.#progress = { ...this.#progress, ...change };
    for (const listener of this.#listeners) listener(this.#progress);
  }

  #changed(): void {
    for (const listener of this.#stored) listener();
  }

  async #run(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    this.#emit({ running: true });
    try {
      do {
        this.#again = false;
        await this.#pass();
      } while (this.#wanted() && !this.#ended());
    } catch (error) {
      // Stopped mid-request, what was kept stays; any other failure shows, and the next change tries again.
      if (!this.#stopped)
        this.#emit({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#running = false;
      this.#emit({ running: false });
    }
  }

  async #pass(): Promise<void> {
    const vault = this.#vault;
    if (this.#files === undefined) {
      const record = await meaningRecord(vault);
      this.#dimensions = record?.dimensions;
      this.#files = new Map((await vault.meaning.meaningFiles()).map((file) => [file.note, file]));
    }
    const files = this.#files;
    const notes = vault.notes();
    const present = new Set(notes.map((note) => note.id));
    const gone = [...files.keys()].filter((note) => !present.has(note));
    if (gone.length > 0) {
      await vault.meaning.deletePassages(gone);
      for (const note of gone) files.delete(note);
      this.#changed();
    }
    const changed = notes.filter((note) => {
      const file = files.get(note.id);
      return file?.size !== note.size || file.modified !== note.modified;
    });
    let done = 0;
    this.#emit({ done, total: changed.length });
    const waiting: Waiting[] = [];
    let inputs = 0;
    for (let start = 0; start < changed.length && !this.#stopped; start += this.#batch) {
      const part = changed.slice(start, start + this.#batch);
      const texts = new Map<NoteId, string>();
      await vault.readNotes(
        part.map((note) => note.id),
        (id, file) => {
          if (file.missing !== true) texts.set(id, file.binary === true ? "" : file.text);
        },
      );
      for (const note of part) {
        const text = texts.get(note.id);
        // A note gone meanwhile is left to the next pass.
        if (text === undefined) continue;
        const passages = passagesOf(note.title, text);
        const known = new Map(
          (await vault.meaning.notePassages(note.id)).map((passage) => [passage.hash, passage]),
        );
        waiting.push({ note, passages, known });
        inputs += passages.filter((passage) => !known.has(passage.hash)).length;
        if (inputs >= this.#batch) {
          done += await this.#flush(waiting);
          inputs = 0;
          this.#emit({ done });
        }
      }
    }
    done += await this.#flush(waiting);
    this.#emit({ done });
  }

  /** Embeds what the waiting notes need, keeps their passages, and gives how many notes it kept. */
  async #flush(waiting: Waiting[]): Promise<number> {
    if (waiting.length === 0 || this.#stopped) return 0;
    const inputs = waiting.flatMap(({ passages, known }) =>
      passages.filter((passage) => !known.has(passage.hash)).map((passage) => passage.input),
    );
    const vectors = inputs.length === 0 ? [] : await this.#embedPatiently(inputs);
    if (this.#ended()) return 0;
    let next = 0;
    const files = this.#files ?? new Map<NoteId, MeaningFile>();
    for (const { note, passages, known } of waiting) {
      const rows = passages.map((passage) => {
        const same = known.get(passage.hash);
        if (same !== undefined) return { ...same, ordinal: passage.ordinal };
        return kept(passage, vectors[next++] ?? []);
      });
      const file = { note: note.id, size: note.size, modified: note.modified };
      await this.#vault.meaning.putPassages(file, rows);
      files.set(note.id, file);
    }
    const count = waiting.length;
    waiting.length = 0;
    this.#changed();
    return count;
  }

  /** The provider's vectors for these texts, asked again a while after each error, until stopped. */
  async #embedPatiently(inputs: readonly string[]): Promise<number[][]> {
    for (;;) {
      try {
        const vectors = await this.#embed(inputs, this.#abort.signal);
        if (vectors.length !== inputs.length) {
          throw new Error("The provider sent a different number of vectors.");
        }
        await this.#checkLength(vectors);
        this.#emit({ error: undefined });
        return vectors;
      } catch (error) {
        if (this.#stopped) throw error;
        this.#emit({ error: error instanceof Error ? error.message : String(error) });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#retryAfter);
          this.#abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (this.#ended()) throw new Error("Stopped.", { cause: error });
      }
    }
  }

  /** Keeps the length of the model's vectors, the first time, and refuses any of another. */
  async #checkLength(vectors: readonly (readonly number[])[]): Promise<void> {
    for (const vector of vectors) {
      if (vector.length === 0) throw new Error("The provider sent an empty vector.");
      if (this.#dimensions === undefined) {
        this.#dimensions = vector.length;
        await keepRecord(this.#vault, { ...this.#choice, dimensions: vector.length });
      } else if (vector.length !== this.#dimensions) {
        throw new Error(
          `The model's vectors were ${String(this.#dimensions)} numbers long and are now ${String(vector.length)}: choose it again to embed the vault anew.`,
        );
      }
    }
  }
}

/** A note found by meaning: its closest passage, and how close. */
export interface MeaningHit {
  readonly note: NoteEntry;
  /** The headings its passage is under, joined by " > ". */
  readonly heading: string;
  readonly preview: string;
  /** The cosine of the passage's vector with the query's. */
  readonly score: number;
}

/** How many passages' vectors a search reads, of those whose signs are closest. */
const candidates = 200;

/** How many signs a read of the index takes at once. */
const signsPage = 5000;

/**
 * Searches a vault's passages by meaning. It reads every passage's signs
 * for its first search, holds them while searches follow each other, and
 * lets them go a while after the last, or when the passages change.
 */
export class MeaningSearch {
  readonly #vault: Vault;
  readonly #hold: number;
  #signs: Promise<SignIndex> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(vault: Vault, hold = 120_000) {
    this.#vault = vault;
    this.#hold = hold;
  }

  /** Lets the held signs go, as when passages are kept or forgotten. */
  forget(): void {
    clearTimeout(this.#timer);
    this.#signs = undefined;
  }

  /** Whether the signs are in memory now. */
  get holding(): boolean {
    return this.#signs !== undefined;
  }

  #read(dimensions: number): Promise<SignIndex> {
    const held = this.#signs;
    const reading =
      held ??
      (async () => {
        const index = new SignIndex(dimensions);
        let after = 0;
        for (;;) {
          const page = await this.#vault.meaning.passageSigns(after, signsPage);
          for (const { id, signs } of page) index.add(id, signs);
          const last = page.at(-1);
          if (last === undefined || page.length < signsPage) return index;
          after = last.id;
        }
      })();
    this.#signs = reading;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#signs = undefined;
    }, this.#hold);
    return reading;
  }

  /** The notes whose passages are closest in meaning to a query's vector, the closest first. */
  async search(query: readonly number[], limit = 50): Promise<MeaningHit[]> {
    const unit = unitVector(query);
    let index = await this.#read(unit.length);
    // Signs of another length were read for another model's vectors.
    if (index.dimensions !== unit.length) {
      this.forget();
      index = await this.#read(unit.length);
    }
    const ids = index.closest(signsOf(unit), candidates);
    const passages = await this.#vault.meaning.passagesById(ids);
    const best = new Map<NoteId, { passage: StoredPassage; score: number }>();
    for (const passage of passages) {
      const score = packedCosine(unit, signed(passage.vector), passage.scale);
      const known = best.get(passage.note);
      if (known === undefined || score > known.score) best.set(passage.note, { passage, score });
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .flatMap(({ passage, score }) => {
        const note = this.#vault.note(passage.note);
        return note === undefined
          ? []
          : [{ note, heading: passage.heading, preview: passage.preview, score }];
      })
      .slice(0, limit);
  }
}

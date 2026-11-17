// The local index of a vault: what each client keeps about the files, so it
// opens a large vault without reading every file again, and each note's
// document, its Yjs updates, kept before an edit counts as saved (ADR 0003).
import type { NoteId } from "@nether/core";
import { type SearchQuery, foldText } from "@nether/search";

/** What the index knows of a file. */
export interface FileRecord {
  /** Relative to the vault, separated by slashes. */
  readonly path: string;
  /** The note's ID, for a Markdown file: it stays the same across renames. */
  readonly note?: NoteId;
  readonly size: number;
  readonly modified: number;
  /** The SHA-256 hash of the bytes last read or written, when known. */
  readonly hash?: string;
}

/** A change to the index, applied at once: removals first, then the rest. */
export interface IndexChange {
  readonly remove?: readonly string[];
  readonly upsert?: readonly FileRecord[];
}

/** One of a note's document updates, numbered in the order it was made. */
export interface StoredUpdate {
  readonly seq: number;
  readonly data: Uint8Array;
}

/** A note's document as the index keeps it. */
export interface StoredDocument {
  /** Its updates, oldest first: a snapshot of the earlier ones may come first. */
  readonly updates: readonly StoredUpdate[];
  /** The hash of the file's bytes the document last wrote or read. */
  readonly fileHash?: string;
}

/**
 * What the link index and search keep of a note, with the size and
 * modification time of the file it was read from, to tell when it is stale.
 */
export interface NoteIndexRow {
  readonly note: NoteId;
  readonly size: number;
  readonly modified: number;
  /** What loads with the vault, as JSON. */
  readonly data: string;
  /** What is read only for the notes that need it, such as the text around each link; "" for none. */
  readonly detail: string;
}

/** An index row as the vault's rows load: its data read, and without its detail. */
export interface NoteIndexData {
  readonly note: NoteId;
  readonly size: number;
  readonly modified: number;
  /** The row's data read from its JSON; null when that cannot be read. */
  readonly data: unknown;
}

/** A version of a note: its text as it was before an edit (ADR 0041). */
export interface NoteVersion {
  readonly id: number;
  readonly note: NoteId;
  /** When the note last had this text, in milliseconds since 1970. */
  readonly time: number;
  /** The text's length, in characters. */
  readonly length: number;
}

/** A JSON text read, or null when it cannot be. */
export function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A note's title and text, as search reads them. */
export interface NoteTextRow {
  readonly note: NoteId;
  readonly title: string;
  readonly body: string;
}

/** A note that matches a search, with the text around a match, each match between \u0002 and \u0003. */
export interface TextHit {
  readonly note: NoteId;
  readonly snippet: string;
}

/** The marks around a match in a snippet. */
export const matchStart = "\u0002";
export const matchEnd = "\u0003";

/**
 * The key a note's comments' document is kept under in the index, beside
 * the note's own (ADR 0044): comments are not Markdown, so they have no file.
 */
export function commentsDocument(note: NoteId): NoteId {
  return `${note}.comments` as NoteId;
}

/** Where a client keeps a vault's index. */
/** The file a note's passages were made from, for search by meaning (ADR 0074). */
export interface MeaningFile {
  readonly note: NoteId;
  readonly size: number;
  readonly modified: number;
}

/** A passage of a note as search by meaning keeps it: where it is, its text's hash, and its vector. */
export interface MeaningPassage {
  /** Its place among the note's passages, from 0. */
  readonly ordinal: number;
  /** The headings it is under, joined by " > "; empty before the note's first. */
  readonly heading: string;
  /** A hash of the text it was embedded from. */
  readonly hash: string;
  /** The start of its text, for a result to show. */
  readonly preview: string;
  /** What each of its vector's bytes is multiplied by. */
  readonly scale: number;
  /** Its vector, a signed byte a number. */
  readonly vector: Uint8Array;
  /** Its vector's signs, a bit a number. */
  readonly signs: Uint8Array;
}

/** A passage as the index keeps it, by an ID of its own. */
export interface StoredPassage extends MeaningPassage {
  readonly id: number;
  readonly note: NoteId;
}

/** A passage's signs, as a search reads every one. */
export interface PassageSigns {
  readonly id: number;
  readonly signs: Uint8Array;
}

export interface IndexStore {
  /** Every file the index knows. */
  files(): Promise<readonly FileRecord[]>;
  apply(change: IndexChange): Promise<void>;
  /** A note's document; no updates for a note never opened. */
  document(note: NoteId): Promise<StoredDocument>;
  /** Adds updates to a note's document, all or none, each numbered after the last. */
  appendUpdates(note: NoteId, updates: readonly Uint8Array[]): Promise<void>;
  /** Replaces the updates numbered up to `through` with one snapshot of them. */
  compact(note: NoteId, snapshot: Uint8Array, through: number): Promise<void>;
  /** Records the hash of the file the document now matches. */
  setFileHash(note: NoteId, hash: string): Promise<void>;
  /**
   * Forgets a note's document, its updates, its file's hash and its
   * versions, as when the note is deleted for good.
   */
  deleteDocument(note: NoteId): Promise<void>;
  /** Keeps a version of a note's text, from a time. */
  addVersion(note: NoteId, time: number, text: string): Promise<void>;
  /** A note's versions, the latest first, without their text. */
  versions(note: NoteId): Promise<readonly NoteVersion[]>;
  /** A version's text; undefined when it is not kept. */
  versionText(id: number): Promise<string | undefined>;
  /** Deletes every note's versions from before a time; returns how many. */
  deleteVersions(before: number): Promise<number>;
  /**
   * A setting this device keeps for the vault, outside its folder, as its
   * link to a server and what sync knows; undefined when there is none.
   */
  setting(key: string): Promise<Uint8Array | undefined>;
  /** Keeps a setting, or forgets it when given undefined. */
  setSetting(key: string, value: Uint8Array | undefined): Promise<void>;
  /** What the link index and search keep of every note read so far. */
  noteIndexes(): Promise<readonly NoteIndexRow[]>;
  /**
   * The index rows of the notes after `after` in the order of their IDs, at
   * most `limit`, so that a large vault's rows load a part at a time, each
   * with its data read and without its detail.
   */
  noteIndexPage(after: string, limit: number): Promise<readonly NoteIndexData[]>;
  /** The index rows of some notes, those it has, with their detail. */
  noteIndexesOf(notes: readonly NoteId[]): Promise<readonly NoteIndexRow[]>;
  /** Keeps notes' index rows, replacing those they had. */
  putNoteIndexes(rows: readonly NoteIndexRow[]): Promise<void>;
  deleteNoteIndexes(notes: readonly NoteId[]): Promise<void>;
  /** Keeps notes' titles and text for search, replacing those they had. */
  putNoteTexts(rows: readonly NoteTextRow[]): Promise<void>;
  deleteNoteTexts(notes: readonly NoteId[]): Promise<void>;
  /**
   * The notes whose title or text has every word and phrase of a query, and
   * none it excludes, the best first, at most `limit`; its filters are the
   * caller's to apply.
   */
  searchText(query: SearchQuery, limit: number): Promise<readonly TextHit[]>;
  /** The files the notes' passages were made from, for search by meaning. */
  meaningFiles(): Promise<readonly MeaningFile[]>;
  /** A note's passages, in order, to keep the vectors of those whose text is the same. */
  notePassages(note: NoteId): Promise<readonly StoredPassage[]>;
  /** Replaces a note's passages, all at once, and records the file they were made from. */
  putPassages(file: MeaningFile, passages: readonly MeaningPassage[]): Promise<void>;
  /** Forgets notes' passages, and the files they were made from. */
  deletePassages(notes: readonly NoteId[]): Promise<void>;
  /** Forgets every passage, as when another model is chosen. */
  clearPassages(): Promise<void>;
  /** The signs of the passages after the ID `after`, in the order of their IDs, at most `limit`. */
  passageSigns(after: number, limit: number): Promise<readonly PassageSigns[]>;
  /** Some passages by their IDs, those it has. */
  passagesById(ids: readonly number[]): Promise<readonly StoredPassage[]>;
  close(): Promise<void>;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a word or phrase stands in folded text as whole words, as FTS5 finds them. */
function wordIn(text: string, part: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(part)}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** The text around the first match of `part`, marked as FTS5's snippet marks it. */
function snippetOf(body: string, part: string): string {
  const folded = foldText(body);
  const at = part === "" ? -1 : folded.indexOf(part);
  if (at === -1) return body.slice(0, 120);
  const start = Math.max(0, at - 40);
  const end = Math.min(body.length, at + part.length + 60);
  return `${start > 0 ? "…" : ""}${body.slice(start, at)}${matchStart}${body.slice(at, at + part.length)}${matchEnd}${body.slice(at + part.length, end)}${end < body.length ? "…" : ""}`;
}

/** An index kept in memory, for the browser preview and for tests. */
export class MemoryStore implements IndexStore {
  readonly #files = new Map<string, FileRecord>();
  readonly #documents = new Map<NoteId, { updates: StoredUpdate[]; fileHash?: string }>();
  readonly #indexes = new Map<NoteId, NoteIndexRow>();
  /** The notes of #indexes in order, until they change. */
  #indexOrder: NoteId[] | undefined;
  readonly #texts = new Map<NoteId, NoteTextRow>();
  readonly #settings = new Map<string, Uint8Array>();
  readonly #versions = new Map<number, NoteVersion & { readonly text: string }>();
  #nextVersion = 1;
  readonly #meaningFiles = new Map<NoteId, MeaningFile>();
  /** Each note's passages, in order. */
  readonly #passages = new Map<NoteId, StoredPassage[]>();
  #nextPassage = 1;

  #document(note: NoteId) {
    let document = this.#documents.get(note);
    if (document === undefined) {
      document = { updates: [] };
      this.#documents.set(note, document);
    }
    return document;
  }

  files(): Promise<readonly FileRecord[]> {
    return Promise.resolve([...this.#files.values()]);
  }

  apply(change: IndexChange): Promise<void> {
    for (const path of change.remove ?? []) this.#files.delete(path);
    for (const record of change.upsert ?? []) this.#files.set(record.path, record);
    return Promise.resolve();
  }

  document(note: NoteId): Promise<StoredDocument> {
    const document = this.#documents.get(note);
    return Promise.resolve({
      updates: [...(document?.updates ?? [])],
      ...(document?.fileHash === undefined ? {} : { fileHash: document.fileHash }),
    });
  }

  appendUpdates(note: NoteId, updates: readonly Uint8Array[]): Promise<void> {
    const document = this.#document(note);
    for (const data of updates) {
      const seq = (document.updates[document.updates.length - 1]?.seq ?? 0) + 1;
      document.updates.push({ seq, data: data.slice() });
    }
    return Promise.resolve();
  }

  compact(note: NoteId, snapshot: Uint8Array, through: number): Promise<void> {
    const document = this.#document(note);
    document.updates = [
      { seq: through, data: snapshot.slice() },
      ...document.updates.filter((update) => update.seq > through),
    ];
    return Promise.resolve();
  }

  deleteDocument(note: NoteId): Promise<void> {
    this.#documents.delete(note);
    for (const [id, version] of this.#versions) {
      if (version.note === note) this.#versions.delete(id);
    }
    return Promise.resolve();
  }

  addVersion(note: NoteId, time: number, text: string): Promise<void> {
    const id = this.#nextVersion++;
    this.#versions.set(id, { id, note, time, length: text.length, text });
    return Promise.resolve();
  }

  versions(note: NoteId): Promise<readonly NoteVersion[]> {
    return Promise.resolve(
      [...this.#versions.values()]
        .filter((version) => version.note === note)
        .sort((a, b) => b.time - a.time || b.id - a.id)
        .map(({ id, time, length }) => ({ id, note, time, length })),
    );
  }

  versionText(id: number): Promise<string | undefined> {
    return Promise.resolve(this.#versions.get(id)?.text);
  }

  deleteVersions(before: number): Promise<number> {
    let count = 0;
    for (const [id, version] of this.#versions) {
      if (version.time >= before) continue;
      this.#versions.delete(id);
      count += 1;
    }
    return Promise.resolve(count);
  }

  setting(key: string): Promise<Uint8Array | undefined> {
    const value = this.#settings.get(key);
    return Promise.resolve(value === undefined ? undefined : value.slice());
  }

  setSetting(key: string, value: Uint8Array | undefined): Promise<void> {
    if (value === undefined) this.#settings.delete(key);
    else this.#settings.set(key, value.slice());
    return Promise.resolve();
  }

  setFileHash(note: NoteId, hash: string): Promise<void> {
    this.#document(note).fileHash = hash;
    return Promise.resolve();
  }

  noteIndexes(): Promise<readonly NoteIndexRow[]> {
    return Promise.resolve([...this.#indexes.values()]);
  }

  noteIndexPage(after: string, limit: number): Promise<readonly NoteIndexData[]> {
    this.#indexOrder ??= [...this.#indexes.keys()].sort();
    const order = this.#indexOrder;
    // The first ID past `after`, by halving.
    let low = 0;
    let high = order.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((order[middle] ?? "") <= after) low = middle + 1;
      else high = middle;
    }
    return Promise.resolve(
      order.slice(low, low + limit).flatMap((note) => {
        const row = this.#indexes.get(note);
        return row === undefined
          ? []
          : [{ note: row.note, size: row.size, modified: row.modified, data: readJson(row.data) }];
      }),
    );
  }

  noteIndexesOf(notes: readonly NoteId[]): Promise<readonly NoteIndexRow[]> {
    return Promise.resolve(notes.flatMap((note) => this.#indexes.get(note) ?? []));
  }

  putNoteIndexes(rows: readonly NoteIndexRow[]): Promise<void> {
    for (const row of rows) {
      if (!this.#indexes.has(row.note)) this.#indexOrder = undefined;
      this.#indexes.set(row.note, row);
    }
    return Promise.resolve();
  }

  deleteNoteIndexes(notes: readonly NoteId[]): Promise<void> {
    for (const note of notes) {
      if (this.#indexes.delete(note)) this.#indexOrder = undefined;
    }
    return Promise.resolve();
  }

  putNoteTexts(rows: readonly NoteTextRow[]): Promise<void> {
    for (const row of rows) this.#texts.set(row.note, row);
    return Promise.resolve();
  }

  deleteNoteTexts(notes: readonly NoteId[]): Promise<void> {
    for (const note of notes) this.#texts.delete(note);
    return Promise.resolve();
  }

  searchText(query: SearchQuery, limit: number): Promise<readonly TextHit[]> {
    const words = query.words.map(foldText);
    const phrases = query.phrases.map(foldText);
    const excluded = query.excluded.map(foldText);
    if (words.length === 0 && phrases.length === 0) return Promise.resolve([]);
    const hits: { hit: TextHit; score: number }[] = [];
    for (const row of this.#texts.values()) {
      const title = foldText(row.title);
      const text = `${title}\n${foldText(row.body)}`;
      const has = (part: string, prefix: boolean) =>
        prefix
          ? new RegExp(`(^|[^\\p{L}\\p{N}])${escape(part)}`, "u").test(text)
          : wordIn(text, part);
      const found =
        words.every((word, index) => has(word, index === words.length - 1)) &&
        phrases.every((phrase) => wordIn(text, phrase)) &&
        !excluded.some((part) => wordIn(text, part));
      if (!found) continue;
      const first = [...words, ...phrases][0] ?? "";
      const score = title.includes(first) ? 2 : 1;
      hits.push({ hit: { note: row.note, snippet: snippetOf(row.body, first) }, score });
    }
    return Promise.resolve(
      hits
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ hit }) => hit),
    );
  }

  meaningFiles(): Promise<readonly MeaningFile[]> {
    return Promise.resolve([...this.#meaningFiles.values()]);
  }

  notePassages(note: NoteId): Promise<readonly StoredPassage[]> {
    return Promise.resolve([...(this.#passages.get(note) ?? [])]);
  }

  putPassages(file: MeaningFile, passages: readonly MeaningPassage[]): Promise<void> {
    this.#meaningFiles.set(file.note, file);
    this.#passages.set(
      file.note,
      passages.map((passage) => ({ ...passage, id: this.#nextPassage++, note: file.note })),
    );
    return Promise.resolve();
  }

  deletePassages(notes: readonly NoteId[]): Promise<void> {
    for (const note of notes) {
      this.#meaningFiles.delete(note);
      this.#passages.delete(note);
    }
    return Promise.resolve();
  }

  clearPassages(): Promise<void> {
    this.#meaningFiles.clear();
    this.#passages.clear();
    return Promise.resolve();
  }

  passageSigns(after: number, limit: number): Promise<readonly PassageSigns[]> {
    const passages = [...this.#passages.values()]
      .flat()
      .filter((passage) => passage.id > after)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    return Promise.resolve(passages.map(({ id, signs }) => ({ id, signs })));
  }

  passagesById(ids: readonly number[]): Promise<readonly StoredPassage[]> {
    const wanted = new Set(ids);
    return Promise.resolve(
      [...this.#passages.values()].flat().filter((passage) => wanted.has(passage.id)),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

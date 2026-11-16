// What plugins add that is known by a key, such as a code block's
// language or a block's type: one plugin's each, in the order they came,
// with listeners told of each change.

export class KeyedRegistry<T> {
  readonly #items = new Map<string, T>();
  readonly #listeners = new Set<() => void>();
  #all: readonly T[] | undefined;

  /** Adds `item` as `key`, unless another has it; returns what takes it away again. */
  protected addAt(key: string, item: T, taken: (other: T) => string): () => void {
    const other = this.#items.get(key);
    if (other !== undefined) throw new Error(taken(other));
    this.#items.set(key, item);
    this.#changed();
    return () => {
      if (this.#items.get(key) !== item) return;
      this.#items.delete(key);
      this.#changed();
    };
  }

  protected at(key: string): T | undefined {
    return this.#items.get(key);
  }

  /** Everything added, in order; the same array until something changes. */
  all(): readonly T[] {
    this.#all ??= [...this.#items.values()];
    return this.#all;
  }

  /** Calls `listener` when something is added or taken away; returns what stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    this.#all = undefined;
    for (const listener of this.#listeners) listener();
  }
}

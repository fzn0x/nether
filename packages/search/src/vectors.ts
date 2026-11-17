// Vectors as search by meaning keeps them (ADR 0074): unit length, one byte
// a number scaled by the largest, and their signs, one bit a number. A
// search compares every passage's signs with the query's first, which is
// fast and small, then the closest passages' bytes, which is close to the
// cosine of their vectors.

/** A vector as the index keeps it. */
export interface PackedVector {
  /** Each number of the unit vector over `scale`, from -127 to 127. */
  readonly bytes: Int8Array;
  readonly scale: number;
  /** Each number's sign, one bit each, set for a number above 0, the first in the lowest bit. */
  readonly signs: Uint8Array;
}

/** A vector made unit length; one of zeros stays zeros. */
export function unitVector(vector: readonly number[]): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  const unit = new Float32Array(vector.length);
  if (length === 0 || !Number.isFinite(length)) return unit;
  for (let at = 0; at < vector.length; at++) unit[at] = (vector[at] ?? 0) / length;
  return unit;
}

/** A unit vector's signs, one bit a number. */
export function signsOf(unit: Float32Array): Uint8Array {
  const signs = new Uint8Array(Math.ceil(unit.length / 8));
  for (let at = 0; at < unit.length; at++) {
    if ((unit[at] ?? 0) > 0) signs[at >> 3] = (signs[at >> 3] ?? 0) | (1 << (at & 7));
  }
  return signs;
}

/** A vector as the index keeps it: unit length, one byte a number, and its signs. */
export function packVector(vector: readonly number[]): PackedVector {
  const unit = unitVector(vector);
  let largest = 0;
  for (const value of unit) largest = Math.max(largest, Math.abs(value));
  const scale = largest === 0 ? 0 : largest / 127;
  const bytes = new Int8Array(unit.length);
  if (scale > 0) {
    for (let at = 0; at < unit.length; at++) bytes[at] = Math.round((unit[at] ?? 0) / scale);
  }
  return { bytes, scale, signs: signsOf(unit) };
}

/** The cosine of a unit vector with a packed one, near enough to rank by. */
export function packedCosine(unit: Float32Array, bytes: Int8Array, scale: number): number {
  const length = Math.min(unit.length, bytes.length);
  let sum = 0;
  for (let at = 0; at < length; at++) sum += (unit[at] ?? 0) * (bytes[at] ?? 0);
  return sum * scale;
}

/** How many bits of a 32-bit number are set. */
function bitsSet(word: number): number {
  let count = word - ((word >>> 1) & 0x55555555);
  count = (count & 0x33333333) + ((count >>> 2) & 0x33333333);
  count = (count + (count >>> 4)) & 0x0f0f0f0f;
  return Math.imul(count, 0x01010101) >>> 24;
}

/** Signs' bytes as 32-bit words, the first byte lowest. */
function wordsOf(signs: Uint8Array, words: number, into: Uint32Array, at: number): void {
  for (let word = 0; word < words; word++) {
    const byte = word * 4;
    into[at + word] =
      ((signs[byte] ?? 0) |
        ((signs[byte + 1] ?? 0) << 8) |
        ((signs[byte + 2] ?? 0) << 16) |
        ((signs[byte + 3] ?? 0) << 24)) >>>
      0;
  }
}

/**
 * Every passage's signs side by side, by their IDs, to find those that
 * differ least from a query's: on 150,000 passages of 1,536 numbers, 29 MB
 * and a few tens of milliseconds a search.
 */
export class SignIndex {
  readonly dimensions: number;
  readonly #words: number;
  #ids = new Float64Array(1024);
  #bits: Uint32Array;
  #size = 0;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
    this.#words = Math.ceil(dimensions / 32);
    this.#bits = new Uint32Array(1024 * this.#words);
  }

  get size(): number {
    return this.#size;
  }

  /** Adds a passage's signs; those of another length than the index's are left out. */
  add(id: number, signs: Uint8Array): void {
    if (signs.length !== Math.ceil(this.dimensions / 8)) return;
    if (this.#size === this.#ids.length) {
      const ids = new Float64Array(this.#ids.length * 2);
      ids.set(this.#ids);
      this.#ids = ids;
      const bits = new Uint32Array(this.#bits.length * 2);
      bits.set(this.#bits);
      this.#bits = bits;
    }
    this.#ids[this.#size] = id;
    wordsOf(signs, this.#words, this.#bits, this.#size * this.#words);
    this.#size++;
  }

  /** The IDs of the `limit` passages whose signs differ least from `signs`, the closest first. */
  closest(signs: Uint8Array, limit: number): number[] {
    const words = this.#words;
    const query = new Uint32Array(words);
    wordsOf(signs, words, query, 0);
    const distances = new Uint16Array(this.#size);
    // How many passages are at each distance, to find the farthest kept without sorting them all.
    const counts = new Uint32Array(this.dimensions + 1);
    for (let passage = 0; passage < this.#size; passage++) {
      let distance = 0;
      const start = passage * words;
      for (let word = 0; word < words; word++) {
        distance += bitsSet(((this.#bits[start + word] ?? 0) ^ (query[word] ?? 0)) >>> 0);
      }
      distances[passage] = distance;
      counts[distance] = (counts[distance] ?? 0) + 1;
    }
    let farthest = 0;
    let kept = 0;
    while (farthest < counts.length && kept + (counts[farthest] ?? 0) < limit) {
      kept += counts[farthest] ?? 0;
      farthest++;
    }
    const found: { readonly id: number; readonly distance: number }[] = [];
    let atFarthest = limit - kept;
    for (let passage = 0; passage < this.#size; passage++) {
      const distance = distances[passage] ?? 0;
      if (distance < farthest || (distance === farthest && atFarthest-- > 0)) {
        found.push({ id: this.#ids[passage] ?? 0, distance });
      }
    }
    return found.sort((a, b) => a.distance - b.distance).map((each) => each.id);
  }
}

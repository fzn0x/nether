// Vectors as search by meaning keeps them: unit length, a byte a number,
// signs a bit a number, and the passages whose signs differ least found
// without sorting every one.
import { describe, expect, it } from "vitest";
import { SignIndex, packVector, packedCosine, signsOf, unitVector } from "../src/vectors.ts";

/** A vector of numbers from a seed, the same each time. */
function seeded(seed: number, length: number): number[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0xffffffff - 0.5;
  });
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let at = 0; at < a.length; at++) {
    dot += (a[at] ?? 0) * (b[at] ?? 0);
    left += (a[at] ?? 0) ** 2;
    right += (b[at] ?? 0) ** 2;
  }
  return dot / Math.sqrt(left * right);
}

describe("unitVector", () => {
  it("makes a vector unit length", () => {
    const unit = unitVector([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6);
    expect(unit[1]).toBeCloseTo(0.8);
  });

  it("leaves zeros, and what is not a number, as zeros", () => {
    expect([...unitVector([0, 0, 0])]).toEqual([0, 0, 0]);
    expect([...unitVector([Number.POSITIVE_INFINITY, 1])]).toEqual([0, 0]);
  });
});

describe("signsOf", () => {
  it("sets a bit for each number above 0, the first lowest", () => {
    const signs = signsOf(new Float32Array([1, -1, 0, 2, -2, 3, 3, 3, 1]));
    expect([...signs]).toEqual([0b11101001, 0b1]);
  });
});

describe("packVector", () => {
  it("keeps a byte a number, scaled by the largest", () => {
    const packed = packVector([0, 3, -4]);
    expect([...packed.bytes]).toEqual([0, 95, -127]);
    expect(packed.scale).toBeCloseTo(0.8 / 127);
    expect([...packed.signs]).toEqual([0b10]);
  });

  it("keeps a vector of zeros as zeros", () => {
    const packed = packVector([0, 0]);
    expect(packed.scale).toBe(0);
    expect([...packed.bytes]).toEqual([0, 0]);
  });

  it("keeps cosines close to those of the vectors themselves", () => {
    const query = seeded(1, 384);
    const unit = unitVector(query);
    for (let seed = 2; seed < 30; seed++) {
      const other = seeded(seed, 384);
      const packed = packVector(other);
      expect(packedCosine(unit, packed.bytes, packed.scale)).toBeCloseTo(cosine(query, other), 2);
    }
  });
});

describe("SignIndex", () => {
  it("finds the passages whose signs differ least, the closest first", () => {
    const index = new SignIndex(64);
    const base = seeded(7, 64);
    // Each passage is the base with more of its signs turned.
    for (let turned = 0; turned < 40; turned++) {
      const vector = base.map((value, at) => (at < turned ? -value : value));
      index.add(1000 + turned, signsOf(unitVector(vector)));
    }
    expect(index.size).toBe(40);
    expect(index.closest(signsOf(unitVector(base)), 5)).toEqual([1000, 1001, 1002, 1003, 1004]);
  });

  it("keeps only as many as asked at the farthest distance kept", () => {
    const index = new SignIndex(8);
    const same = new Uint8Array([0b1111]);
    for (let id = 1; id <= 10; id++) index.add(id, same);
    index.add(11, new Uint8Array([0b0000]));
    const found = index.closest(same, 3);
    expect(found).toHaveLength(3);
    expect(found.every((id) => id <= 10)).toBe(true);
    expect(index.closest(same, 0)).toEqual([]);
    expect(index.closest(same, 50)).toHaveLength(11);
    expect(index.closest(same, 50).at(-1)).toBe(11);
  });

  it("grows past its first room, and leaves out signs of another length", () => {
    const index = new SignIndex(1536);
    const signs = new Uint8Array(192);
    for (let id = 0; id < 3000; id++) index.add(id, signs);
    index.add(5000, new Uint8Array(10));
    expect(index.size).toBe(3000);
    expect(index.closest(signs, 2)).toEqual([0, 1]);
  });

  it("ranks 150,000 passages of 1,536 numbers in well under a second", () => {
    const index = new SignIndex(1536);
    const signs = new Uint8Array(192);
    for (let at = 0; at < signs.length; at++) signs[at] = (at * 37) & 0xff;
    for (let id = 0; id < 150_000; id++) {
      signs[id % 192] = id & 0xff;
      index.add(id, signs);
    }
    const started = performance.now();
    expect(index.closest(signs, 200)).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

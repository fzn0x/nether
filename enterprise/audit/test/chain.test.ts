// The chain's pieces: JSON that reads the same however its keys were
// ordered, a hash that covers the row before, and a key from
// NETHER_SECRET_KEY that a fingerprint tells apart without giving away.
import { describe, expect, it } from "vitest";
import { canonical, chainKey, keyFingerprint, rowHash } from "../src/chain.ts";

describe("the chain", () => {
  it("writes the same JSON for the same value, its keys sorted at every depth", () => {
    expect(canonical({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}',
    );
    expect(canonical({ kept: "x", left: undefined })).toBe('{"kept":"x"}');
    expect(canonical([undefined, 'a"b'])).toBe('[null,"a\\"b"]');
    expect(canonical(undefined)).toBe("null");
  });

  it("hashes a row with the one before it, under a key or plainly", () => {
    const key = chainKey(Buffer.alloc(32, 1));
    const fields = [1, "id", "2026-11-17T10:00:00.000Z", "session.signed_in"];
    const plain = rowHash(null, "", fields);
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(rowHash(null, "", fields)).toBe(plain);
    expect(rowHash(key, "", fields)).not.toBe(plain);
    expect(rowHash(null, "before", fields)).not.toBe(plain);
    expect(rowHash(null, "", [...fields.slice(0, 3), "session.signed_out"])).not.toBe(plain);
  });

  it("derives a key of its own, told apart by a fingerprint", () => {
    expect(chainKey(null)).toBeNull();
    const key = chainKey(Buffer.alloc(32, 1));
    expect(key).toHaveLength(32);
    expect(key?.equals(Buffer.alloc(32, 1))).toBe(false);
    expect(keyFingerprint(null)).toBe("none");
    expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint(chainKey(Buffer.alloc(32, 2)))).not.toBe(keyFingerprint(key));
  });
});

// The audit log's chain (ADR 0081): each event's hash covers the hash of the
// event before it and its own fields, in a fixed order, so a row changed,
// removed or slipped in breaks the chain from there. The key comes from
// NETHER_SECRET_KEY, which is never in the database: someone with the
// database alone cannot write a chain that checks. Without one the chain is
// plain SHA-256, which still shows a row changed by mistake.
import { createHash, createHmac, hkdfSync } from "node:crypto";

/** What the chain is made under: a key derived from NETHER_SECRET_KEY, or none. */
export type ChainKey = Buffer | null;

/** The chain's key from NETHER_SECRET_KEY's 32 bytes: HKDF, with an `info` of its own. */
export function chainKey(secretKey: Buffer | null): ChainKey {
  if (secretKey === null) return null;
  return Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(0), "nether audit log", 32));
}

/** What tells one key from another without giving it away; `none` without one. */
export function keyFingerprint(key: ChainKey): string {
  if (key === null) return "none";
  return createHmac("sha256", key).update("nether audit key").digest("hex").slice(0, 16);
}

/** A value as JSON with each object's keys sorted, so the same value always reads the same. */
export function canonical(value: unknown): string {
  // A value JSON cannot hold, as undefined, reads as JSON writes it in a list: null.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** A row's hash: of the hash before it and its fields, under the key when there is one. */
export function rowHash(key: ChainKey, previous: string, fields: readonly unknown[]): string {
  const text = `${previous}\n${canonical(fields)}`;
  return (key === null ? createHash("sha256") : createHmac("sha256", key))
    .update(text)
    .digest("hex");
}

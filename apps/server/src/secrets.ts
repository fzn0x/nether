// What the server keeps secret for its accounts, as AI providers' keys
// (ADR 0070), sealed at rest with the admin's NETHER_SECRET_KEY: AES-256-GCM
// with a random nonce, bound to what it belongs to, so a box moved to
// another row does not open. A backup holds the boxes, never the key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The format's first byte, so another can follow. */
const format = 1;
const nonceLength = 12;
const tagLength = 16;

/** Thrown when a box does not open: sealed with another key, or changed. */
export class SealedElsewhere extends Error {
  override readonly name = "SealedElsewhere";

  constructor() {
    super(
      "This secret was sealed with another NETHER_SECRET_KEY, or changed since: set it again here.",
    );
  }
}

export interface Seal {
  /** Seals a secret for what it belongs to, as a provider's ID. */
  seal(secret: string, belongsTo: string): Uint8Array;
  /** Opens what `seal` sealed for the same owner. */
  open(box: Uint8Array, belongsTo: string): string;
}

/** Seals and opens secrets with a 32-byte key. */
export function sealWith(key: Buffer): Seal {
  if (key.length !== 32) throw new Error("A sealing key is 32 bytes.");
  return {
    seal(secret, belongsTo) {
      const nonce = randomBytes(nonceLength);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(belongsTo, "utf8"));
      const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return new Uint8Array(
        Buffer.concat([Buffer.from([format]), nonce, sealed, cipher.getAuthTag()]),
      );
    },
    open(box, belongsTo) {
      const bytes = Buffer.from(box);
      if (bytes.length < 1 + nonceLength + tagLength || bytes[0] !== format) {
        throw new SealedElsewhere();
      }
      const nonce = bytes.subarray(1, 1 + nonceLength);
      const tag = bytes.subarray(bytes.length - tagLength);
      const sealed = bytes.subarray(1 + nonceLength, bytes.length - tagLength);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(Buffer.from(belongsTo, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8");
      } catch {
        throw new SealedElsewhere();
      }
    },
  };
}

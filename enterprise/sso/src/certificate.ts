// The key and self-signed certificate Nether signs its SAML requests with,
// and that providers encrypt their assertions to (ADR 0080). node:crypto
// makes the key and signs, but writes no certificate, so this writes the
// one fixed structure in DER: X.509 v3, RSA with SHA-256, a common name,
// ten years, and the key's uses.
import {
  type KeyObject,
  X509Certificate,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/** A DER element: its tag, its length, and its content. */
function element(tag: number, content: Buffer): Buffer {
  const { length } = content;
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
}

const sequence = (...items: Buffer[]) => element(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => element(0x31, Buffer.concat(items));
const explicit = (number: number, item: Buffer) => element(0xa0 | number, item);
const octets = (content: Buffer) => element(0x04, content);
const utf8 = (text: string) => element(0x0c, Buffer.from(text, "utf8"));
const nothing = element(0x05, Buffer.alloc(0));
const yes = element(0x01, Buffer.from([0xff]));

/** A DER INTEGER of non-negative bytes, with a leading zero when its high bit is set. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return element(
    0x02,
    (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

/** A DER OBJECT IDENTIFIER, from its dotted form. */
function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let value = arc; ; value = Math.floor(value / 128)) {
      groups.unshift(value % 128);
      if (value < 128) break;
    }
    bytes.push(...groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group)));
  }
  return element(0x06, Buffer.from(bytes));
}

/** A DER BIT STRING of whole bytes, or of `unused` bits fewer at its end. */
function bits(content: Buffer, unused = 0): Buffer {
  return element(0x03, Buffer.concat([Buffer.from([unused]), content]));
}

/** UTCTime before 2050, GeneralizedTime from then, as RFC 5280 has it. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? element(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : element(0x18, Buffer.from(`${iso}Z`));
}

const sha256WithRsa = sequence(oid("1.2.840.113549.1.1.11"), nothing);

/** A key pair and its certificate, both in PEM. */
export interface ServiceKey {
  readonly privateKey: string;
  readonly certificate: string;
}

/** Years a certificate is valid for. */
export const certificateYears = 10;

/** Wraps DER in PEM lines of 64 characters. */
function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A self-signed certificate for a key pair, named by `commonName`, valid from `from` for ten years. */
export function selfSigned(
  commonName: string,
  keys: { readonly publicKey: KeyObject; readonly privateKey: KeyObject },
  from = new Date(),
): string {
  const notBefore = new Date(Math.floor(from.getTime() / 1000) * 1000 - 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + certificateYears);
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
  // A random positive serial number of 16 bytes (RFC 5280 allows up to 20).
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const extensions = explicit(
    3,
    sequence(
      // Not a certificate authority.
      sequence(oid("2.5.29.19"), yes, octets(sequence())),
      // For signing and for the keys assertions are encrypted with.
      sequence(oid("2.5.29.15"), yes, octets(bits(Buffer.from([0xa0]), 5))),
    ),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    sha256WithRsa,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    keys.publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, keys.privateKey);
  return pem("CERTIFICATE", sequence(tbs, sha256WithRsa, bits(signature)));
}

/** A new RSA key and its self-signed certificate, as a SAML provider's are made. */
export function newServiceKey(commonName: string): ServiceKey {
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const certificate = selfSigned(commonName, keys);
  // Read back, so a certificate that does not parse is never kept.
  const read = new X509Certificate(certificate);
  if (!read.checkPrivateKey(keys.privateKey))
    throw new Error("The certificate does not match its key.");
  return {
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificate,
  };
}

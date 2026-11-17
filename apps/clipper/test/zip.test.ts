// The stores' ZIPs (ADR 0066): each file deflated at its path, with its
// CRC-32 and sizes where a reader looks for them, the same bytes each time.
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zipOf } from "../scripts/zip.ts";

/** The files of a ZIP, read through its central directory, as unzip reads them. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const check = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = inflateRawSync(zip.subarray(start, start + packed));
    expect(bytes.length).toBe(size);
    expect(crc32(bytes)).toBe(check);
    files.set(name, bytes);
    at += 46 + nameLength;
  }
  return files;
}

describe("zipOf", () => {
  it("holds each file at its path, read back as it was", () => {
    const manifest = new TextEncoder().encode('{"manifest_version":3}\n');
    const icon = new Uint8Array(1000).map((_, index) => index % 7);
    const zip = zipOf([
      { path: "manifest.json", bytes: manifest },
      { path: "icons/icon-16.png", bytes: icon },
      { path: "assets/écrit.js", bytes: new Uint8Array() },
    ]);
    const files = unzip(zip);
    expect([...files.keys()]).toEqual(["manifest.json", "icons/icon-16.png", "assets/écrit.js"]);
    expect(files.get("manifest.json")?.toString("utf8")).toBe('{"manifest_version":3}\n');
    expect(files.get("icons/icon-16.png")?.equals(Buffer.from(icon))).toBe(true);
    expect(files.get("assets/écrit.js")).toHaveLength(0);
    expect(
      zipOf([{ path: "manifest.json", bytes: manifest }]).equals(
        zipOf([{ path: "manifest.json", bytes: manifest }]),
      ),
    ).toBe(true);
  });
});

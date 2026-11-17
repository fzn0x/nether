// A ZIP of a folder, for a browser's store (ADR 0066), with Node's own
// deflate and CRC-32: each file compressed, stored at its path from the
// folder, with fixed times so the same build makes the same ZIP.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/** Every file under a folder, by its path from it with forward slashes, sorted. */
async function filesOf(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      found.push(relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"));
    }
  }
  return found.sort();
}

/** 1 January 2026, as a ZIP's MS-DOS time and date. */
const dosTime = 0;
const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** The bytes of a ZIP holding these files, by path. */
export function zipOf(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const packed = deflateRawSync(file.bytes, { level: 9 });
    const check = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(check, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(check, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Writes a ZIP of every file under `folder` to `to`. */
export async function zipFolder(folder: string, to: string): Promise<void> {
  const files = await Promise.all(
    (await filesOf(folder)).map(async (path) => ({
      path,
      bytes: new Uint8Array(await readFile(join(folder, path))),
    })),
  );
  await writeFile(to, zipOf(files));
}

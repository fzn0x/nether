import { describe, expect, it } from "vitest";
import {
  ChangedOnDisk,
  type DeviceFolder,
  DeviceFiles,
  type FileEvent,
  type FileInfo,
  type FileText,
  MemoryFiles,
  sha256,
} from "../src/index.ts";
import { bytes, script } from "./script.ts";

// A phone's native side, in memory, answering as the apps' plugins do.
let clock = 1_000;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

const hidden = (name: string) => name.startsWith(".");
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

class FakeFolder implements DeviceFolder {
  readonly files = new Map<string, { data: Uint8Array; modified: number }>();
  readonly made = new Set<string>();
  readonly asked: (readonly string[])[] = [];
  /** Paths whose next write the native side finds taken, as another write got there first. */
  readonly taken = new Set<string>();

  #info(path: string): FileInfo | undefined {
    const file = this.files.get(path);
    return file === undefined
      ? undefined
      : { path, size: file.data.length, modified: file.modified };
  }

  #isFolder(path: string): boolean {
    if (path === "" || this.made.has(path)) return true;
    return [...this.files.keys(), ...this.made].some((each) => each.startsWith(`${path}/`));
  }

  #make(path: string): void {
    for (let folder = path; folder !== ""; folder = parentOf(folder)) this.made.add(folder);
  }

  /** Whether `path` is below `folder` with no hidden name past it. */
  #shownBelow(path: string, folder: string): boolean {
    if (folder !== "" && !path.startsWith(`${folder}/`)) return false;
    const rest = folder === "" ? path : path.slice(folder.length + 1);
    return !rest.split("/").some(hidden);
  }

  walk(folder: string): Promise<readonly FileInfo[]> {
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => this.#shownBelow(path, folder))
        .flatMap((path) => this.#info(path) ?? []),
    );
  }

  folders(folder: string): Promise<readonly string[]> {
    const all = new Set(this.made);
    for (const path of this.files.keys()) {
      for (let at = parentOf(path); at !== ""; at = parentOf(at)) all.add(at);
    }
    return Promise.resolve([...all].filter((path) => this.#shownBelow(path, folder)));
  }

  stat(paths: readonly string[]): Promise<readonly FileInfo[]> {
    return Promise.resolve(paths.flatMap((path) => this.#info(path) ?? []));
  }

  async readText(paths: readonly string[]): Promise<readonly FileText[]> {
    this.asked.push(paths);
    const out: FileText[] = [];
    for (const path of paths) {
      const file = this.files.get(path);
      const info = this.#info(path);
      if (file === undefined || info === undefined) {
        out.push({ path, size: 0, modified: 0, text: "", hash: "", missing: true });
        continue;
      }
      const hash = await sha256(file.data);
      try {
        out.push({ ...info, text: decoder.decode(file.data), hash });
      } catch {
        out.push({ ...info, text: "", hash, binary: true });
      }
    }
    return out;
  }

  async readBytes(path: string) {
    const file = this.files.get(path);
    const info = this.#info(path);
    if (file === undefined || info === undefined) return undefined;
    return { ...info, bytes: file.data.slice(), hash: await sha256(file.data) };
  }

  async write(path: string, data: string | Uint8Array, base: string) {
    const current = this.files.get(path);
    if (this.taken.delete(path) || (base === "" && current !== undefined)) return "exists";
    if (base !== "" && (current === undefined || (await sha256(current.data)) !== base)) {
      return "changed";
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    this.#make(parentOf(path));
    this.files.set(path, { data: bytes, modified: ++clock });
    return { path, size: bytes.length, modified: clock, hash: await sha256(bytes) };
  }

  move(from: string, to: string): Promise<FileInfo | "exists" | "missing"> {
    const file = this.files.get(from);
    if (file === undefined) return Promise.resolve("missing");
    if (this.files.has(to) || this.#isFolder(to)) return Promise.resolve("exists");
    this.files.delete(from);
    this.#make(parentOf(to));
    this.files.set(to, file);
    return Promise.resolve(this.#info(to) ?? "missing");
  }

  delete(path: string): Promise<boolean> {
    return Promise.resolve(this.files.delete(path));
  }

  makeFolder(path: string): Promise<"made" | "exists"> {
    if (this.files.has(path) || this.#isFolder(path)) return Promise.resolve("exists");
    this.#make(path);
    return Promise.resolve("made");
  }

  removeFolder(path: string): Promise<"removed" | "missing" | "full"> {
    if (!this.#isFolder(path)) return Promise.resolve("missing");
    const inside = [...this.files.keys(), ...this.made].some((each) => each.startsWith(`${path}/`));
    if (inside) return Promise.resolve("full");
    this.made.delete(path);
    return Promise.resolve("removed");
  }
}

describe("DeviceFiles", () => {
  it("behaves as MemoryFiles does, step by step", async () => {
    const device = await script(new DeviceFiles(new FakeFolder()));
    const memory = await script(new MemoryFiles());
    expect(device).toEqual(memory);
  });

  it("hands a large folder over in batches, and reads many in batches too", async () => {
    const folder = new FakeFolder();
    const files = new DeviceFiles(folder);
    const paths: string[] = [];
    for (let index = 0; index < 1_200; index++) {
      const path = `Notes/${String(index)}.md`;
      paths.push(path);
      await files.write(path, `note ${String(index)}`, "");
    }
    const sizes: number[] = [];
    await files.list("", (found) => sizes.push(found.length));
    expect(sizes).toEqual([500, 500, 200]);

    const texts: string[] = [];
    await files.readMany(paths, (file) => texts.push(file.text));
    expect(texts).toHaveLength(1_200);
    expect(texts[0]).toBe("note 0");
    expect(texts.at(-1)).toBe("note 1199");
    expect(folder.asked.map((asked) => asked.length)).toEqual([500, 500, 200]);
  });

  it("attaches beside a name another write took first, and trashes under a free name", async () => {
    const folder = new FakeFolder();
    const files = new DeviceFiles(folder);
    folder.taken.add("cat.png");
    expect(await files.attach("cat.png", bytes(1))).toMatchObject({ path: "cat 1.png" });

    await files.write("Plan.md", "one", "");
    expect(await files.remove("Plan.md")).toBe(".trash/Plan.md");
    await files.write("Plan.md", "two", "");
    expect(await files.remove("Plan.md")).toBe(".trash/Plan 2.md");
    await expect(files.remove("Plan.md")).rejects.toThrow("Plan.md is not there.");
  });

  it("says a file changed on disk when the native side finds it so", async () => {
    const files = new DeviceFiles(new FakeFolder());
    const first = await files.write("Welcome.md", "hello", "");
    await expect(files.write("Welcome.md", "again", "not its hash")).rejects.toBeInstanceOf(
      ChangedOnDisk,
    );
    await expect(files.writeBytes("Welcome.md", bytes(1), "not its hash")).rejects.toBeInstanceOf(
      ChangedOnDisk,
    );
    expect(await files.write("Welcome.md", "again", first.hash)).toMatchObject({ text: "again" });
  });

  it("renames a file onto itself as it is, and tells of a missing one", async () => {
    const files = new DeviceFiles(new FakeFolder());
    await files.write("Plan.md", "plan", "");
    expect(await files.rename("Plan.md", "Plan.md")).toMatchObject({ path: "Plan.md", size: 4 });
    await expect(files.rename("Nowhere.md", "Nowhere.md")).rejects.toThrow(
      "Nowhere.md is not there.",
    );
  });

  it("asks the vault to look again at the whole folder", async () => {
    const files = new DeviceFiles(new FakeFolder());
    const events: FileEvent[] = [];
    const stop = new AbortController();
    void files.watch((batch) => events.push(...batch), stop.signal);
    files.rescan();
    stop.abort();
    files.rescan();
    expect(events).toEqual([{ op: "rescan", path: "", isDir: true }]);
    // A watch already stopped watches nothing.
    await files.watch(() => undefined, stop.signal);
  });

  it("refuses paths that leave the vault before asking the native side", async () => {
    const folder = new FakeFolder();
    const files = new DeviceFiles(folder);
    await expect(files.read("../secret.md")).rejects.toThrow("is not a path in the vault");
    await expect(files.list("../outside", () => undefined)).rejects.toThrow(
      "is not a path in the vault",
    );
    expect(() => files.stat(["/etc/passwd"])).toThrow("is not a path in the vault");
    expect(folder.asked).toEqual([]);
  });
});

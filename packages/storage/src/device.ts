// A vault folder on a phone (ADR 0087): its files on the device's own disk,
// reached through the app's native side, which does only what needs the
// disk itself. It lists, reads with each file's SHA-256, and writes in one
// step: to a temporary file beside the note, synced to the disk, renamed
// over it, after checking the note is still what the page last read. The
// rest is here, as OpfsFiles and the desktop's Go service have it: the
// trash, attaching under a free name, hidden files left out of lists, the
// errors they give, and batches of change events. Nothing else writes to
// the folder while the app is on screen, so the watch reports the app's own
// changes; `rescan` asks the vault to look again, as the app comes back.
import {
  ChangedOnDisk,
  type FileBytes,
  type FileEvent,
  type FileHash,
  type FileInfo,
  type FileText,
  type VaultFiles,
} from "./files.ts";
import { checkPath, hiddenPath, numbered } from "./opfs.ts";

/** What the native side does on a vault's folder, each answer a value or why not. */
export interface DeviceFolder {
  /** Every file below a folder, hidden ones below it left out; none when it is not a folder. */
  walk(folder: string): Promise<readonly FileInfo[]>;
  /** Every folder below a folder, hidden ones and what is in them left out. */
  folders(folder: string): Promise<readonly string[]>;
  /** The files that are there, of those asked, in order. */
  stat(paths: readonly string[]): Promise<readonly FileInfo[]>;
  /** Files' text and hashes, in order: `missing` or `binary` as `VaultFiles.read` has them. */
  readText(paths: readonly string[]): Promise<readonly FileText[]>;
  /** A file's bytes and hash; undefined when it is not there. */
  readBytes(path: string): Promise<FileBytes | undefined>;
  /**
   * Writes a file in one step, making its folders, if it is still `base`,
   * the hash last read, or "" for none: `exists` or `changed` when not.
   */
  write(
    path: string,
    data: string | Uint8Array,
    base: string,
  ): Promise<FileHash | "exists" | "changed">;
  /** Moves a file, making folders: `exists` when one is at `to`, `missing` when none is at `from`. */
  move(from: string, to: string): Promise<FileInfo | "exists" | "missing">;
  /** Deletes a file; false when none is there. */
  delete(path: string): Promise<boolean>;
  /** Makes a folder and those it is in: `exists` when a file or folder is there. */
  makeFolder(path: string): Promise<"made" | "exists">;
  /** Deletes an empty folder: `missing` when there is none, `full` when anything is in it, hidden files too. */
  removeFolder(path: string): Promise<"removed" | "missing" | "full">;
}

/** How many files `list` and `readMany` hand over, or ask for, at a time. */
const batch = 500;

export class DeviceFiles implements VaultFiles {
  readonly #folder: DeviceFolder;
  readonly #listeners = new Set<(events: readonly FileEvent[]) => void>();
  /** Changes run one at a time, so what a change checks is what it changes. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(folder: DeviceFolder) {
    this.#folder = folder;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #emit(events: readonly FileEvent[]): void {
    for (const listener of this.#listeners) listener(events);
  }

  /** Asks the vault to look at its whole folder again, as when another app may have changed it. */
  rescan(): void {
    this.#emit([{ op: "rescan", path: "", isDir: true }]);
  }

  async list(folder: string, each: (files: readonly FileInfo[]) => void): Promise<void> {
    if (folder !== "") checkPath(folder);
    const files = await this.#folder.walk(folder);
    for (let start = 0; start < files.length; start += batch) {
      each(files.slice(start, start + batch));
    }
  }

  stat(paths: readonly string[]): Promise<readonly FileInfo[]> {
    for (const path of paths) checkPath(path);
    return this.#folder.stat(paths);
  }

  async read(path: string): Promise<FileText> {
    checkPath(path);
    const [file] = await this.#folder.readText([path]);
    return file ?? { path, size: 0, modified: 0, text: "", hash: "", missing: true };
  }

  async readMany(paths: readonly string[], each: (file: FileText) => void): Promise<void> {
    for (const path of paths) checkPath(path);
    for (let start = 0; start < paths.length; start += batch) {
      for (const file of await this.#folder.readText(paths.slice(start, start + batch))) {
        each(file);
      }
    }
  }

  /** Writes, or says why not as VaultFiles does; true when it made the file. */
  async #write(path: string, data: string | Uint8Array, base: string): Promise<FileHash> {
    const written = await this.#folder.write(path, data, base);
    if (written === "exists") throw new Error(`${path}: a file is already there.`);
    if (written === "changed") throw new ChangedOnDisk(path);
    this.#emit([{ op: base === "" ? "create" : "write", path, isDir: false }]);
    return written;
  }

  write(path: string, text: string, base: string): Promise<FileText> {
    checkPath(path);
    return this.#serial(async () => ({ ...(await this.#write(path, text, base)), text }));
  }

  async readBytes(path: string): Promise<FileBytes> {
    checkPath(path);
    const found = await this.#folder.readBytes(path);
    if (found === undefined) throw new Error(`${path} is not there.`);
    return found;
  }

  writeBytes(path: string, data: Uint8Array, base: string): Promise<FileHash> {
    checkPath(path);
    return this.#serial(() => this.#write(path, data, base));
  }

  rename(from: string, to: string): Promise<FileInfo> {
    checkPath(from);
    checkPath(to);
    return this.#serial(async () => {
      if (from === to) {
        const [found] = await this.#folder.stat([from]);
        if (found === undefined) throw new Error(`${from} is not there.`);
        return found;
      }
      const moved = await this.#folder.move(from, to);
      if (moved === "missing") throw new Error(`${from} is not there.`);
      if (moved === "exists") throw new Error(`${to}: a file is already there.`);
      this.#emit([{ op: "rename", path: to, oldPath: from, isDir: false }]);
      return moved;
    });
  }

  attach(path: string, data: Uint8Array): Promise<FileInfo> {
    checkPath(path);
    return this.#serial(async () => {
      for (let n = 1; ; n++) {
        const target = n === 1 ? path : numbered(path, n - 1);
        const written = await this.#folder.write(target, data, "");
        if (written === "exists") continue;
        if (written === "changed") throw new ChangedOnDisk(target);
        this.#emit([{ op: "create", path: target, isDir: false }]);
        return { path: written.path, size: written.size, modified: written.modified };
      }
    });
  }

  remove(path: string): Promise<string> {
    checkPath(path);
    return this.#serial(async () => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      for (let n = 1; ; n++) {
        const target = `.trash/${n === 1 ? name : numbered(name, n)}`;
        const moved = await this.#folder.move(path, target);
        if (moved === "missing") throw new Error(`${path} is not there.`);
        if (moved === "exists") continue;
        this.#emit([{ op: "remove", path, isDir: false }]);
        return target;
      }
    });
  }

  erase(path: string): Promise<void> {
    checkPath(path);
    if (!path.startsWith(".trash/")) {
      return Promise.reject(new Error(`${path} is not in the trash.`));
    }
    return this.#serial(async () => {
      if (!(await this.#folder.delete(path))) throw new Error(`${path} is not there.`);
    });
  }

  folders(folder: string): Promise<readonly string[]> {
    if (folder !== "") checkPath(folder);
    return this.#folder.folders(folder);
  }

  makeFolder(path: string): Promise<void> {
    checkPath(path);
    if (hiddenPath(path)) return Promise.reject(new Error(`"${path}" has a hidden name.`));
    return this.#serial(async () => {
      if ((await this.#folder.makeFolder(path)) === "exists") {
        throw new Error(`${path}: a file is already there.`);
      }
    });
  }

  removeFolder(path: string): Promise<void> {
    checkPath(path);
    return this.#serial(async () => {
      const removed = await this.#folder.removeFolder(path);
      if (removed === "missing") throw new Error(`${path} is not a folder.`);
      if (removed === "full") throw new Error(`"${path}" is not empty.`);
    });
  }

  watch(each: (events: readonly FileEvent[]) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    this.#listeners.add(each);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        this.#listeners.delete(each);
        resolve();
      });
    });
  }
}

// The steps every VaultFiles takes alike, which each store is checked
// against MemoryFiles with: what each gave, or the error it threw.
import type { FileEvent, VaultFiles } from "../src/index.ts";

export const bytes = (...values: number[]) => new Uint8Array(values);

/**
 * Runs the same steps on a vault and records what each gave, or the error
 * it threw, without modification times, which differ between stores.
 */
export async function script(files: VaultFiles): Promise<unknown[]> {
  const out: unknown[] = [];
  const events: FileEvent[] = [];
  const stop = new AbortController();
  void files.watch((batch) => events.push(...batch), stop.signal);
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(strip).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value instanceof Uint8Array) return [...value];
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "modified")
        .map(([key, item]) => [key, strip(item)]),
    );
  };
  const step = async (name: string, work: () => Promise<unknown>) => {
    try {
      out.push([name, strip(await work())]);
    } catch (error) {
      out.push([name, (error as Error).name, (error as Error).message]);
    }
  };
  const listed = async (folder: string) => {
    const found: unknown[] = [];
    await files.list(folder, (batch) => found.push(...batch));
    return found;
  };

  await step("read a missing file", () => files.read("Nowhere.md"));
  const first = await files.write("Welcome.md", "# Welcome\n", "");
  out.push(["write", strip(first)]);
  await step("write over without a base", () => files.write("Welcome.md", "again", ""));
  await step("write over a changed file", () => files.write("Welcome.md", "again", "abc"));
  await step("write over", () => files.write("Welcome.md", "# Hello\n", first.hash));
  await step("write in folders", () => files.write("Projects/2026/Plan.md", "plan", ""));
  await step("hidden", () => files.write(".nether/settings.json", "{}", ""));
  await step("binary", () => files.writeBytes("attachments/raw.bin", bytes(0xff, 0xfe, 0x00), ""));
  await step("read binary", () => files.read("attachments/raw.bin"));
  await step("read bytes", () => files.readBytes("Welcome.md"));
  await step("bytes over a changed file", () =>
    files.writeBytes("attachments/raw.bin", bytes(1), ""),
  );
  await step("list", () => listed(""));
  await step("list a folder", () => listed("Projects"));
  await step("list a hidden folder", () => listed(".nether"));
  await step("stat", () => files.stat(["Welcome.md", "Nowhere.md", "Projects/2026/Plan.md"]));
  await step("attach", () => files.attach("attachments/cat.png", bytes(1, 2)));
  await step("attach again", () => files.attach("attachments/cat.png", bytes(3)));
  await step("attach without a dot", () => files.attach("attachments/README", bytes(4)));
  await step("attach it again", () => files.attach("attachments/README", bytes(5)));
  await step("rename", () => files.rename("Projects/2026/Plan.md", "Archive/Plan.md"));
  await step("rename onto a file", () => files.rename("Welcome.md", "Archive/Plan.md"));
  await step("rename a missing file", () => files.rename("Nowhere.md", "Here.md"));
  await step("remove", () => files.remove("Archive/Plan.md"));
  await files.write("Plan.md", "again", "");
  await step("remove the same name", () => files.remove("Plan.md"));
  await step("list the trash", () => listed(".trash"));
  await step("erase outside the trash", () => files.erase("Welcome.md"));
  await step("erase", () => files.erase(".trash/Plan.md"));
  await step("erase again", () => files.erase(".trash/Plan.md"));
  await step("folders", () => files.folders(""));
  await step("make a folder", () => files.makeFolder("Ideas/Garden"));
  await step("make it again", () => files.makeFolder("Ideas/Garden"));
  await step("make a hidden folder", () => files.makeFolder("Ideas/.secret"));
  await step("make a folder where a file is", () => files.makeFolder("Welcome.md"));
  await step("folders below", () => files.folders("Ideas"));
  await step("remove a full folder", () => files.removeFolder("attachments"));
  await step("remove an empty folder", () => files.removeFolder("Ideas/Garden"));
  await step("remove a missing folder", () => files.removeFolder("Ideas/Garden"));
  await step("a path out of the vault", () => files.read("../secret.md"));
  stop.abort();
  out.push(["events", events]);
  return out;
}

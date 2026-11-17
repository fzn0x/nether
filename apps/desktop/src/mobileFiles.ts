// A vault's folder on the phone (ADR 0087): the native plugin's calls as the
// `DeviceFolder` that `DeviceFiles` builds the vault's files on, bytes
// crossing the bridge as base64.
import type { DeviceFolder, FileBytes, FileHash, FileInfo } from "@nether/storage";
import type { NetherVaultsPlugin } from "./mobile.ts";

/** Base64 as bytes, as the plugin gives them. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Bytes as base64, which is how the plugin takes them. */
export function toBase64(data: Uint8Array): string {
  let binary = "";
  // In pieces: String.fromCharCode takes only so many arguments.
  for (let start = 0; start < data.length; start += 0x8000) {
    binary += String.fromCharCode(...data.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** A vault's folder, by its ID, through the plugin. */
export function phoneFolder(plugin: NetherVaultsPlugin, id: string): DeviceFolder {
  return {
    async walk(folder) {
      return (await plugin.walk({ id, folder })).files;
    },
    async folders(folder) {
      return (await plugin.folders({ id, folder })).folders;
    },
    async stat(paths) {
      return (await plugin.stat({ id, paths })).files;
    },
    async readText(paths) {
      return (await plugin.readText({ id, paths })).files;
    },
    async readBytes(path): Promise<FileBytes | undefined> {
      const { file } = await plugin.readBytes({ id, path });
      if (file === undefined) return undefined;
      const { data, ...rest } = file;
      return { ...rest, bytes: fromBase64(data) };
    },
    async write(path, data, base): Promise<FileHash | "exists" | "changed"> {
      const { result, file } = await plugin.write({
        id,
        path,
        base,
        ...(typeof data === "string" ? { text: data } : { data: toBase64(data) }),
      });
      if (result !== "written") return result;
      if (file === undefined) throw new Error(`${path}: the write gave nothing back.`);
      return file;
    },
    async move(from, to): Promise<FileInfo | "exists" | "missing"> {
      const { result, file } = await plugin.move({ id, from, to });
      if (result !== "moved") return result;
      if (file === undefined) throw new Error(`${to}: the move gave nothing back.`);
      return file;
    },
    async delete(path) {
      return (await plugin.delete({ id, path })).deleted;
    },
    async makeFolder(path) {
      return (await plugin.makeFolder({ id, path })).result;
    },
    async removeFolder(path) {
      return (await plugin.removeFolder({ id, path })).result;
    },
  };
}

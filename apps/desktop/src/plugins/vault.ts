// What a plugin reaches of the vault (ADR 0064), as the app does it for
// it: notes read as they are now, written through their documents as the
// editor's source mode is, and moved to the trash as the app moves them.
// Paths in hidden folders, `.nether` and other tools' among them, are not
// reached at all.
import type { NoteId } from "@nether/core";
import { type Vault, isNotePath } from "@nether/storage";
import { noteDocuments, whenLoaded } from "../noteDocuments.ts";

/** A note as a plugin lists it. */
export interface ListedNote {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

/** What the host asks of the vault for its plugins; the host checks their permissions first. */
export interface VaultAccess {
  notes(): readonly ListedNote[];
  read(path: string): Promise<string>;
  files(): readonly string[];
  readFile(path: string): Promise<Uint8Array>;
  write(path: string, text: string): Promise<void>;
  /** Moves a note to the trash for `plugin`, which the app says. */
  remove(path: string, plugin: string): Promise<void>;
  /** Calls `listener` with the paths of notes as they change; gives the way to stop. */
  subscribe(listener: (paths: readonly string[]) => void): () => void;
}

/** The most a plugin reads of a file at once. */
export const fileLimit = 20 * 1024 * 1024;

/** Whether a path is one a plugin may reach: in the vault, and in no hidden folder. */
export function reachable(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && !part.startsWith("."));
}

/** A path a plugin sent, checked; a note's, when `note`. */
export function pluginPath(value: unknown, note: boolean): string {
  if (typeof value !== "string") throw new Error("A path is text.");
  if (!reachable(value)) {
    throw new Error(
      `A plugin reaches no ${JSON.stringify(value)}: not outside the vault, nor in a hidden folder.`,
    );
  }
  if (note && !isNotePath(value))
    throw new Error(`${value} is not a note: a note's path ends in .md.`);
  return value;
}

/** Bytes as Base64, as they cross to a plugin. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/**
 * The vault, as plugins reach it. `onRemoved` is told of a note a plugin
 * moved to the trash, with where it went, for the app to close its tabs
 * and offer to put it back.
 */
export function vaultAccess(
  vault: Vault,
  onRemoved: (removed: {
    readonly id: NoteId;
    readonly title: string;
    readonly where: string;
    readonly plugin: string;
  }) => void,
): VaultAccess {
  const documents = noteDocuments(vault);
  const noteAt = (path: string) => {
    const entry = vault.noteAt(path);
    if (entry === undefined) throw new Error(`The vault has no note ${path}.`);
    return entry;
  };
  /** Holds a note's document while `use` runs, as the editor does. */
  const holding = async <T>(
    id: NoteId,
    use: (note: ReturnType<typeof documents.open>["note"]) => Promise<T>,
  ) => {
    const hold = documents.open(id);
    try {
      await whenLoaded(hold.note);
      return await use(hold.note);
    } finally {
      hold.release();
    }
  };
  return {
    notes: () =>
      vault
        .notes()
        .filter((note) => reachable(note.path))
        .map((note) => ({ id: note.id, path: note.path, title: note.title })),
    async read(path) {
      return holding(noteAt(path).id, async (note) => {
        // What is waiting for the file is saved first, so the text is as it is now.
        await note.refresh();
        const { state } = note.snapshot;
        if (state.status !== "ready") throw new Error(`${path} cannot be read as a note.`);
        return state.text;
      });
    },
    files: () => vault.attachments().filter(reachable).sort(),
    async readFile(path) {
      const info = vault.fileInfo(path);
      if (info === undefined || vault.noteAt(path) !== undefined) {
        throw new Error(`The vault has no file ${path} that is not a note.`);
      }
      if (info.size > fileLimit) throw new Error(`${path} is larger than a plugin reads at once.`);
      return (await vault.readBytes(path)).bytes;
    },
    async write(path, text) {
      const entry = vault.noteAt(path);
      if (entry === undefined) {
        await vault.create(path, text);
        return;
      }
      await holding(entry.id, async (note) => {
        // Merged into the document block by block, as source mode's text is.
        note.editText(text);
        await note.refresh();
      });
    },
    async remove(path, plugin) {
      const entry = noteAt(path);
      const where = await vault.remove(entry.id);
      onRemoved({ id: entry.id, title: entry.title, where, plugin });
    },
    subscribe: (listener) =>
      vault.subscribe((changed) => {
        const paths = changed.flatMap((id) => {
          const path = vault.note(id)?.path;
          return path !== undefined && reachable(path) ? [path] : [];
        });
        if (paths.length > 0) listener(paths);
      }),
  };
}

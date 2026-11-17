// What a database's triggers do (ADR 0072). For a property the app changed
// in a row on this device, the rules of the row's database that the change
// fires set their values, written through the row's document. That write
// is not a change the app tells of, so no trigger runs for it.
import { firedValues } from "@nether/automations";
import type { DatabaseSchema } from "@nether/core";
import { databaseKey, databaseOf, rowTitle } from "@nether/database";
import { documentProperties } from "@nether/editor";
import type { NoteEntry, Vault } from "@nether/storage";
import { resolveLink } from "./databases.ts";
import { setNoteValues } from "./noteActions.ts";
import { noteDocuments, whenLoaded } from "./noteDocuments.ts";
import type { PropertyChange } from "./plugins/propertyChanges.ts";

/** The database a row at `path` is in: the note beside its folder, `Projects.md` for `Projects/Launch.md`. */
export function databaseNoteOf(vault: Vault, path: string): NoteEntry | undefined {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return undefined;
  const wanted = `${path.slice(0, slash)}.md`;
  return (
    vault.noteAt(wanted) ??
    vault.notes().find((note) => note.path.toLowerCase() === wanted.toLowerCase())
  );
}

/** A database's schema as its document holds it now, which the editor may not have saved yet. */
async function schemaOf(
  change: PropertyChange,
  database: NoteEntry,
): Promise<DatabaseSchema | undefined> {
  const hold = noteDocuments(change.vault).open(database.id);
  try {
    await whenLoaded(hold.note);
    const { state } = hold.note.snapshot;
    if (state.status !== "ready") return undefined;
    return databaseOf(documentProperties(state.document), resolveLink(change.graph, database.path));
  } catch {
    // A schema that cannot be read runs no rules; its database says why.
    return undefined;
  } finally {
    hold.release();
  }
}

/** Runs the triggers a change of a row's property fires, as of `now`. */
export async function runTriggers(change: PropertyChange, now = new Date()): Promise<void> {
  const row = change.vault.note(change.note);
  if (row === undefined) return;
  const database = databaseNoteOf(change.vault, row.path);
  // A note beside the folder that the link index finds no schema in is no database.
  const indexed = database === undefined ? undefined : change.graph.note(database.id);
  if (database === undefined || indexed?.index.properties.every((e) => e.key !== databaseKey)) {
    return;
  }
  const triggers = (await schemaOf(change, database))?.triggers ?? [];
  if (!triggers.some((trigger) => trigger.when === change.key)) return;
  const values = firedValues(triggers, change, { title: rowTitle(row), now });
  if (Object.keys(values).length === 0) return;
  await setNoteValues(change.vault, change.note, values);
}

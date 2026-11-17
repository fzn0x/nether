// Exports and Send a copy on a phone (ADR 0087), through the system's share
// sheet, which offers Save to Files, mail, or any app: there is no folder
// to choose. The plugin's `NetherVaults` writes a ZIP from the vault's
// files in the app's cache, as Go does on the desktop, so a vault's files
// never cross the bridge; a database's CSV and a note's copy are written
// there as files too. A PDF waits, as the WebViews cannot print to a file.
import type { Exporter, NoteCopy } from "./backend.ts";
import { t } from "./messages.ts";
import type { NetherVaultsPlugin } from "./mobile.ts";

/** Hands files to the system's share sheet, as @capacitor/share does. */
export type ShareFiles = (options: {
  readonly title: string;
  readonly text?: string;
  readonly files: string[];
}) => Promise<unknown>;

/** A file of the phone as the share plugin takes it: a `file:` URL. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Shares files; closing the share sheet without choosing is no failure. */
async function share(send: ShareFiles, options: Parameters<ShareFiles>[0]): Promise<void> {
  try {
    await send(options);
  } catch (error) {
    if (error instanceof Error && /cancel/i.test(error.message)) return;
    throw error;
  }
}

/** A file's name the share sheet shows, without what a file system cannot hold. */
function fileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return clean === "" ? "Nether" : clean;
}

/** Exports of a vault on the phone, each handed to the share sheet as it is done. */
export function phoneExporter(
  vaults: NetherVaultsPlugin,
  vault: string,
  send: ShareFiles,
): Exporter {
  const open = new Map<string, { readonly name: string; readonly zip: boolean }>();
  let next = 0;
  const take = (token: string) => {
    const item = open.get(token);
    if (item === undefined) throw new Error(`No export is open as ${token}.`);
    open.delete(token);
    return item;
  };
  return {
    shares: true,
    async choose(name, kind) {
      if (kind === "pdf") throw new Error(t("mobilePdfLater"));
      const file = fileName(name);
      if (kind === "zip") {
        const { token } = await vaults.exportStart({ name: file });
        open.set(token, { name: file, zip: true });
        return token;
      }
      next += 1;
      const token = `text-${String(next)}`;
      open.set(token, { name: `${file}.${kind}`, zip: false });
      return token;
    },
    async add(token, entries) {
      await vaults.exportAdd({ token, id: vault, entries: [...entries] });
    },
    async finish(token) {
      const { name } = take(token);
      const { path } = await vaults.exportFinish({ token });
      await share(send, { title: name, files: [fileUrl(path)] });
      return `${name}.zip`;
    },
    printPdf: () => Promise.reject(new Error(t("mobilePdfLater"))),
    async saveText(token, text) {
      const { name } = take(token);
      const { path } = await vaults.exportText({ name, text });
      await share(send, { title: name, files: [fileUrl(path)] });
      return name;
    },
    async cancel(token) {
      const item = open.get(token);
      open.delete(token);
      if (item?.zip === true) await vaults.exportCancel({ token });
    },
  };
}

/** Send a copy: a note's Markdown, as its text and as its file, to the share sheet. */
export async function sendNoteCopy(
  vaults: NetherVaultsPlugin,
  send: ShareFiles,
  copy: NoteCopy,
): Promise<void> {
  const name = fileName(copy.name);
  const { path } = await vaults.exportText({ name, text: copy.text });
  await share(send, { title: name.replace(/\.md$/i, ""), text: copy.text, files: [fileUrl(path)] });
}

// The plugins in a vault's folders, `.nether/plugins/<id>/` (ADR 0058), and
// what this device approved of them. A plugin from a folder runs only when
// the vault has it on and this device approved its code, by the hash of
// its main.js, with the version and the permissions it asked for then. The
// approvals stay with the device, never in the vault, so a vault copied
// from elsewhere brings no approval with it.
import { type Manifest, type Permission, readManifest } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";

const root = ".nether/plugins";

/** A plugin folder as the vault has it. */
export interface FolderEntry {
  /** Its folder's name, which is its ID. */
  readonly folder: string;
  /** Its manifest, when it reads. */
  readonly manifest?: Manifest;
  /** Its manifest.json as it is, which the host reads again. */
  readonly raw?: unknown;
  /** Its main.js, and the SHA-256 hash of its bytes. */
  readonly code?: { readonly text: string; readonly hash: string };
  /** What keeps it from running, whatever is approved. */
  readonly problems: readonly string[];
}

/** What this device approved of a plugin from a folder. */
export interface Approval {
  readonly version: string;
  readonly hash: string;
  readonly permissions: readonly Permission[];
}

/** The plugins in the vault's folders, by folder, with what keeps each from running. */
export async function readFolders(
  vault: Vault,
  builtinIds: ReadonlySet<string>,
): Promise<readonly FolderEntry[]> {
  const paths = await vault.filesIn(root);
  const files = new Map<string, Set<string>>();
  for (const path of paths) {
    const [folder, file] = path.slice(root.length + 1).split("/");
    if (folder === undefined || file === undefined) continue;
    const there = files.get(folder) ?? new Set<string>();
    there.add(file);
    files.set(folder, there);
  }
  // A built-in plugin's folder with no manifest holds only its settings.
  const folders = [...files]
    .filter(([folder, there]) => !builtinIds.has(folder) || there.has("manifest.json"))
    .map(([folder]) => folder);
  return Promise.all(
    folders.sort().map(async (folder): Promise<FolderEntry> => {
      const [manifestFile, mainFile] = await Promise.all([
        vault.readFile(`${root}/${folder}/manifest.json`),
        vault.readFile(`${root}/${folder}/main.js`),
      ]);
      const problems: string[] = [];
      let raw: unknown;
      if (manifestFile.missing === true || manifestFile.binary === true) {
        problems.push("It has no manifest.json.");
      } else {
        try {
          raw = JSON.parse(manifestFile.text) as unknown;
        } catch {
          problems.push("Its manifest.json is not JSON.");
        }
      }
      const read = raw === undefined ? undefined : readManifest(raw);
      if (read !== undefined) problems.push(...(read.problems ?? []));
      const { manifest } = read ?? {};
      if (manifest !== undefined) {
        if (manifest.id !== folder) {
          problems.push(`Its manifest's id is ${manifest.id}, and its folder ${folder}.`);
        }
        if (builtinIds.has(manifest.id)) {
          problems.push(`A plugin that comes with the app is ${manifest.id}.`);
        }
      }
      const hasCode = mainFile.missing !== true && mainFile.binary !== true;
      if (!hasCode) problems.push("It has no main.js.");
      return {
        folder,
        ...(manifest === undefined ? {} : { manifest, raw }),
        ...(hasCode ? { code: { text: mainFile.text, hash: mainFile.hash } } : {}),
        problems,
      };
    }),
  );
}

/** Whether a plugin from a folder is as this device approved it. */
export function isApproved(entry: FolderEntry, approval: Approval | undefined): boolean {
  const { manifest, code } = entry;
  if (approval === undefined || manifest === undefined || code === undefined) return false;
  return (
    approval.hash === code.hash &&
    approval.version === manifest.version &&
    approval.permissions.length === manifest.permissions.length &&
    manifest.permissions.every((each) => approval.permissions.includes(each))
  );
}

/** The approval of a plugin from a folder as it is now; none for one that cannot run. */
export function approvalOf(entry: FolderEntry): Approval | undefined {
  const { manifest, code } = entry;
  if (manifest === undefined || code === undefined || entry.problems.length > 0) return undefined;
  return { version: manifest.version, hash: code.hash, permissions: manifest.permissions };
}

const approvalsKey = (vaultId: string) => `nether.pluginApprovals.${vaultId}`;

function isApproval(value: unknown): value is Approval {
  if (typeof value !== "object" || value === null) return false;
  const { version, hash, permissions } = value as Partial<Record<keyof Approval, unknown>>;
  return (
    typeof version === "string" &&
    typeof hash === "string" &&
    Array.isArray(permissions) &&
    permissions.every((each) => typeof each === "string")
  );
}

/** What this device approved of the vault's plugins from folders, by ID. */
export function readApprovals(vaultId: string): Readonly<Record<string, Approval>> {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(approvalsKey(vaultId)) ?? "{}");
  } catch {
    return {};
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, Approval] => isApproval(entry[1])),
  );
}

/** Keeps what this device approved; rejects with why it could not. */
export function writeApprovals(
  vaultId: string,
  approvals: Readonly<Record<string, Approval>>,
): void {
  localStorage.setItem(approvalsKey(vaultId), JSON.stringify(approvals));
}

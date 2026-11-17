// A vault's files as a capture is written into them (ADR 0087), apart from
// capture.ts, so the page's first load, which every backend's code is in,
// carries no more of capture than this.
import type { VaultFiles } from "@nether/storage";
import type { CaptureTarget } from "./capture.ts";

/**
 * A capture target over a vault's files, which the vault's index need not
 * have read: a new note goes in under a free name, numbered as an
 * attachment is, and `adopt` moves a shared file in.
 */
export function filesTarget(
  files: Pick<VaultFiles, "read" | "stat" | "write">,
  adopt: CaptureTarget["adopt"],
): CaptureTarget {
  return {
    async readData(name) {
      const file = await files.read(`.nether/${name}.json`);
      if (file.missing === true || file.binary === true) return undefined;
      try {
        return JSON.parse(file.text) as unknown;
      } catch {
        return undefined;
      }
    },
    async create(path, text) {
      const slash = path.lastIndexOf("/");
      const dot = path.lastIndexOf(".");
      const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
      // The first free name, numbered as attachments are: `Note 1.md`, `Note 2.md`.
      for (let n = 0; ; n++) {
        const target = n === 0 ? path : `${stem} ${String(n)}${ext}`;
        const [taken] = await files.stat([target]);
        if (taken === undefined) return (await files.write(target, text, "")).path;
      }
    },
    adopt,
  };
}

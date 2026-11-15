// What each build shows: every build shows sync, unless made with
// VITE_NETHER_SYNC=off; the web app shows sync and leaves out what a page
// in a browser cannot do.
import { describe, expect, it } from "vitest";
import { commandIds } from "../src/commands.ts";
import { build, commandShown, shownEntries, shownIn, syncShown } from "../src/features.ts";

describe("commandShown", () => {
  it("shows everything in a build made as releases are, sync included", () => {
    expect(syncShown).toBe(true);
    expect(build.web).toBe(false);
    expect(commandIds.filter(commandShown)).toEqual(commandIds);
  });

  it("leaves sync out of a build made with VITE_NETHER_SYNC=off", () => {
    const local = { web: false, sync: false };
    for (const id of ["servers", "sync", "members", "spaces", "share", "notifications"] as const) {
      expect(shownIn(local, id)).toBe(false);
    }
    expect(commandIds.filter((id) => shownIn(local, id))).toHaveLength(commandIds.length - 6);
    expect(shownIn(local, "newNote")).toBe(true);
  });

  it("shows the web app sync, without linking or updates", () => {
    const web = { web: true, sync: true };
    for (const id of [
      "servers",
      "members",
      "spaces",
      "share",
      "notifications",
      "export",
      "import",
    ] as const) {
      expect(shownIn(web, id)).toBe(true);
    }
    for (const id of ["sync", "checkUpdates", "updateChecks"] as const) {
      expect(shownIn(web, id)).toBe(false);
    }
    expect(commandIds.filter((id) => shownIn(web, id))).toHaveLength(commandIds.length - 3);
  });
});

describe("shownEntries", () => {
  it("leaves out what a build does not show, and the separators that strands", () => {
    const web = (id: (typeof commandIds)[number]) => shownIn({ web: true, sync: true }, id);
    expect(shownEntries(["newNote", "separator", "sync", "separator", "closeVault"], web)).toEqual([
      "newNote",
      "separator",
      "closeVault",
    ]);
    expect(
      shownEntries(["templateSettings", "separator", "checkUpdates", "updateChecks"], web),
    ).toEqual(["templateSettings"]);
    expect(shownEntries(["separator", "sync", "separator", "newNote"], web)).toEqual(["newNote"]);
  });
});

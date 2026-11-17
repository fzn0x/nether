// What each build shows: every build shows sync, unless made with
// VITE_NETHER_SYNC=off; the web app shows sync and leaves out what a page
// in a browser cannot do; only the mobile apps send a note's copy.
import { describe, expect, it } from "vitest";
import { commandIds } from "../src/commands.ts";
import { build, commandShown, shownEntries, shownIn, syncShown } from "../src/features.ts";

describe("commandShown", () => {
  it("shows everything in a build made as releases are, sync included, but the phones' own", () => {
    expect(syncShown).toBe(true);
    expect(build.web).toBe(false);
    expect(commandIds.filter(commandShown)).toEqual(commandIds.filter((id) => id !== "sendCopy"));
  });

  it("leaves sync out of a build made with VITE_NETHER_SYNC=off", () => {
    const local = { web: false, sync: false };
    for (const id of [
      "servers",
      "sync",
      "members",
      "spaces",
      "share",
      "notifications",
      "webhooks",
      "apiTokens",
    ] as const) {
      expect(shownIn(local, id)).toBe(false);
    }
    expect(commandIds.filter((id) => shownIn(local, id))).toHaveLength(commandIds.length - 9);
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
      "webhooks",
      "apiTokens",
      "export",
      "import",
    ] as const) {
      expect(shownIn(web, id)).toBe(true);
    }
    for (const id of ["sync", "checkUpdates", "updateChecks", "sendCopy"] as const) {
      expect(shownIn(web, id)).toBe(false);
    }
    expect(commandIds.filter((id) => shownIn(web, id))).toHaveLength(commandIds.length - 4);
  });

  it("leaves out of the mobile apps what comes to them later, and what stays on the desktop", () => {
    const phone = { web: false, sync: true, mobile: true };
    for (const id of [
      "openGraph",
      "newCanvas",
      "checkUpdates",
      "updateChecks",
      "webhooks",
      "apiTokens",
    ] as const) {
      expect(shownIn(phone, id)).toBe(false);
    }
    // The phones sign in and sync (ADR 0087, part 4).
    for (const id of [
      "newNote",
      "import",
      "search",
      "appearance",
      "closeVault",
      "servers",
      "sync",
      "share",
      "members",
      "spaces",
      "notifications",
      // Exports and a note's copy go to the share sheet (ADR 0087, part 5).
      "export",
      "sendCopy",
    ] as const) {
      expect(shownIn(phone, id)).toBe(true);
    }
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

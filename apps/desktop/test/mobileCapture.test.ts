// What the phone hands the page (ADR 0087): the app icon's shortcuts and
// the share sheet's inbox, each capture handed once, the shortcut that
// started the app kept until the page listens, and a capture's files moved
// into the vault under free names without crossing the bridge.
import { describe, expect, it, vi } from "vitest";
import type { Capture } from "../src/capture.ts";
import type { InboxCapture, NetherInboxPlugin, NetherVaultsPlugin } from "../src/mobile.ts";
import {
  type PhoneCaptureParts,
  adoptFile,
  phoneCaptures,
  sharedOf,
  shortcutsOf,
} from "../src/mobileCapture.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The plugins, stood in for: the inbox's captures, and the shortcuts' click listener. */
function parts(platform: string, captures: InboxCapture[]) {
  let click: ((event: { shortcutId: string }) => void) | undefined;
  let shared: (() => void) | undefined;
  let resumed: (() => void) | undefined;
  const dropped: string[] = [];
  const set = vi.fn(() => Promise.resolve());
  const minimize = vi.fn();
  const rescan = vi.fn();
  const inbox = {
    pending: () => Promise.resolve({ captures: [...captures] }),
    drop: ({ id }: { id: string }) => {
      dropped.push(id);
      return Promise.resolve();
    },
    addListener: (_event: "shared", listener: () => void) => {
      shared = listener;
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  } as NetherInboxPlugin;
  const given: PhoneCaptureParts = {
    inbox,
    vaults: {} as NetherVaultsPlugin,
    shortcuts: {
      set,
      addListener: (_event: "click", listener: (event: { shortcutId: string }) => void) => {
        click = listener;
        return Promise.resolve({ remove: () => Promise.resolve() });
      },
    },
    platform,
    onResume(listener) {
      resumed = listener;
      return () => undefined;
    },
    rescan,
    minimize,
  };
  return {
    given,
    dropped,
    set,
    minimize,
    rescan,
    click: (id: string) => click?.({ shortcutId: id }),
    shared: () => shared?.(),
    resumed: () => resumed?.(),
  };
}

const share: InboxCapture = {
  id: "1",
  at: 5,
  text: "https://example.org",
  title: "Example",
  files: [{ name: "a.png", type: "image/png", path: "/inbox/1/a.png" }],
};

describe("phoneCaptures", () => {
  it("keeps the shortcut that started the app until the page listens, and leaves others out", async () => {
    const phone = parts("android", []);
    const captures = phoneCaptures(phone.given);
    phone.click("capture");
    phone.click("export");
    const got: Capture[] = [];
    captures.listen((capture) => got.push(capture));
    phone.click("dayNote");
    await tick();
    expect(got).toEqual([
      { kind: "shortcut", shortcut: "capture" },
      { kind: "shortcut", shortcut: "dayNote" },
    ]);
  });

  it("hands each share of the inbox once, as Android tells of one and as the app comes back", async () => {
    const inbox: InboxCapture[] = [share];
    const phone = parts("android", inbox);
    const captures = phoneCaptures(phone.given);
    const got: Capture[] = [];
    captures.listen((capture) => got.push(capture));
    await tick();
    inbox.push({ id: "2", at: 6, files: [], vault: "", newVault: "" });
    phone.shared();
    await tick();
    phone.resumed();
    await tick();
    expect(got).toEqual([
      { kind: "shared", shared: sharedOf(share) },
      { kind: "shared", shared: { id: "2", at: 6, text: "", files: [] } },
    ]);
    await captures.done("1");
    expect(phone.dropped).toEqual(["1"]);
    expect(captures.leave).toBe(phone.given.minimize);
  });

  it("reads iOS's inbox as the app comes back, and never puts the app away", async () => {
    const inbox: InboxCapture[] = [];
    const phone = parts("ios", inbox);
    const captures = phoneCaptures(phone.given);
    const got: Capture[] = [];
    captures.listen((capture) => got.push(capture));
    inbox.push({ ...share, vault: "v1" });
    phone.resumed();
    await tick();
    expect(got).toEqual([{ kind: "shared", shared: { ...sharedOf(share), vault: "v1" } }]);
    expect(captures.leave).toBeUndefined();
    captures.filed("v1");
    expect(phone.rescan).toHaveBeenCalledWith("v1");
  });

  it("gives the app icon its shortcuts, with icons for each system", async () => {
    const phone = parts("android", []);
    const captures = phoneCaptures(phone.given);
    await captures.setShortcuts([
      { id: "capture", title: "Capture", description: "Capture a note" },
    ]);
    expect(phone.set).toHaveBeenCalledWith({
      shortcuts: [
        {
          id: "capture",
          title: "Capture",
          description: "Capture a note",
          androidIcon: "ic_menu_edit",
          iosIcon: "square.and.pencil",
        },
      ],
    });
    expect(shortcutsOf([]).length).toBe(0);
  });
});

describe("adoptFile", () => {
  it("moves a file in under the first free name, numbered as attachments are", async () => {
    const asked: string[] = [];
    const vaults = {
      adopt({ path }: { path: string }) {
        asked.push(path);
        return Promise.resolve(
          path === "Inbox/a 2.png"
            ? { result: "written" as const, file: { path, size: 1, modified: 1 } }
            : { result: "exists" as const },
        );
      },
    } as unknown as NetherVaultsPlugin;
    expect(await adoptFile(vaults, "v1", "Inbox/a.png", "/inbox/1/a.png")).toBe("Inbox/a 2.png");
    expect(asked).toEqual(["Inbox/a.png", "Inbox/a 1.png", "Inbox/a 2.png"]);
    const silent = {
      adopt: () => Promise.resolve({ result: "written" as const }),
    } as unknown as NetherVaultsPlugin;
    await expect(adoptFile(silent, "v1", "Inbox/b", "/x")).rejects.toThrow("gave nothing back");
  });
});

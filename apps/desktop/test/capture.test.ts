// Quick capture and the share sheet (ADR 0087): the note each capture
// becomes in its vault's capture folder, its title, its properties, and its
// files attached beside it, written without the vault's index.
import { MemoryFiles } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  type CaptureContent,
  captureFolder,
  captureMarkdown,
  captureTitle,
  cleanCaptureFolder,
  fileCapture,
  isCaptureShortcut,
  localStamp,
  sharedFileName,
  splitLink,
} from "../src/capture.ts";
import { filesTarget } from "../src/captureFiles.ts";

const at = new Date(2026, 10, 17, 9, 5);

function content(given: Partial<CaptureContent>): CaptureContent {
  return { text: "", files: [], ...given };
}

describe("captureFolder", () => {
  it("is Inbox unless the vault's settings name another", () => {
    expect(captureFolder(undefined)).toBe("Inbox");
    expect(captureFolder({})).toBe("Inbox");
    expect(captureFolder({ folder: 3 })).toBe("Inbox");
    expect(captureFolder({ folder: "  " })).toBe("Inbox");
    expect(captureFolder({ folder: "/Notes/Captured/" })).toBe("Notes/Captured");
  });

  it("names folders a file system and a link hold", () => {
    expect(cleanCaptureFolder(" In:box / Later ")).toBe("In box/Later");
    expect(cleanCaptureFolder("//")).toBe("");
  });
});

describe("splitLink", () => {
  it("keeps a link given apart, and finds one in the text", () => {
    expect(splitLink({ text: "Read", url: " https://example.org/a " })).toEqual({
      text: "Read",
      url: "https://example.org/a",
    });
    expect(splitLink({ text: "See https://example.org/a. Later" })).toEqual({
      text: "See https://example.org/a. Later",
      url: "https://example.org/a",
    });
  });

  it("leaves no text when the text was only the link", () => {
    expect(splitLink({ text: " https://example.org/a\n" })).toEqual({
      text: "",
      url: "https://example.org/a",
    });
    expect(splitLink({ text: "No link here" })).toEqual({ text: "No link here" });
  });
});

describe("captureTitle", () => {
  it("is the shared page's title, then the text's first line, then the time", () => {
    expect(captureTitle(content({ title: "A page", text: "Words" }), "Capture 1")).toBe("A page");
    expect(captureTitle(content({ text: "\n# Groceries: milk\n- eggs" }), "Capture 1")).toBe(
      "Groceries milk",
    );
    expect(captureTitle(content({ text: "- [ ] Call Ada" }), "Capture 1")).toBe("Call Ada");
    expect(captureTitle(content({ text: "https://example.org" }), "Capture 1")).toBe("Capture 1");
    expect(captureTitle(content({ title: " / " }), "Capture 09.05")).toBe("Capture 09.05");
    expect(captureTitle(content({}), "")).toBe("Capture");
  });

  it("is never too long for a file's name", () => {
    const title = captureTitle(content({ text: "word ".repeat(60) }), "");
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith(" ")).toBe(false);
  });
});

describe("sharedFileName", () => {
  it("keeps a file's own name without what links cannot hold", () => {
    const file = { name: "Plan [v2]: final.pdf", type: "application/pdf", path: "x" };
    expect(sharedFileName(file, "Note 1")).toBe("Plan -v2-- final.pdf");
    expect(sharedFileName({ ...file, name: "..hidden" }, "Note 1")).toBe("hidden");
  });

  it("names a nameless file after its note, by its type", () => {
    expect(sharedFileName({ name: "", type: "image/jpeg", path: "x" }, "Note 1")).toBe(
      "Note 1.jpg",
    );
    expect(sharedFileName({ name: "", type: "", path: "x" }, "Note 1")).toBe("Note 1");
  });
});

describe("captureMarkdown", () => {
  it("gives a link's source and the time, then the text and the link", () => {
    expect(localStamp(at)).toBe("2026-11-17T09:05");
    expect(captureMarkdown(content({ text: "Worth a read", url: "https://example.org/a" }), [], at))
      .toBe(`---
source: https://example.org/a
created: 2026-11-17T09:05
---
Worth a read

<https://example.org/a>
`);
  });

  it("leaves the link out of the text that holds it, and embeds each file", () => {
    expect(
      captureMarkdown(
        content({ text: "See https://example.org/a" }),
        ["Inbox/photo.jpg", "Inbox/plan.pdf"],
        at,
      ),
    ).toBe(`---
source: https://example.org/a
created: 2026-11-17T09:05
---
See https://example.org/a

![[Inbox/photo.jpg]]
![[Inbox/plan.pdf]]
`);
    expect(captureMarkdown(content({}), [], at)).toBe("---\ncreated: 2026-11-17T09:05\n---\n");
  });
});

describe("fileCapture", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("writes a new note in the capture folder, its files beside it, under free names", async () => {
    const files = new MemoryFiles({ "Inbox/Milk.md": "Already here\n" });
    const adopted: string[] = [];
    const target = filesTarget(files, async (path, file) => {
      adopted.push(file.path);
      return (await files.attach(path, bytes(file.path))).path;
    });
    const shared = content({
      text: "Milk\nand eggs",
      files: [
        { name: "photo.jpg", type: "image/jpeg", path: "cache/1" },
        { name: "", type: "image/png", path: "cache/2" },
      ],
    });
    const path = await fileCapture(target, shared, at, "Capture 09.05");
    expect(path).toBe("Inbox/Milk 1.md");
    expect(adopted).toEqual(["cache/1", "cache/2"]);
    const note = await files.read(path);
    expect(note.text).toContain("Milk\nand eggs\n\n![[Inbox/photo.jpg]]\n![[Inbox/Milk 2.png]]\n");
    expect((await files.read("Inbox/Milk 2.png")).missing).not.toBe(true);
  });

  it("goes to the folder the vault's settings name", async () => {
    const files = new MemoryFiles({
      ".nether/capture.json": JSON.stringify({ folder: "Captured" }),
    });
    const target = filesTarget(files, () => Promise.reject(new Error("No files.")));
    expect(await fileCapture(target, content({ text: "Idea" }), at, "x")).toBe("Captured/Idea.md");
    const unreadable = new MemoryFiles({ ".nether/capture.json": "{" });
    expect(await filesTarget(unreadable, () => Promise.resolve("")).readData("capture")).toBe(
      undefined,
    );
  });
});

describe("isCaptureShortcut", () => {
  it("knows the app icon's four shortcuts", () => {
    expect(["capture", "newNote", "dayNote", "search"].every(isCaptureShortcut)).toBe(true);
    expect(isCaptureShortcut("export")).toBe(false);
  });
});

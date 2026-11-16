// @vitest-environment jsdom
// Plugins' blocks (ADR 0055): a plugin block shows as the app has its
// plugin show it, and changes what it holds as an edit of the note; the
// slash menu inserts plugins' code blocks and blocks.
import type { BlockId, ContentBlock, JsonObject } from "@nether/core";
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { entryCommand } from "../src/commands.ts";
import type { NoteLinks } from "../src/LinkMenu.tsx";
import { NoteEditor } from "../src/NoteEditor.tsx";
import { netherExtensions } from "../src/schema.ts";
import { fromEditor } from "../src/convert.ts";

// React's act, outside a test renderer, asks to be told it runs in one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tally: ContentBlock = {
  id: "t1" as BlockId,
  type: "tally-app/tally",
  attrs: { count: 1 },
  content: [{ type: "text", text: "Visitors" }],
};

async function mount(links: NoteLinks | undefined, editable = true) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const changes: ContentBlock[][] = [];
  await act(async () => {
    root.render(
      <NoteEditor
        blocks={[tally]}
        label="A note"
        editable={editable}
        {...(links === undefined ? {} : { links })}
        onChange={(blocks) => {
          changes.push(blocks);
        }}
      />,
    );
    // Node views draw once the editor has.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return { container, changes };
}

/** Links that show a tally as a button counting up, and say how it was shown. */
function tallyLinks(seen: { type?: string; editable?: boolean }): NoteLinks {
  return {
    suggest: () => [],
    open: () => undefined,
    renderBlock: (type, attrs, editable, setAttrs) => {
      seen.type = type;
      seen.editable = editable;
      const count = typeof attrs.count === "number" ? attrs.count : 0;
      return (
        <button
          type="button"
          onClick={() => {
            setAttrs({ count: count + 1 });
          }}
        >
          {String(count)}
        </button>
      );
    },
  };
}

describe("a plugin's block", () => {
  it("shows as its plugin shows it, and changes what it holds as an edit of the note", async () => {
    const seen: { type?: string; editable?: boolean } = {};
    const { container, changes } = await mount(tallyLinks(seen));
    const button = container.querySelector<HTMLButtonElement>(".plugin-block button");
    expect(button?.textContent).toBe("1");
    expect(seen).toEqual({ type: "tally-app/tally", editable: true });
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector(".plugin-block button")?.textContent).toBe("2");
    // Its text stays as it was.
    expect(changes.at(-1)).toEqual([{ ...tally, attrs: { count: 2 } }]);
  });

  it("says when the note cannot be changed here", async () => {
    const seen: { type?: string; editable?: boolean } = {};
    await mount(tallyLinks(seen), false);
    expect(seen.editable).toBe(false);
  });

  it("says what type it is when nothing here shows it", async () => {
    const { container } = await mount(undefined);
    expect(container.querySelector(".plugin-missing")?.textContent).toBe(
      "No plugin here shows this block: tally-app/tally",
    );
  });
});

describe("plugins' slash entries", () => {
  function inserted(insert: Parameters<typeof entryCommand>[0]["insert"]): ContentBlock[] {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: netherExtensions({}),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editor.commands.setTextSelection(1);
    const command = entryCommand({ id: "x", title: "X", keywords: "", insert });
    command.run(editor);
    const blocks = fromEditor(editor.getJSON(), () => "n" as BlockId);
    editor.destroy();
    return blocks.filter((block) => block.type !== "paragraph");
  }

  it("insert a code block in a language a plugin draws, with its text", () => {
    expect(inserted({ codeBlock: "mermaid", text: "flowchart LR" })).toMatchObject([
      { type: "code", attrs: { language: "mermaid" }, text: "flowchart LR" },
    ]);
    expect(inserted({ codeBlock: "abc", text: "" })).toMatchObject([
      { type: "code", attrs: { language: "abc" }, text: "" },
    ]);
  });

  it("insert a plugin's block, holding what a new one holds", () => {
    const attrs: JsonObject = { count: 0 };
    expect(inserted({ pluginBlock: "tally-app/tally", attrs })).toMatchObject([
      { type: "tally-app/tally", attrs: { count: 0 } },
    ]);
  });
});

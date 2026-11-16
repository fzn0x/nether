// @vitest-environment jsdom
// Writing assist in the editor (ADR 0069): what it works on, the selection
// or the caret's block, highlighted while it shows; and a reply put in its
// place or after it as one edit of the note's document, which one undo
// takes out, landing where the text went through others' edits, and
// nowhere once the text is gone.
import { type BlockId, type ContentBlock, newBlockId } from "@nether/core";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AssistSelection, NoteAssistView } from "../src/assist.ts";
import type { CommentAnchor } from "../src/comments.ts";
import { documentBlocks, setDocumentBlocks } from "../src/document.ts";
import { NoteEditor } from "../src/NoteEditor.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => undefined;

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const paragraph = (id: string, text: string): ContentBlock => ({
  id: id as BlockId,
  type: "paragraph",
  content: [{ type: "text", text }],
});

function noteDocument(): Y.Doc {
  const document = new Y.Doc();
  setDocumentBlocks(document, [paragraph("one", "Plan the launch"), paragraph("two", "Then rest")]);
  return document;
}

/** The note's paragraphs' text, as its document holds them. */
function texts(document: Y.Doc): string[] {
  return documentBlocks(document, newBlockId).map((block) =>
    "content" in block && Array.isArray(block.content)
      ? block.content.map((inline: { text?: string }) => inline.text ?? "").join("")
      : block.type,
  );
}

function mount(document: Y.Doc) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const asked: (AssistSelection | undefined)[] = [];
  const show = (view: Partial<NoteAssistView>) => {
    act(() => {
      root.render(
        <NoteEditor
          document={document}
          label="Note"
          assist={{
            request: 0,
            active: undefined,
            onAssist: (selection) => asked.push(selection),
            ...view,
          }}
        />,
      );
    });
  };
  show({});
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  const editor = () => {
    const element = container.querySelector<Element & { editor?: Editor }>(".ProseMirror");
    const found = element?.editor;
    if (found === undefined) throw new Error("No editor");
    return found;
  };
  /** Asks the editor for what to work on, as the app's command does. */
  let requests = 0;
  const ask = (): AssistSelection | undefined => {
    requests++;
    show({ request: requests });
    return asked.at(-1);
  };
  return { container, show, editor, ask, asked };
}

function select(editor: Editor, text: string): void {
  let from: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (from !== undefined) return false;
    const index = node.isText ? (node.text ?? "").indexOf(text) : -1;
    if (index >= 0) from = pos + index;
    return true;
  });
  if (from === undefined) throw new Error(`No ${text} in the note`);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + text.length)),
  );
}

function must(selection: AssistSelection | undefined): AssistSelection {
  if (selection === undefined) throw new Error("Nothing to work on");
  return selection;
}

describe("writing assist in the editor", () => {
  it("works on the selection, and puts a reply in its place as one undoable edit", () => {
    const document = noteDocument();
    const { editor, ask } = mount(document);
    select(editor(), "the launch");
    const selection = must(ask());
    expect(selection.anchor.quote).toBe("the launch");
    expect(selection.blocks).toMatchObject([
      { type: "paragraph", content: [{ type: "text", text: "the launch" }] },
    ]);

    act(() => {
      expect(selection.apply([paragraph("new", "our **product**")], "replace")).toBe(true);
    });
    expect(texts(document)).toEqual(["Plan our **product**", "Then rest"]);
    // The reply's paragraph joined the text it replaced; one undo takes it out.
    act(() => {
      editor().commands.undo();
    });
    expect(texts(document)).toEqual(["Plan the launch", "Then rest"]);
  });

  it("puts a reply after the block the text ends in, keeping the text", () => {
    const document = noteDocument();
    const { editor, ask } = mount(document);
    select(editor(), "launch");
    const selection = must(ask());
    act(() => {
      selection.apply(
        [paragraph("a", "In short: ship it."), paragraph("b", "Then party.")],
        "after",
      );
    });
    expect(texts(document)).toEqual([
      "Plan the launch",
      "In short: ship it.",
      "Then party.",
      "Then rest",
    ]);
    act(() => {
      editor().commands.undo();
    });
    expect(texts(document)).toEqual(["Plan the launch", "Then rest"]);
  });

  it("replaces text with several blocks, splitting the block it was in", () => {
    const document = noteDocument();
    const { editor, ask } = mount(document);
    select(editor(), "the");
    const selection = must(ask());
    act(() => {
      selection.apply([paragraph("a", "one"), paragraph("b", "two")], "replace");
    });
    expect(texts(document).join(" | ")).toContain("one");
    expect(texts(document).join(" | ")).toContain("two");
    expect(texts(document).at(-1)).toBe("Then rest");
    expect(editor().state.doc.textContent).not.toContain("the");
  });

  it("keeps a heading a heading, whether the reply is one or not", () => {
    const document = new Y.Doc();
    setDocumentBlocks(document, [
      {
        id: "h" as BlockId,
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Welcome home" }],
      },
      paragraph("p", "Body"),
    ]);
    const { editor, ask } = mount(document);
    select(editor(), "Welcome home");
    const selection = must(ask());
    expect(selection.blocks).toMatchObject([{ type: "heading", attrs: { level: 1 } }]);
    act(() => {
      selection.apply(
        [
          {
            id: "x" as BlockId,
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Hello" }],
          },
        ],
        "replace",
      );
    });
    expect(documentBlocks(document, newBlockId)).toMatchObject([
      { id: "h", type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hello" }] },
      { type: "paragraph" },
    ]);
  });

  it("keeps typing before it apart in the undo history", () => {
    const document = noteDocument();
    const { editor, ask } = mount(document);
    select(editor(), "rest");
    const selection = must(ask());
    act(() => {
      const view = editor().view;
      view.dispatch(view.state.tr.insertText("Now: ", 1));
      selection.apply([paragraph("x", "sleep")], "replace");
    });
    expect(texts(document)).toEqual(["Now: Plan the launch", "Then sleep"]);
    act(() => {
      editor().commands.undo();
    });
    expect(texts(document)).toEqual(["Now: Plan the launch", "Then rest"]);
  });

  it("lands where the text went through another's edit, and nowhere once it is gone", () => {
    const document = noteDocument();
    const elsewhere = new Y.Doc();
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(document));
    const { editor, ask } = mount(document);
    select(editor(), "launch");
    const selection = must(ask());
    // Someone else types at the start of the note while the reply streams.
    const first = elsewhere.getXmlFragment("content").get(0) as Y.XmlElement;
    (first.get(0) as Y.XmlText).insert(0, "First, ");
    act(() => {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(elsewhere), "server");
    });
    act(() => {
      expect(selection.apply([paragraph("x", "party")], "replace")).toBe(true);
    });
    expect(texts(document)[0]).toBe("First, Plan the party");

    // Text deleted meanwhile takes no reply.
    select(editor(), "rest");
    const gone = must(ask());
    act(() => {
      const view = editor().view;
      const range = view.state.selection;
      view.dispatch(view.state.tr.delete(range.from, range.to));
    });
    let applied = true;
    act(() => {
      applied = gone.apply([paragraph("x", "sleep")], "replace");
    });
    expect(applied).toBe(false);
    expect(gone.apply([], "after")).toBe(false);
    expect(texts(document)[1]).toBe("Then ");
  });

  it("works on the caret's block with nothing selected, and on nothing in an empty one", () => {
    const document = new Y.Doc();
    setDocumentBlocks(document, [paragraph("one", "Plan the launch"), paragraph("two", "")]);
    const { editor, ask } = mount(document);
    const view = editor().view;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(must(ask()).anchor.quote).toBe("Plan the launch");
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    expect(ask()).toBeUndefined();
  });

  it("highlights the text it works on while the app shows it", () => {
    const document = noteDocument();
    const { container, editor, ask, show } = mount(document);
    select(editor(), "the launch");
    const anchor: CommentAnchor = must(ask()).anchor;
    show({ request: 1, active: anchor });
    expect(container.querySelector(".assist-highlight")?.textContent).toBe("the launch");
    act(() => {
      editor().view.dispatch(editor().state.tr.insertText("Now ", 1));
    });
    expect(container.querySelector(".assist-highlight")?.textContent).toBe("the launch");
    show({ request: 1, active: undefined });
    expect(container.querySelector(".assist-highlight")).toBeNull();
  });

  it("gives focus back to the editor", () => {
    const document = noteDocument();
    const { editor, ask } = mount(document);
    select(editor(), "launch");
    const selection = must(ask());
    (window.document.activeElement as HTMLElement | null)?.blur();
    selection.focus();
    expect(editor().view.hasFocus()).toBe(true);
  });
});

// The bar above the on-screen keyboard on a phone (ADR 0087): what a
// keyboard's shortcuts and the block handle do on a desktop, as buttons a
// finger reaches. It inserts a block or a link, marks text bold, italic or
// as code, makes lists, indents them, moves the block with the caret up or
// down, duplicates or deletes it, undoes and redoes, and puts the keyboard
// away, as a phone has no room for the block's handle beside it. It shows
// while the editor has the focus, and its buttons leave the focus there, so
// the keyboard stays. One tab stop, the arrow keys moving along it, as a
// toolbar has.
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  CopyPlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  KeyboardOff,
  Link,
  List,
  ListTodo,
  type LucideIcon,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { type BlockAt, currentBlock, deleteBlock, duplicateBlock, moveBlock } from "./actions.ts";
import type { EditorWords } from "./words.ts";

interface BarAction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Whether it is on where the caret is, for a mark or a list. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly run: () => void;
}

/** Text typed at the caret, after a space where the text before it needs one, as `/` does. */
function typeAtCaret(editor: Editor, text: string, spaced: boolean): void {
  const { $from } = editor.state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, " ");
  const space = spaced && before !== "" && !/\s$/.test(before) ? " " : "";
  editor
    .chain()
    .focus()
    .insertContent(space + text)
    .run();
}

/** The list item the caret is in: a task's, or a bullet's or a number's. */
function itemType(editor: Editor): "taskItem" | "listItem" {
  return editor.isActive("taskItem") ? "taskItem" : "listItem";
}

export default function KeyboardBar(props: {
  readonly editor: Editor;
  readonly words: EditorWords;
}) {
  const { editor, words } = props;
  const bar = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);

  // What the buttons show, worked out again as the caret or the text changes.
  const now = useEditorState({
    editor,
    selector: ({ editor: shown }) => ({
      bold: shown.isActive("bold"),
      italic: shown.isActive("italic"),
      code: shown.isActive("code"),
      bulletList: shown.isActive("bulletList"),
      taskList: shown.isActive("taskList"),
      sink: shown.can().sinkListItem(itemType(shown)),
      lift: shown.can().liftListItem(itemType(shown)),
      undo: shown.can().undo(),
      redo: shown.can().redo(),
    }),
  });

  /** Acts on the block with the caret, as the block menu does on the block beside its handle. */
  const onBlock = (action: (block: BlockAt) => void) => () => {
    const block = currentBlock(editor);
    if (block !== null) action(block);
  };
  const move = (direction: -1 | 1) => onBlock((block) => moveBlock(editor, block.pos, direction));

  const actions: readonly BarAction[] = [
    {
      id: "block",
      label: words.insertBlock,
      icon: Plus,
      run: () => {
        typeAtCaret(editor, "/", true);
      },
    },
    {
      id: "link",
      label: words.linkNote,
      icon: Link,
      run: () => {
        typeAtCaret(editor, "[[", false);
      },
    },
    {
      id: "bold",
      label: words.bold,
      icon: Bold,
      pressed: now.bold,
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      id: "italic",
      label: words.italic,
      icon: Italic,
      pressed: now.italic,
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      id: "code",
      label: words.inlineCode,
      icon: Code,
      pressed: now.code,
      run: () => editor.chain().focus().toggleCode().run(),
    },
    {
      id: "bulletList",
      label: words.blocks.bulletList.title,
      icon: List,
      pressed: now.bulletList,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: "taskList",
      label: words.blocks.taskList.title,
      icon: ListTodo,
      pressed: now.taskList,
      run: () => editor.chain().focus().toggleTaskList().run(),
    },
    {
      id: "indent",
      label: words.indent,
      icon: IndentIncrease,
      disabled: !now.sink,
      run: () => editor.chain().focus().sinkListItem(itemType(editor)).run(),
    },
    {
      id: "outdent",
      label: words.outdent,
      icon: IndentDecrease,
      disabled: !now.lift,
      run: () => editor.chain().focus().liftListItem(itemType(editor)).run(),
    },
    { id: "up", label: words.moveUp, icon: ArrowUp, run: move(-1) },
    { id: "down", label: words.moveDown, icon: ArrowDown, run: move(1) },
    {
      id: "duplicate",
      label: words.duplicate,
      icon: CopyPlus,
      run: onBlock((block) => duplicateBlock(editor, block.pos)),
    },
    {
      id: "delete",
      label: words.remove,
      icon: Trash2,
      run: onBlock((block) => deleteBlock(editor, block.pos)),
    },
    {
      id: "undo",
      label: words.undo,
      icon: Undo2,
      disabled: !now.undo,
      run: () => editor.chain().focus().undo().run(),
    },
    {
      id: "redo",
      label: words.redo,
      icon: Redo2,
      disabled: !now.redo,
      run: () => editor.chain().focus().redo().run(),
    },
    {
      id: "done",
      label: words.hideKeyboard,
      icon: KeyboardOff,
      run: () => {
        editor.commands.blur();
      },
    },
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step =
      event.key === (rtl ? "ArrowLeft" : "ArrowRight")
        ? 1
        : event.key === (rtl ? "ArrowRight" : "ArrowLeft")
          ? -1
          : 0;
    let next: number | undefined;
    if (step !== 0) next = (current + step + actions.length) % actions.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = actions.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setCurrent(next);
    bar.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div
      ref={bar}
      className="keyboard-bar"
      role="toolbar"
      aria-label={words.keyboardBar}
      onKeyDown={onKeyDown}
    >
      {actions.map((action, index) => (
        <button
          key={action.id}
          type="button"
          aria-label={action.label}
          aria-pressed={action.pressed}
          aria-disabled={action.disabled === true ? true : undefined}
          tabIndex={index === current ? 0 : -1}
          // A press leaves the focus in the editor, so the keyboard stays up.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            setCurrent(index);
            if (action.disabled !== true) action.run();
          }}
        >
          <action.icon size={20} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

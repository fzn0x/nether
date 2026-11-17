// Writing assist in the editor (ADR 0069). The app asks for what the assist
// works on: the selection, or with nothing selected the block the caret is
// in, as blocks, with its place held as Yjs relative positions in the
// note's document, so the place follows the text through edits made while
// a reply streams in. That text stays highlighted while the assist shows.
// The reply goes in as one edit of the editor, so it reaches the note's
// document as typing does, and one undo takes it out.
import { type BlockId, type ContentBlock, newBlockId } from "@nether/core";
import { type Editor, Extension, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import { anchorRange, selectionAnchor } from "./commentHighlights.ts";
import type { CommentAnchor } from "./comments.ts";
import { blocksToEditor, fromEditor, inlinesToEditor } from "./convert.ts";

/** Whether a reply takes the place of the text it was asked about, or goes after it. */
export type AssistPlacement = "replace" | "after";

/** What the assist works on, and how its reply goes into the note. */
export interface AssistSelection {
  /** Where the text is, as it follows everyone's edits. */
  readonly anchor: CommentAnchor;
  /** The text, cut from the note as blocks. */
  readonly blocks: readonly ContentBlock[];
  /**
   * Puts blocks in the text's place, or after the block it ends in, as one
   * edit that one undo takes out. False, changing nothing, when the text
   * is gone, as when someone deleted it meanwhile.
   */
  apply(blocks: readonly ContentBlock[], placement: AssistPlacement): boolean;
  /** Gives the editor focus again, as when the assist closes. */
  focus(): void;
}

/** Writing assist in a note's editor, with its `document`. */
export interface NoteAssistView {
  /** Changes when the app asks to assist on the selection, as its command does. */
  readonly request: number;
  /** Called with what to work on; undefined when the caret is where there is no text. */
  readonly onAssist: (selection: AssistSelection | undefined) => void;
  /** The text being worked on, highlighted while the assist shows; undefined when it does not. */
  readonly active: CommentAnchor | undefined;
}

export const assistHighlightKey = new PluginKey<DecorationSet>("assistHighlight");

function decorate(state: EditorState, anchor: CommentAnchor | undefined): DecorationSet {
  const range = anchor === undefined ? undefined : anchorRange(state, anchor);
  return DecorationSet.create(
    state.doc,
    range === undefined
      ? []
      : [Decoration.inline(range.from, range.to, { class: "assist-highlight" })],
  );
}

/** Highlights the text the assist works on, through edits, while the app shows it. */
export const AssistHighlight = Extension.create({
  name: "assistHighlight",

  addProseMirrorPlugins() {
    let anchor: CommentAnchor | undefined;
    return [
      new Plugin<DecorationSet>({
        key: assistHighlightKey,
        state: {
          init: (_config, state) => DecorationSet.create(state.doc, []),
          apply: (tr, value, _old, state) => {
            const shown = tr.getMeta(assistHighlightKey) as
              { readonly anchor: CommentAnchor | undefined } | undefined;
            if (shown !== undefined) {
              anchor = shown.anchor;
              return decorate(state, anchor);
            }
            if (!tr.docChanged) return value;
            // The note's document changed: the text is found anew. Edits made
            // here, not yet in the document, move it as they move the text.
            const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: unknown } | undefined;
            return sync?.isChangeOrigin === true
              ? decorate(state, anchor)
              : value.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => assistHighlightKey.getState(state) },
      }),
    ];
  },
});

/** The editor's nodes for blocks, as the schema makes them. */
function nodesOf(editor: Editor, blocks: readonly ContentBlock[]): ProseMirrorNode[] {
  return blocksToEditor(blocks).map((json) => editor.schema.nodeFromJSON(json));
}

/** Puts a reply in the note as one edit; false when the text it was asked about is gone. */
export function applyAssist(
  editor: Editor,
  anchor: CommentAnchor,
  blocks: readonly ContentBlock[],
  placement: AssistPlacement,
): boolean {
  const { state } = editor;
  const range = anchorRange(state, anchor);
  if (range === undefined || blocks.length === 0) return false;
  const tr = state.tr;
  const [only] = blocks;
  const $from = state.doc.resolve(range.from);
  const $to = state.doc.resolve(range.to);
  if (placement === "after") {
    // After the block the text ends in, at the top of the note.
    const after = $to.depth === 0 ? range.to : $to.after(1);
    tr.insert(after, nodesOf(editor, blocks));
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
  } else if (
    blocks.length === 1 &&
    (only?.type === "paragraph" || only?.type === "heading") &&
    $from.sameParent($to) &&
    $from.parent.isTextblock
  ) {
    // One paragraph or heading for text inside one block is that text's new
    // words: the block stays what it was, as a heading worked on stays one.
    const inline = inlinesToEditor(only.content).map((json) => editor.schema.nodeFromJSON(json));
    tr.replaceWith(range.from, range.to, inline);
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(range.to))));
  } else {
    tr.replaceWith(range.from, range.to, nodesOf(editor, blocks));
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(range.to)), -1));
  }
  // Its own step of the undo history, apart from typing just before or after.
  const undo = yUndoPluginKey.getState(state)?.undoManager;
  undo?.stopCapturing();
  editor.view.dispatch(tr.scrollIntoView());
  undo?.stopCapturing();
  return true;
}

/**
 * What the assist works on now: the selection, or with nothing selected
 * the block the caret is in; undefined when that has no text, or the
 * editor is not bound to a note's document.
 */
export function assistSelection(editor: Editor): AssistSelection | undefined {
  const { state } = editor;
  const anchor = selectionAnchor(state);
  const range = anchor === undefined ? undefined : anchorRange(state, anchor);
  if (anchor === undefined || range === undefined) return undefined;
  if (state.doc.textBetween(range.from, range.to, "\n", "\n").trim() === "") return undefined;
  const cut = state.doc.cut(range.from, range.to);
  return {
    anchor,
    blocks: fromEditor(cut.toJSON() as JSONContent, (): BlockId => newBlockId()),
    apply: (blocks, placement) => applyAssist(editor, anchor, blocks, placement),
    focus: () => {
      if (!editor.isDestroyed) editor.view.focus();
    },
  };
}

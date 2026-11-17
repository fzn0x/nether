// A note in the editor, with its title and what happened to its last save.
// It shows as blocks, or as its Markdown source, which Ctrl or Cmd and /
// switches between. In a vault linked to a workspace, its comments show
// beside it, their text highlighted in it (ADR 0044).
import type { JsonObject, NoteId } from "@nether/core";
import {
  type AssistSelection,
  type CommentAnchor,
  type CommentAuthor,
  type CommentThread,
  type NoteAssistView,
  type NoteCommentsView,
  NoteEditor,
} from "@nether/editor";
import "@nether/editor/math.css";
import type { LinkGraph } from "@nether/graph";
import type { Vault } from "@nether/storage";
import { type ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { type Exporter, type VaultMedia, backend } from "./backend.ts";
import { CodeOutput } from "./CodeOutput.tsx";
import { PluginBlockOutput } from "./PluginBlockOutput.tsx";
import { CommentsPanel } from "./CommentsPanel.tsx";
import { t } from "./messages.ts";
import { ariaKeys, formatKeys } from "./shortcuts.ts";
import { linkPreviews } from "./linkPreviews.ts";
import { noteFiles } from "./noteFiles.ts";
import { DatabaseSlot } from "./DatabaseSlot.tsx";
import { PropertiesPanel } from "./PropertiesPanel.tsx";
import { type NotePart, noteLinks } from "./noteLinks.ts";
import { useComments } from "./useComments.ts";
import { type GoLive, useLive } from "./useLive.ts";
import { useNote } from "./useNote.ts";
import { useSlashEntries } from "./plugins/blocks.ts";
import { type PanelRegistry, usePanels } from "./plugins/panels.ts";
import { NotePanelSection } from "./PanelOutput.tsx";
import type { Registries } from "./plugins/host.ts";
import type { AIProvider } from "./mygo.ts";

export type NoteMode = "blocks" | "source";

/** Writing assist in the note, while the vault has an AI provider (ADR 0069). */
export interface NoteAi {
  readonly provider: AIProvider;
  /** Changes when the user asks for writing assist on the selection. */
  readonly request: number;
  /** Whether AI may run now, as the workspace's server says before text is sent. */
  readonly allowedNow: () => Promise<boolean>;
}

// CodeMirror loads the first time a note shows its source.
const SourceEditor = lazy(() =>
  import("@nether/editor/source").then(({ SourceEditor: editor }) => ({ default: editor })),
);

// Writing assist, with the providers' code, loads the first time it is asked for.
const WritingAssist = lazy(() =>
  import("./WritingAssist.tsx").then(({ WritingAssist: panel }) => ({ default: panel })),
);

const vimKey = "nether.vim";

/** Whether the user turned Vim keys on, remembered in this browser; storage may be closed to the page. */
function storedVim(): boolean {
  try {
    return localStorage.getItem(vimKey) === "on";
  } catch {
    return false;
  }
}

function storeVim(on: boolean): void {
  try {
    localStorage.setItem(vimKey, on ? "on" : "off");
  } catch {
    // Not remembered: the setting holds until the app closes.
  }
}

export default function NoteView(props: {
  readonly vault: Vault;
  readonly media: VaultMedia;
  /** Where a database's view is exported. */
  readonly exporter: Exporter;
  readonly graph: LinkGraph;
  /** What plugins add: the code blocks they draw and their blocks, with their slash menu entries. */
  readonly plugins: Registries;
  readonly id: NoteId;
  /** Where a link asked to go in this note. */
  readonly focus: (NotePart & { readonly key: number }) | undefined;
  /** Opens another note, or a part of one, as a link in this one does. */
  readonly onOpenNote: (id: NoteId, part?: NotePart) => void;
  /**
   * Opens a file a link names, as a PDF, at what followed the link's `#`;
   * false when no view opens it.
   */
  readonly onOpenFile?: (path: string, part?: string) => boolean;
  /** Shows the notes with a tag, as a tag in this note does. */
  readonly onOpenTag: (name: string) => void;
  readonly mode: NoteMode;
  readonly onMode: (mode: NoteMode) => void;
  /** Moves the note to the vault's trash. */
  readonly onTrash: () => void;
  /** Exports the note, its folder or the vault. */
  readonly onExport: () => void;
  /** Renames the note in its folder, and the links to it; rejects with why it could not. */
  readonly onRename: (name: string) => Promise<void>;
  /** Changes when the user asks to switch between blocks and source. */
  readonly sourceRequest: number;
  /** Changes when the user asks to rename the note: its name takes focus. */
  readonly renameRequest: number;
  /** The shortcut that switches modes, for its button's hint. */
  readonly sourceKeys: string | undefined;
  /** Called when the note's text shows. */
  readonly onShown: () => void;
  /** Syncs the note live while it is open, with the others' carets, when the vault syncs. */
  readonly live?: GoLive | undefined;
  /** Who this person is in the vault's workspace; without one, notes have no comments. */
  readonly me?: CommentAuthor | undefined;
  /** Whether this person may comment on the note, or only read its comments. */
  readonly canComment?: boolean;
  /** Changes when the user asks to comment on the selection. */
  readonly commentRequest?: number;
  /** The shortcut that comments on the selection, for the comments' hint. */
  readonly commentKeys?: string | undefined;
  /** The people a comment may mention. */
  readonly people?: readonly CommentAuthor[];
  /** Called when a comment mentions people, to tell them (ADR 0045). */
  readonly onMention?: (thread: string, people: readonly CommentAuthor[], body: string) => void;
  /** A thread to show, as a notification asks; a new `key` shows it again. */
  readonly threadRequest?: { readonly thread: string; readonly key: number } | undefined;
  /** The ID of the note's name, its own in each pane. */
  readonly titleId?: string;
  /** Writing assist, while the vault has an AI provider; nothing of it shows otherwise. */
  readonly ai?: NoteAi;
}) {
  const {
    vault,
    media,
    exporter,
    graph,
    plugins,
    id,
    focus,
    mode,
    onMode,
    onOpenNote,
    onOpenFile,
    onOpenTag,
    onTrash,
    onExport,
    onRename,
    sourceRequest,
    renameRequest,
    sourceKeys,
    onShown,
    live,
    me,
    canComment = false,
    commentRequest = 0,
    commentKeys,
    people,
    onMention,
    threadRequest,
    titleId = "note-title",
    ai,
  } = props;
  const note = vault.note(id);
  const { state, saveError, editText, refresh } = useNote(vault, id);
  const collaboration = useLive(live, id, state.status === "ready" ? state.document : undefined);
  const [fileError, setFileError] = useState<string | undefined>();
  const [vim, setVim] = useState(storedVim);
  const comments = useComments(vault, id, me !== undefined);
  // The thread shown in the note, and the text a new one is being written on.
  const [activeThread, setActiveThread] = useState<string | undefined>();
  const [draft, setDraft] = useState<CommentAnchor | undefined>();
  useEffect(() => {
    setActiveThread(undefined);
    setDraft(undefined);
  }, [id]);
  // After the reset above, as a notification opens its note and thread at once.
  const shownThread = threadRequest?.key;
  useEffect(() => {
    if (threadRequest !== undefined) setActiveThread(threadRequest.thread);
  }, [shownThread]);
  const commentsView = useMemo((): NoteCommentsView | undefined => {
    if (comments === undefined) return undefined;
    const threads: CommentThread[] = comments.threads.filter(
      (thread) => thread.resolved === undefined,
    );
    // The text a new thread is being written on shows as the active one.
    if (draft !== undefined) {
      threads.push({ id: "", anchor: draft, created: 0, comments: [], resolved: undefined });
    }
    return {
      threads,
      active: draft === undefined ? activeThread : "",
      onActivate: setActiveThread,
      ...(canComment ? { onComment: setDraft } : {}),
      request: commentRequest,
    };
  }, [comments, draft, activeThread, canComment, commentRequest]);
  // What writing assist works on while it shows, the round it shows for, and
  // the provider it was asked with. It stays open if AI goes off meanwhile,
  // to say so, and sends nothing more.
  const [assisting, setAssisting] = useState<
    | {
        readonly selection: AssistSelection | undefined;
        readonly round: number;
        readonly ai: NoteAi;
      }
    | undefined
  >();
  useEffect(() => {
    setAssisting(undefined);
  }, [id, mode]);
  const latestAi = useRef(ai);
  latestAi.current = ai;
  // The command's count, kept while AI is off, so its coming back asks for nothing.
  const assistRequest = useRef(ai?.request ?? 0);
  if (ai !== undefined) assistRequest.current = ai.request;
  const assistOn = ai !== undefined || assisting !== undefined;
  const assistView = useMemo(
    (): NoteAssistView | undefined =>
      assistOn
        ? {
            request: assistRequest.current,
            onAssist: (selection) => {
              const asked = latestAi.current;
              if (asked === undefined) return;
              setAssisting((current) => ({
                selection,
                round: (current?.round ?? 0) + 1,
                ai: asked,
              }));
            },
            active: assisting?.selection?.anchor,
          }
        : undefined,
    [assistOn, assistRequest.current, assisting],
  );
  // What plugins add to the slash menu.
  const slashEntries = useSlashEntries(plugins.codeBlocks, plugins.blocks);
  // The editor takes focus when the user switches modes, not when a note opens.
  const [switched, setSwitched] = useState(false);
  const files = useMemo(
    () =>
      noteFiles(vault, media, id, (error) => {
        setFileError(error instanceof Error ? error.message : String(error));
      }),
    [vault, media, id],
  );
  const links = useMemo(
    () => ({
      ...noteLinks(
        vault,
        graph,
        id,
        onOpenNote,
        (error) => {
          setFileError(error instanceof Error ? error.message : String(error));
        },
        onOpenTag,
        onOpenFile,
      ),
      // What plugins draw below a code block: a diagram, the notes a query finds.
      renderCode: (language: string, info: string, source: string) => (
        <CodeOutput
          codeBlocks={plugins.codeBlocks}
          language={language}
          info={info}
          source={source}
          vault={vault}
          media={media}
          graph={graph}
          onOpen={(note) => {
            onOpenNote(note);
          }}
        />
      ),
      // A plugin's block shows as its plugin shows it.
      renderBlock: (
        type: string,
        attrs: JsonObject,
        editable: boolean,
        setAttrs: (attrs: JsonObject) => void,
      ) => (
        <PluginBlockOutput
          blocks={plugins.blocks}
          type={type}
          attrs={attrs}
          editable={editable}
          onChange={setAttrs}
        />
      ),
    }),
    [vault, media, graph, plugins, id, onOpenNote, onOpenTag, onOpenFile],
  );

  const toggle = async () => {
    // Save what either editor has, so the other starts from it.
    await refresh();
    setSwitched(true);
    onMode(mode === "blocks" ? "source" : "blocks");
  };

  // When a note's text shows, and for performance measurements.
  const shown = state.status === "ready";
  useEffect(() => {
    if (!shown) return;
    backend.mark("note-shown");
    onShown();
  }, [shown, id, onShown]);

  // The app's commands ask for a switch, or a rename; a request made before this view does nothing.
  const handledSource = useRef(sourceRequest);
  useEffect(() => {
    if (sourceRequest === handledSource.current) return;
    handledSource.current = sourceRequest;
    void toggle();
  }, [sourceRequest]);
  const handledRename = useRef(renameRequest);
  useEffect(() => {
    if (renameRequest === handledRename.current) return;
    handledRename.current = renameRequest;
    const title = document.getElementById(titleId);
    if (title === null) return;
    title.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(title);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [renameRequest]);

  if (note === undefined || state.status === "missing") {
    return <p className="placeholder">{t("missingNote")}</p>;
  }
  return (
    <div className="note-layout">
      <article className="note" aria-labelledby={titleId}>
        <header className="note-header">
          <NoteTitle
            id={titleId}
            title={note.title}
            onRename={onRename}
            onError={(error) => {
              setFileError(error);
            }}
          />
          {state.status === "ready" ? (
            <div className="note-tools">
              {mode === "source" ? (
                <label className="note-option">
                  <input
                    type="checkbox"
                    checked={vim}
                    onChange={(event) => {
                      setVim(event.target.checked);
                      storeVim(event.target.checked);
                    }}
                  />
                  {t("vimKeys")}
                </label>
              ) : null}
              <button
                type="button"
                className="quiet"
                aria-pressed={mode === "source"}
                aria-keyshortcuts={sourceKeys === undefined ? undefined : ariaKeys(sourceKeys)}
                title={
                  sourceKeys === undefined
                    ? t("sourceModeHint")
                    : `${t("sourceModeHint")} (${formatKeys(sourceKeys)})`
                }
                onClick={() => void toggle()}
              >
                {t("sourceMode")}
              </button>
              <button
                type="button"
                className="quiet"
                aria-haspopup="dialog"
                title={t("exportHint")}
                onClick={onExport}
              >
                {t("export")}
              </button>
              <button
                type="button"
                className="quiet"
                title={t("moveToTrashHint")}
                onClick={onTrash}
              >
                {t("moveToTrash")}
              </button>
            </div>
          ) : null}
        </header>
        {saveError === undefined ? null : (
          <p role="alert">{t("saveFailed", { error: saveError })}</p>
        )}
        {fileError === undefined ? null : (
          <p role="alert">{t("fileFailed", { error: fileError })}</p>
        )}
        {state.status === "failed" ? (
          <p role="alert">{state.error.message}</p>
        ) : state.status === "binary" ? (
          <p className="placeholder">{t("binaryNote")}</p>
        ) : state.status === "loading" ? null : mode === "source" ? (
          <Suspense fallback={null}>
            <SourceEditor
              // The text read again starts a new editor.
              key={state.version}
              text={state.text}
              onChange={editText}
              label={t("noteSource", { title: note.title })}
              placeholder={t("emptySource")}
              vim={vim}
              autofocus={switched}
            />
          </Suspense>
        ) : (
          <>
            {state.frontmatterError === undefined ? (
              <PropertiesPanel
                key={`properties-${state.document.guid}`}
                document={state.document}
                vault={vault}
                graph={graph}
                propertyTypes={plugins.propertyTypes}
              />
            ) : (
              <p className="notice" role="status">
                {t("unreadableFrontmatter", { error: state.frontmatterError })}
              </p>
            )}
            <NoteEditor
              // The editor shows the document as it changes; a new document starts a new editor.
              key={state.document.guid}
              document={state.document}
              label={t("noteBody", { title: note.title })}
              placeholder={t("emptyNote")}
              files={files}
              links={links}
              slashEntries={slashEntries}
              previews={linkPreviews(vault)}
              autofocus={switched}
              {...(focus === undefined ? {} : { focus })}
              {...(collaboration === undefined ? {} : { collaboration })}
              {...(commentsView === undefined ? {} : { comments: commentsView })}
              {...(assistView === undefined ? {} : { assist: assistView })}
            />
            <DatabaseSlot
              // Its panels, view and errors are the note's: another note starts afresh.
              // Each sibling's key its own, or React keeps the last note's editor too.
              key={`database-${state.document.guid}`}
              vault={vault}
              media={media}
              exporter={exporter}
              graph={graph}
              document={state.document}
              path={note.path}
              layouts={plugins.layouts}
              propertyTypes={plugins.propertyTypes}
              onOpenNote={(row) => {
                onOpenNote(row);
              }}
            />
          </>
        )}
      </article>
      <NotePanel
        vault={vault}
        graph={graph}
        id={id}
        panels={plugins.panels}
        onOpenNote={onOpenNote}
        onOpenTag={onOpenTag}
      >
        {assisting === undefined ? null : (
          <Suspense fallback={null}>
            <WritingAssist
              // Each request starts afresh.
              key={assisting.round}
              provider={assisting.ai.provider}
              selection={assisting.selection}
              noteTitle={(note) => vault.note(note)?.title}
              // Nothing is sent once AI is off here, for the vault or its workspace.
              allowedNow={() =>
                latestAi.current === undefined
                  ? Promise.resolve(false)
                  : latestAi.current.allowedNow()
              }
              onClose={() => {
                setAssisting(undefined);
              }}
            />
          </Suspense>
        )}
        {comments === undefined || me === undefined ? null : (
          <CommentsPanel
            comments={comments}
            me={me}
            canComment={canComment}
            active={activeThread}
            onActivate={setActiveThread}
            draft={draft}
            onDraftDone={() => {
              setDraft(undefined);
            }}
            commentKeys={commentKeys === undefined ? undefined : formatKeys(commentKeys)}
            {...(people === undefined ? {} : { people })}
            onMention={onMention}
          />
        )}
      </NotePanel>
    </div>
  );
}

/**
 * The note's name, edited in place: Enter or leaving it renames the note,
 * Escape puts the name back.
 */
function NoteTitle(props: {
  readonly id: string;
  readonly title: string;
  readonly onRename: (name: string) => Promise<void>;
  readonly onError: (error: string) => void;
}) {
  const { id, title, onRename, onError } = props;
  const element = useRef<HTMLHeadingElement>(null);
  const commit = () => {
    const name = element.current?.textContent.trim() ?? title;
    if (name === title) return;
    onRename(name).catch((error: unknown) => {
      if (element.current !== null) element.current.textContent = title;
      onError(error instanceof Error ? error.message : String(error));
    });
  };
  return (
    <h1
      // A new name starts the heading anew, so React and the browser agree on its text.
      key={title}
      id={id}
      ref={element}
      className="note-title-field"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label={t("noteName")}
      aria-multiline="false"
      title={t("renameHint")}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          element.current?.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (element.current !== null) element.current.textContent = title;
          element.current?.blur();
        }
      }}
    >
      {title}
    </h1>
  );
}

/**
 * Beside the note: its comments, given as children, then the panels
 * plugins add there, as its outline, the notes that link to it and those
 * that mention it without a link.
 */
function NotePanel(props: {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  readonly id: NoteId;
  readonly panels: PanelRegistry;
  readonly onOpenNote: (id: NoteId, part?: NotePart) => void;
  readonly onOpenTag: (name: string) => void;
  readonly children?: ReactNode;
}) {
  const { vault, graph, id, panels, onOpenNote, onOpenTag, children } = props;
  const shown = usePanels(panels, "note");
  const viewProps = useMemo(
    () => ({ vault, graph, note: id, openNote: onOpenNote, openTag: onOpenTag }),
    [vault, graph, id, onOpenNote, onOpenTag],
  );
  return (
    <aside className="note-panel" aria-label={t("aboutNote")}>
      {children}
      {shown.map((panel) => (
        <NotePanelSection key={panel.id} processor={panel} viewProps={viewProps} />
      ))}
    </aside>
  );
}

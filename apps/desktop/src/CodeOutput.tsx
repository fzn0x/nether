// What plugins draw below a code block in a note open in the app
// (ADR 0055): a built-in plugin's live view, or the HTML a plugin draws
// from the block's text, drawn again once typing pauses. A plugin's code
// loads with the first block in a language it draws.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import type { CodeBlockOutput, NoteContext } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { VaultMedia } from "./backend.ts";
import { t } from "./messages.ts";
import { NoteDayContext } from "./noteDay.ts";
import type {
  CodeBlockDrawing,
  CodeBlockNote,
  CodeBlockProcessor,
  CodeBlockRegistry,
} from "./plugins/codeBlocks.ts";

/** How long typing pauses before a block is drawn again. */
const pause = 300;

type Render = NonNullable<CodeBlockDrawing["render"]>;

interface Props {
  readonly codeBlocks: CodeBlockRegistry;
  /** The fence's first word, and all of it. */
  readonly language: string;
  readonly info: string;
  readonly source: string;
  readonly vault: Vault;
  readonly media: VaultMedia;
  readonly graph: LinkGraph;
  readonly onOpen: (id: NoteId) => void;
  /** What a live view may do from the block's note, as a button does. */
  readonly note?: CodeBlockNote | undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the page shows dark: as its root's `data-mode` says, which the
 * app sets apart from the system, or else as the system prefers.
 */
export function shownDark(): boolean {
  const mode = document.documentElement.dataset.mode;
  return mode === undefined ? matchMedia("(prefers-color-scheme: dark)").matches : mode === "dark";
}

export function Failed(props: { readonly message: string }) {
  return (
    <div className="code-error" contentEditable={false} role="status">
      <p>{t("codeBlockFailed")}</p>
      <pre>{props.message}</pre>
    </div>
  );
}

/** What a plugin draws below a code block, when one draws its language. */
export function CodeOutput(props: Props) {
  const { codeBlocks, language } = props;
  const processor = useSyncExternalStore(
    useCallback((listener: () => void) => codeBlocks.subscribe(listener), [codeBlocks]),
    () => codeBlocks.get(language),
  );
  return processor === undefined ? null : (
    <Drawn key={processor.plugin} {...props} processor={processor} />
  );
}

function Drawn(props: Props & { readonly processor: CodeBlockProcessor }) {
  const { processor, info, source, vault } = props;
  const dayOf = useContext(NoteDayContext);
  const entry = props.note === undefined ? undefined : vault.note(props.note.id);
  const { id, title, path } = entry ?? {};
  // The note the block is in, as plugins are told of it, with its day for a daily note.
  const note = useMemo((): NoteContext | undefined => {
    if (id === undefined || title === undefined || path === undefined) return undefined;
    const day = dayOf(path);
    return { id, title, path, ...(day === undefined ? {} : { day }) };
  }, [id, title, path, dayOf]);
  const [drawing, setDrawing] = useState<CodeBlockDrawing | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  useEffect(() => {
    let current = true;
    processor.load().then(
      (loaded) => {
        if (current) setDrawing(loaded);
      },
      (error: unknown) => {
        if (current) setFailure(errorText(error));
      },
    );
    return () => {
      current = false;
    };
  }, [processor]);

  if (failure !== undefined) return <Failed message={failure} />;
  const View = drawing?.view;
  if (View !== undefined) {
    return (
      <div className="code-output" data-language={processor.language} contentEditable={false}>
        <Suspense fallback={null}>
          <View
            source={source}
            vault={props.vault}
            media={props.media}
            graph={props.graph}
            openNote={props.onOpen}
            note={props.note}
          />
        </Suspense>
      </div>
    );
  }
  return drawing?.render === undefined ? null : (
    <Rendered
      render={drawing.render}
      language={processor.language}
      info={info}
      source={source}
      note={note}
    />
  );
}

function Rendered(props: {
  readonly render: Render;
  readonly language: string;
  readonly info: string;
  readonly source: string;
  readonly note: NoteContext | undefined;
}) {
  const { render, language, info, source, note } = props;
  const [output, setOutput] = useState<CodeBlockOutput>(null);
  useEffect(() => {
    let current = true;
    // Drawn once typing pauses, not at every key.
    const timer = setTimeout(() => {
      const theme = shownDark() ? "dark" : "light";
      render(source, {
        language,
        info,
        theme,
        target: "editor",
        ...(note === undefined ? {} : { note }),
      }).then(
        (drawn) => {
          if (current) setOutput(drawn);
        },
        (error: unknown) => {
          if (current) setOutput({ error: errorText(error) });
        },
      );
    }, pause);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [render, language, info, source, note]);

  if (output === null) return null;
  if ("error" in output) return <Failed message={output.error} />;
  return (
    <div
      className="code-output"
      data-language={language}
      contentEditable={false}
      // A built-in plugin's HTML, such as Mermaid's SVG, which its "strict"
      // security level cleans. The sandbox's record decides how HTML from
      // a plugin's folder is cleaned.
      dangerouslySetInnerHTML={{ __html: output.html }}
    />
  );
}

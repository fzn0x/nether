// A button below a `meta-bind-button` block (ADR 0072), drawn as the block
// says, which runs its actions when clicked. A button that asks for what
// Nether does not run says so, and runs none of them; one that fails says
// why below it. One that runs commands asks first, naming them, until this
// device has run it as it is; one that runs a command a vault's plugin adds
// asks each time.
import { readButton } from "@nether/automations";
import { useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorText } from "./CodeOutput.tsx";
import { backend } from "./backend.ts";
import {
  type AskedCommand,
  blockHash,
  commandsToAsk,
  mustAsk,
  problemText,
  rememberRun,
  runActions,
} from "./buttons.ts";
import { t } from "./messages.ts";
import { setNoteValue } from "./noteActions.ts";
import type { CodeBlockViewProps } from "./plugins/codeBlocks.ts";
import { useModal } from "./useModal.ts";

/** What a button asks before it runs: its commands, and the block as it was when clicked. */
interface Asking {
  readonly commands: readonly AskedCommand[];
  readonly hash: string;
}

/** Asks before a button runs its commands; the focus starts on Cancel, so Enter alone runs nothing. */
function AskDialog(props: {
  readonly asking: Asking;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}) {
  const { asking, onRun, onCancel } = props;
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog);
  const id = useId();
  const everyTime = asking.commands.some((command) => command.fromVault);
  return createPortal(
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        // A click outside the dialog runs nothing.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="switcher dialog button-ask-dialog"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id={`${id}-title`}>{t("buttonAskTitle")}</h2>
        <p id={`${id}-body`}>
          {t("buttonAskBody", {
            commands: asking.commands.map((command) => command.title).join(", "),
          })}
        </p>
        {everyTime ? <p className="hint">{t("buttonAskEveryTime")}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="quiet" autoFocus onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="button" className="primary" onClick={onRun}>
            {t("buttonAskRun")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ButtonView(props: CodeBlockViewProps) {
  const { source, vault, graph, note } = props;
  const read = useMemo(() => readButton(source), [source]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const [asking, setAsking] = useState<Asking | undefined>();
  // While a click looks up whether to ask, a second does nothing; the
  // button keeps its focus, which the question gives back when it closes.
  const checking = useRef(false);
  if ("problem" in read) {
    return (
      <p className="note-button-problem" role="status">
        {problemText(read.problem)}
      </p>
    );
  }
  const { button } = read;
  // Meta Bind hides a button that only its inline buttons show.
  if (button.hidden) return null;
  const unsupported = button.unsupported.length > 0;

  const failed = (error: unknown) => {
    setRunning(false);
    setFailure(errorText(error));
  };

  const run = () => {
    if (note === undefined) return;
    setRunning(true);
    const from = () => vault.note(note.id)?.path ?? "";
    runActions(button.actions, {
      note: note.id,
      runCommand: note.runCommand,
      createNote: note.createNote,
      findNote: (name) =>
        graph.resolve(name, from()) ?? vault.noteAt(/\.md$/i.test(name) ? name : `${name}.md`)?.id,
      setProperty: (id, key, value) => setNoteValue(vault, id, key, value),
      openLink: note.openLink,
      openUrl: (url) => {
        void backend.openUrl(url);
      },
      wait: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    }).then(() => {
      setRunning(false);
    }, failed);
  };

  const click = () => {
    if (note === undefined) return;
    setFailure(undefined);
    const commands = commandsToAsk(button.actions, note.describeCommand);
    if (commands.length === 0) {
      run();
      return;
    }
    if (checking.current) return;
    checking.current = true;
    // The block's text as clicked, which a Run remembers.
    const asked = async () => {
      const hash = await blockHash(source);
      return { hash, ask: await mustAsk(vault.settings, note.id, hash, commands) };
    };
    asked()
      .then(({ hash, ask }) => {
        if (ask) setAsking({ commands, hash });
        else run();
      }, failed)
      .finally(() => {
        checking.current = false;
      });
  };

  const runAsked = (answer: Asking) => {
    setAsking(undefined);
    if (note === undefined) return;
    // A command a vault's plugin adds is asked about each time: nothing to remember.
    const remember = answer.commands.some((command) => command.fromVault)
      ? Promise.resolve()
      : rememberRun(vault.settings, note.id, answer.hash);
    setRunning(true);
    remember.then(run, failed);
  };

  return (
    <div className="note-button">
      <button
        type="button"
        className={`note-button-${button.style}`}
        title={button.tooltip}
        disabled={unsupported || note === undefined || running}
        aria-busy={running}
        onClick={click}
      >
        {button.label}
      </button>
      {unsupported ? (
        <p className="note-button-problem" role="status">
          {t("buttonUnsupported", { actions: button.unsupported.join(", ") })}
        </p>
      ) : null}
      {failure === undefined ? null : (
        <p className="note-button-problem" role="alert">
          {t("buttonFailed", { error: failure })}
        </p>
      )}
      {asking === undefined ? null : (
        <AskDialog
          asking={asking}
          onRun={() => {
            runAsked(asking);
          }}
          onCancel={() => {
            setAsking(undefined);
          }}
        />
      )}
    </div>
  );
}

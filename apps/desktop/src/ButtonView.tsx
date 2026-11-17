// A button below a `meta-bind-button` block (ADR 0072), drawn as the block
// says, which runs its actions when clicked. A button that asks for what
// Nether does not run says so, and runs none of them; one that fails says
// why below it.
import { readButton } from "@nether/automations";
import { useMemo, useState } from "react";
import { errorText } from "./CodeOutput.tsx";
import { backend } from "./backend.ts";
import { problemText, runActions } from "./buttons.ts";
import { t } from "./messages.ts";
import { setNoteValue } from "./noteActions.ts";
import type { CodeBlockViewProps } from "./plugins/codeBlocks.ts";

export function ButtonView(props: CodeBlockViewProps) {
  const { source, vault, graph, note } = props;
  const read = useMemo(() => readButton(source), [source]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
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

  const click = () => {
    if (note === undefined) return;
    setRunning(true);
    setFailure(undefined);
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
    }).then(
      () => {
        setRunning(false);
      },
      (error: unknown) => {
        setRunning(false);
        setFailure(errorText(error));
      },
    );
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
    </div>
  );
}

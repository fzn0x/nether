// Asking your notes, in the sidebar (ADR 0075): it says where a question
// goes before anything is sent; finds passages by the vault's own search,
// and by meaning when that is on; streams the answer; and shows each
// citation as a link to its passage, or as unverified when it names no
// passage that was sent. What was read from is listed under each answer.
// The conversation stays while the vault is open, and can be saved as a
// note with its citations as links.
import {
  AiError,
  type AnswerPart,
  askRequest,
  cleanReply,
  createProvider,
  readAnswer,
} from "@nether/ai";
import type { NoteId } from "@nether/core";
import { safeName } from "@nether/markdown";
import type { Vault } from "@nether/storage";
import { type KeyboardEvent, type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { AiProviderEntry } from "./ai.ts";
import {
  type AskedTurn,
  type MeaningSource,
  type Passage,
  conversationNote,
  namedPassage,
  retrieve,
} from "./askNotes.ts";
import { providerWhere } from "./aiWords.ts";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import type { NotePart } from "./noteLinks.ts";

/** How many turns before a question go with it, questions and answers alone. */
const remembered = 3;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "finding"; readonly question: string }
  | {
      readonly kind: "writing";
      readonly question: string;
      readonly passages: readonly Passage[];
      readonly text: string;
    };

/** Where a citation's passage is from, as its link names it. */
function sourceName(number: number, passage: Passage): string {
  return passage.heading === undefined || passage.heading === passage.title
    ? t("askSourceNote", { number, title: passage.title })
    : t("askSource", { number, title: passage.title, heading: passage.heading });
}

/** An answer with its citations as links to their passages, and the others marked unverified. */
function Answer(props: {
  readonly text: string;
  readonly passages: readonly Passage[];
  readonly onOpen: (note: NoteId, part?: NotePart) => void;
}) {
  const { text, passages, onOpen } = props;
  const parts: AnswerPart[] = readAnswer(text);
  return (
    <p className="ask-answer">
      {parts.map((part, index) => {
        const key = String(index);
        if (part.kind === "text") return <span key={key}>{part.text}</span>;
        const passage =
          part.kind === "cite" ? passages[part.passage - 1] : namedPassage(passages, part.name);
        const shown = part.kind === "cite" ? `[${String(part.passage)}]` : part.name;
        if (passage === undefined) {
          return (
            <span
              key={key}
              className="ask-unverified"
              title={part.kind === "cite" ? t("askUnverified") : t("askUnverifiedName")}
            >
              {shown}
              <span className="visually-hidden">
                {` ${part.kind === "cite" ? t("askUnverified") : t("askUnverifiedName")}`}
              </span>
            </span>
          );
        }
        const number = passages.indexOf(passage) + 1;
        return (
          <button
            key={key}
            type="button"
            className="ask-cite"
            aria-label={`${shown} ${sourceName(number, passage)}`}
            onClick={() => {
              onOpen(passage.note, passage.part);
            }}
          >
            {shown}
          </button>
        );
      })}
    </p>
  );
}

/** The passages an answer went with, the ones it cites marked, each opening where it is. */
function Sources(props: {
  readonly turn: Pick<AskedTurn, "answer" | "passages">;
  readonly onOpen: (note: NoteId, part?: NotePart) => void;
}) {
  const { turn, onOpen } = props;
  if (turn.passages.length === 0) return null;
  const cited = new Set<number>();
  for (const part of readAnswer(turn.answer)) {
    if (part.kind === "cite") cited.add(part.passage);
    if (part.kind !== "named") continue;
    const named = namedPassage(turn.passages, part.name);
    if (named !== undefined) cited.add(turn.passages.indexOf(named) + 1);
  }
  return (
    <details className="ask-sources">
      <summary>{t("askReadFrom", { count: turn.passages.length })}</summary>
      <ol>
        {turn.passages.map((passage, index) => (
          <li key={`${passage.note}-${String(index)}`}>
            <button
              type="button"
              className={cited.has(index + 1) ? "cited" : undefined}
              onClick={() => {
                onOpen(passage.note, passage.part);
              }}
            >
              {sourceName(index + 1, passage)}
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}

export type { AskedTurn };

export function AskPanel(props: {
  readonly vault: Vault;
  readonly provider: AiProviderEntry;
  /** The workspace the vault syncs with, whose relay the web app sends through (ADR 0070). */
  readonly workspaceId: string | undefined;
  /** The server the question goes through first, by its host, as in the web app. */
  readonly through: string | undefined;
  /** Whether AI may run now, as the workspace's server says before anything is sent. */
  readonly allowedNow: () => Promise<boolean>;
  /** Search by meaning, when it is on for the vault (ADR 0074). */
  readonly meaning?: MeaningSource | undefined;
  /** Where search by meaning sends the question, to say so, while it does. */
  readonly meaningVia?: string | undefined;
  readonly turns: readonly AskedTurn[];
  readonly onTurns: (turns: readonly AskedTurn[]) => void;
  readonly onOpen: (note: NoteId, part?: NotePart) => void;
  /** Changes when the app's command asks for the question's field. */
  readonly focusRequest: number;
}) {
  const {
    vault,
    provider,
    workspaceId,
    through,
    allowedNow,
    meaning,
    meaningVia,
    turns,
    onTurns,
    onOpen,
  } = props;
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<string | undefined>();
  const running = useRef<AbortController | undefined>(undefined);
  const field = useRef<HTMLTextAreaElement>(null);
  const name = provider.name;
  const latest = useRef(turns);
  latest.current = turns;

  useEffect(() => {
    field.current?.focus();
  }, [props.focusRequest]);
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  const add = (turn: AskedTurn) => {
    onTurns([...latest.current, turn]);
  };

  const ask = async (asked: string) => {
    const controller = new AbortController();
    running.current = controller;
    setNotice(undefined);
    setPhase({ kind: "finding", question: asked });
    const stopped = () => running.current !== controller || controller.signal.aborted;
    let passages: readonly Passage[] = [];
    let text = "";
    try {
      // The workspace's owners or admins may have turned AI off since.
      if (!(await allowedNow())) {
        add({
          question: asked,
          answer: "",
          passages,
          status: "failed",
          error: t("aiWorkspaceOffNow"),
        });
        return;
      }
      passages = await retrieve(vault, asked, meaning);
      if (stopped()) return;
      if (passages.length === 0) {
        add({ question: asked, answer: "", passages, status: "empty" });
        return;
      }
      setPhase({ kind: "writing", question: asked, passages, text });
      const access = await backend.aiAccess(provider, workspaceId);
      const chat = createProvider(
        {
          kind: provider.kind === "anthropic" ? "anthropic" : "openai",
          url: access.url,
          model: provider.model,
        },
        { fetch: access.fetch, key: access.key },
      );
      const before = latest.current
        .filter((turn) => turn.status === "done")
        .slice(-remembered)
        .map((turn) => ({ question: turn.question, answer: turn.answer }));
      const request = askRequest(
        asked,
        passages.map((passage) => ({
          title: passage.title,
          heading: passage.heading,
          text: passage.text,
        })),
        before,
      );
      for await (const part of chat.chat({ ...request, signal: controller.signal })) {
        text += part;
        if (!stopped()) setPhase({ kind: "writing", question: asked, passages, text });
      }
      add({ question: asked, answer: cleanReply(text), passages, status: "done" });
    } catch (error) {
      if (controller.signal.aborted) {
        add({ question: asked, answer: cleanReply(text), passages, status: "stopped" });
        return;
      }
      add({
        question: asked,
        answer: cleanReply(text),
        passages,
        status: "failed",
        error:
          error instanceof AiError && error.kind === "refused"
            ? t("aiAssistRefused", { name })
            : t("aiAssistFailed", {
                name,
                error: error instanceof Error ? error.message : String(error),
              }),
      });
    } finally {
      if (running.current === controller) {
        running.current = undefined;
        setPhase({ kind: "idle" });
      }
    }
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const asked = question.trim();
    if (asked === "" || phase.kind !== "idle") return;
    setQuestion("");
    void ask(asked);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter asks; Shift and Enter makes a new line.
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  };

  const save = async () => {
    const noteTitle = (note: NoteId) => vault.note(note)?.title;
    const first = turns.find((turn) => turn.status === "done" || turn.status === "stopped");
    if (first === undefined) return;
    const taken = new Set(vault.notes().map((note) => note.path.toLowerCase()));
    const base = safeName(first.question.slice(0, 80), t("askTitle"));
    let path = `${base}.md`;
    for (let count = 2; taken.has(path.toLowerCase()); count++)
      path = `${base} ${String(count)}.md`;
    try {
      const made = await vault.create(path, conversationNote(turns, noteTitle));
      setNotice(t("askSaved", { title: made.title }));
      onOpen(made.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const busy = phase.kind !== "idle";
  return (
    <section className="ask-panel" aria-labelledby="ask-title">
      <h2 id="ask-title" className="visually-hidden">
        {t("askTitle")}
      </h2>
      <p className="hint">
        {through === undefined
          ? t("askSends", { name, where: providerWhere(provider) })
          : t("askSendsThrough", { name, where: providerWhere(provider, true), server: through })}
      </p>
      {meaningVia === undefined ? null : <p className="hint">{meaningVia}</p>}
      {turns.length === 0 && !busy ? <p className="hint">{t("askIntro")}</p> : null}
      <ol className="ask-turns" aria-label={t("askConversation")}>
        {turns.map((turn, index) => (
          <li key={String(index)}>
            <p className="ask-question">{turn.question}</p>
            {turn.status === "empty" ? (
              <p role="status">{t("askNothingFound")}</p>
            ) : (
              <>
                {turn.answer === "" ? null : (
                  <Answer text={turn.answer} passages={turn.passages} onOpen={onOpen} />
                )}
                {turn.status === "stopped" ? <p className="hint">{t("askStopped")}</p> : null}
                {turn.status === "failed" ? <p role="alert">{turn.error}</p> : null}
                <Sources turn={turn} onOpen={onOpen} />
              </>
            )}
          </li>
        ))}
        {phase.kind === "idle" ? null : (
          <li>
            <p className="ask-question">{phase.question}</p>
            {phase.kind === "writing" && phase.text !== "" ? (
              <Answer text={phase.text} passages={phase.passages} onOpen={onOpen} />
            ) : null}
          </li>
        )}
      </ol>
      <p role="status" className="ask-status">
        {phase.kind === "finding"
          ? t("askFinding")
          : phase.kind === "writing"
            ? t("askWriting")
            : (notice ?? "")}
      </p>
      <form className="ask-form" onSubmit={submit}>
        <textarea
          ref={field}
          rows={3}
          aria-label={t("askQuestion")}
          placeholder={t("askPlaceholder")}
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="ask-buttons">
          {busy ? (
            <button
              type="button"
              onClick={() => {
                running.current?.abort();
              }}
            >
              {t("aiAssistStop")}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={question.trim() === ""}>
              {t("askSubmit")}
            </button>
          )}
          {turns.length === 0 || busy ? null : (
            <>
              <button type="button" onClick={() => void save()}>
                {t("askSave")}
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  onTurns([]);
                  setNotice(undefined);
                }}
              >
                {t("askClear")}
              </button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}

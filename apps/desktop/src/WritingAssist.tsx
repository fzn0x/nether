// Writing assist beside a note (ADR 0069): it names the provider the text
// goes to before anything is sent, offers what to do with the text, streams
// the reply into a preview, and puts it in the note only when the user says
// so, in the text's place or after it, as one edit one undo takes out.
// Before each request it asks the workspace's server whether AI may run,
// and sends as the backend says: to the provider with its key from the
// keychain in the desktop app, through the server's relay in the web app
// (ADR 0070), which names the server too.
import {
  AiError,
  type AssistAction,
  assistActions,
  assistPlacement,
  assistRequest,
  cleanReply,
  createProvider,
} from "@nether/ai";
import type { NoteId } from "@nether/core";
import type { AssistPlacement, AssistSelection } from "@nether/editor";
import { parseMarkdown, serializeMarkdown } from "@nether/markdown";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { providerWhere } from "./aiWords.ts";
import { backend } from "./backend.ts";
import { type MessageKey, language, t } from "./messages.ts";
import type { AIProvider } from "./mygo.ts";

const actionNames: Readonly<Record<AssistAction, MessageKey>> = {
  rewrite: "aiAssistRewrite",
  fixGrammar: "aiAssistFixGrammar",
  summarize: "aiAssistSummarize",
  translate: "aiAssistTranslate",
  continue: "aiAssistContinue",
};

type Phase =
  | { readonly kind: "choosing" }
  | { readonly kind: "writing"; readonly action: AssistAction; readonly text: string }
  | { readonly kind: "done"; readonly action: AssistAction; readonly text: string }
  | { readonly kind: "stopped"; readonly action: AssistAction; readonly text: string }
  | {
      readonly kind: "failed";
      readonly action: AssistAction;
      readonly text: string;
      readonly error: string;
    };

/** The name of the app's language in itself, which translations go into unless the user names another. */
function ownLanguage(): string {
  try {
    return new Intl.DisplayNames([language], { type: "language" }).of(language) ?? "English";
  } catch {
    return "English";
  }
}

export function WritingAssist(props: {
  readonly provider: AIProvider;
  /** What to work on; undefined when the caret is where there is no text. */
  readonly selection: AssistSelection | undefined;
  /** The title a link to a note writes. */
  readonly noteTitle: (note: NoteId) => string | undefined;
  readonly allowedNow: () => Promise<boolean>;
  /** The workspace the vault syncs with, whose relay the web app sends through. */
  readonly workspaceId?: string | undefined;
  /** The server the text goes through first, by its host, when it does. */
  readonly through?: string | undefined;
  readonly onClose: () => void;
}) {
  const { provider, selection, noteTitle, allowedNow, workspaceId, through, onClose } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "choosing" });
  const [how, setHow] = useState("");
  const [into, setInto] = useState(ownLanguage);
  const [notice, setNotice] = useState<string | undefined>();
  const running = useRef<AbortController | undefined>(undefined);
  const first = useRef<HTMLButtonElement>(null);
  const name = provider.name;

  // The text as Markdown, as the note writes it.
  const markdown = useMemo(
    () =>
      selection === undefined
        ? ""
        : serializeMarkdown(
            { properties: [], content: selection.blocks },
            { noteTitle },
          ).text.trim(),
    [selection, noteTitle],
  );

  useEffect(() => {
    first.current?.focus();
    return () => {
      running.current?.abort();
    };
  }, []);
  // The buttons a step brings take focus from those it took away.
  const buttons = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase.kind !== "choosing") buttons.current?.querySelector("button")?.focus();
  }, [phase.kind]);

  const close = () => {
    running.current?.abort();
    onClose();
    selection?.focus();
  };

  const run = async (action: AssistAction) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setNotice(undefined);
    let text = "";
    setPhase({ kind: "writing", action, text });
    // The workspace's owners or admins may have turned AI off since.
    if (!(await allowedNow())) {
      if (running.current === controller) {
        setPhase({ kind: "failed", action, text, error: t("aiWorkspaceOffNow") });
      }
      return;
    }
    try {
      const access = await backend.aiAccess(provider, workspaceId);
      const chat = createProvider(
        {
          kind: provider.kind === "anthropic" ? "anthropic" : "openai",
          url: access.url,
          model: provider.model,
        },
        { fetch: access.fetch, key: access.key },
      );
      const request = assistRequest(action, markdown, { language: into, how });
      for await (const part of chat.chat({ ...request, signal: controller.signal })) {
        text += part;
        if (running.current === controller) setPhase({ kind: "writing", action, text });
      }
      if (running.current !== controller) return;
      setPhase(
        cleanReply(text) === ""
          ? { kind: "failed", action, text, error: t("aiAssistEmpty") }
          : { kind: "done", action, text },
      );
    } catch (error) {
      if (running.current !== controller) return;
      if (controller.signal.aborted) {
        setPhase({ kind: "stopped", action, text });
        return;
      }
      const message =
        error instanceof AiError && error.kind === "refused"
          ? t("aiAssistRefused", { name })
          : t("aiAssistFailed", {
              name,
              error: error instanceof Error ? error.message : String(error),
            });
      setPhase({ kind: "failed", action, text, error: message });
    }
  };

  const put = (placement: AssistPlacement) => {
    if (selection === undefined || phase.kind === "choosing") return;
    const blocks = parseMarkdown(cleanReply(phase.text)).content;
    if (!selection.apply(blocks, placement)) {
      setNotice(t("aiAssistGone"));
      return;
    }
    onClose();
    selection.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const reply = phase.kind === "choosing" ? undefined : phase;
  const placement = reply === undefined ? "replace" : assistPlacement(reply.action);
  const done =
    reply?.kind === "done" || (reply?.kind === "stopped" && cleanReply(reply.text) !== "");

  return (
    <section className="assist-panel" aria-labelledby="assist-title" onKeyDown={onKeyDown}>
      <h2 id="assist-title">{t("aiAssist")}</h2>
      <p className="hint">
        {through === undefined
          ? t("aiAssistSends", { name, where: providerWhere(provider) })
          : t("aiAssistSendsThrough", {
              server: through,
              name,
              where: providerWhere(provider, true),
            })}
      </p>
      {selection === undefined ? (
        <>
          <p role="status">{t("aiAssistNothing")}</p>
          <div className="assist-buttons">
            <button type="button" ref={first} onClick={close}>
              {t("close")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="assist-quote">{t("aiAssistOn", { quote: selection.anchor.quote })}</p>
          {reply === undefined ? (
            <>
              <div className="assist-actions" role="group" aria-label={t("aiAssistActions")}>
                {assistActions.map((action, index) => (
                  <button
                    key={action}
                    type="button"
                    ref={index === 0 ? first : undefined}
                    onClick={() => void run(action)}
                  >
                    {t(actionNames[action])}
                  </button>
                ))}
              </div>
              <label className="field">
                {t("aiAssistHow")}
                <input
                  value={how}
                  onChange={(event) => {
                    setHow(event.target.value);
                  }}
                />
              </label>
              <label className="field">
                {t("aiAssistLanguage")}
                <input
                  value={into}
                  onChange={(event) => {
                    setInto(event.target.value);
                  }}
                />
              </label>
              <div className="assist-buttons">
                <button type="button" className="quiet" onClick={close}>
                  {t("aiAssistDiscard")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p role="status" className="assist-status">
                {reply.kind === "writing"
                  ? t("aiAssistWriting")
                  : reply.kind === "done"
                    ? t("aiAssistDone")
                    : reply.kind === "stopped"
                      ? t("aiAssistStopped")
                      : ""}
              </p>
              {reply.kind === "failed" ? <p role="alert">{reply.error}</p> : null}
              {notice === undefined ? null : <p role="alert">{notice}</p>}
              {reply.text === "" ? null : (
                <div
                  className="assist-result"
                  role="region"
                  aria-label={t("aiAssistResult")}
                  tabIndex={0}
                >
                  {reply.kind === "writing" ? reply.text : cleanReply(reply.text)}
                </div>
              )}
              <div className="assist-buttons" ref={buttons}>
                {reply.kind === "writing" ? (
                  <button
                    type="button"
                    onClick={() => {
                      running.current?.abort();
                    }}
                  >
                    {t("aiAssistStop")}
                  </button>
                ) : (
                  <>
                    {done ? (
                      <>
                        <button
                          type="button"
                          className={placement === "replace" ? "primary" : undefined}
                          onClick={() => {
                            put("replace");
                          }}
                        >
                          {t("aiAssistReplace")}
                        </button>
                        <button
                          type="button"
                          className={placement === "after" ? "primary" : undefined}
                          onClick={() => {
                            put("after");
                          }}
                        >
                          {t("aiAssistInsert")}
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={() => void run(reply.action)}>
                      {t("aiAssistRetry")}
                    </button>
                    <button type="button" className="quiet" onClick={close}>
                      {t("aiAssistDiscard")}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

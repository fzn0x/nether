// Building with AI (ADR 0078): what to build and its description, sent to
// the vault's provider, which the dialog names first; then a preview of
// every note it would make, at its path, with what each holds, where the
// name can change and notes can be left out. Nothing is written until the
// user chooses Make it; Cancel makes nothing.
import { AiError, createProvider } from "@nether/ai";
import type { Vault } from "@nether/storage";
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AiProviderEntry } from "./ai.ts";
import { providerWhere } from "./aiWords.ts";
import { backend } from "./backend.ts";
import {
  type Built,
  type BuildKind,
  type PlannedKind,
  buildKinds,
  buildRequest,
  makeBuild,
  planBuild,
  readBuild,
} from "./buildWithAi.ts";
import { type MessageKey, t } from "./messages.ts";
import { useModal } from "./useModal.ts";

const kindNames: Readonly<Record<BuildKind, { label: MessageKey; hint: MessageKey }>> = {
  database: { label: "buildDatabase", hint: "buildDatabaseHint" },
  template: { label: "buildTemplate", hint: "buildTemplateHint" },
  plan: { label: "buildPlan", hint: "buildPlanHint" },
};

const plannedNames: Readonly<Record<PlannedKind, MessageKey>> = {
  database: "buildIsDatabase",
  row: "buildIsRow",
  template: "buildIsTemplate",
  note: "buildIsNote",
};

type Phase =
  | { readonly kind: "describing" }
  | { readonly kind: "writing" }
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "preview";
      readonly built: Built;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "making" };

/** What the database a build makes holds, in words: its properties and its views. */
function schemaWords(built: Built): readonly string[] {
  const database =
    built.kind === "database" ? built : built.kind === "plan" ? built.tasks : undefined;
  if (database === undefined) return [];
  const properties = database.schema.properties.map((property) =>
    property.options === undefined
      ? `${property.key} (${property.type})`
      : `${property.key} (${property.type}: ${property.options.map((option) => option.name).join(", ")})`,
  );
  return [
    t("buildProperties", {
      list: properties.length === 0 ? t("buildNone") : properties.join("; "),
    }),
    t("buildViews", {
      list: database.schema.views.map((view) => `${view.name} (${view.layout})`).join("; "),
    }),
  ];
}

export function BuildDialog(props: {
  readonly vault: Vault;
  readonly provider: AiProviderEntry;
  /** The workspace the vault syncs with, whose relay the web app sends through (ADR 0070). */
  readonly workspaceId: string | undefined;
  /** The server the description goes through first, by its host, as in the web app. */
  readonly through: string | undefined;
  readonly allowedNow: () => Promise<boolean>;
  /** Where templates go. */
  readonly templatesFolder: string;
  /** Opens a note the build made, by its path. */
  readonly onOpen: (path: string) => void;
  readonly onClose: () => void;
}) {
  const { vault, provider, workspaceId, through, allowedNow, templatesFolder, onOpen, onClose } =
    props;
  const [kind, setKind] = useState<BuildKind>("database");
  const [description, setDescription] = useState("");
  const [sampleRows, setSampleRows] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "describing" });
  const [name, setName] = useState("");
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set());
  const running = useRef<AbortController | undefined>(undefined);
  const dialog = useRef<HTMLFormElement>(null);
  useModal(dialog);
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  const built = phase.kind === "preview" ? phase.built : undefined;
  // The plan follows the name, at paths the vault does not have.
  const planned = useMemo(
    () =>
      built === undefined
        ? undefined
        : planBuild(vault, built, name.trim() === "" ? built.name : name, templatesFolder),
    [vault, built, name, templatesFolder],
  );

  const build = async () => {
    const controller = new AbortController();
    running.current = controller;
    setPhase({ kind: "writing" });
    const ask = { kind, description, sampleRows };
    try {
      if (!(await allowedNow())) {
        setPhase({ kind: "failed", error: t("aiWorkspaceOffNow") });
        return;
      }
      const access = await backend.aiAccess(provider, workspaceId);
      const chat = createProvider(
        {
          kind: provider.kind === "anthropic" ? "anthropic" : "openai",
          url: access.url,
          model: provider.model,
        },
        { fetch: access.fetch, key: access.key },
      );
      let reply = "";
      for await (const part of chat.chat({ ...buildRequest(ask), signal: controller.signal })) {
        reply += part;
      }
      const read = readBuild(reply, ask);
      setName(read.built.name);
      setLeftOut(new Set());
      setPhase({ kind: "preview", built: read.built, warnings: read.warnings });
    } catch (error) {
      if (controller.signal.aborted) {
        setPhase({ kind: "describing" });
        return;
      }
      const who = provider.name;
      setPhase({
        kind: "failed",
        error:
          error instanceof AiError
            ? error.kind === "refused"
              ? t("aiAssistRefused", { name: who })
              : t("aiAssistFailed", { name: who, error: error.message })
            : t("buildUnread", { error: error instanceof Error ? error.message : String(error) }),
      });
    } finally {
      if (running.current === controller) running.current = undefined;
    }
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (phase.kind === "preview" && planned !== undefined) {
      setPhase({ kind: "making" });
      makeBuild(vault, planned, leftOut).then(
        (open) => {
          onClose();
          if (open !== undefined) onOpen(open);
        },
        (error: unknown) => {
          setPhase({
            kind: "failed",
            error: t("buildFailed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          });
        },
      );
      return;
    }
    if (description.trim() === "" || phase.kind === "writing") return;
    void build();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      running.current?.abort();
      onClose();
    }
  };

  const describing = phase.kind === "describing" || phase.kind === "failed";
  return (
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && phase.kind !== "making") onClose();
      }}
    >
      <form
        className="switcher dialog build-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-title"
        onSubmit={submit}
        onKeyDown={onKeyDown}
      >
        <h2 id="build-title">{t("buildTitle")}</h2>
        <p className="hint">
          {through === undefined
            ? t("buildSends", { name: provider.name, where: providerWhere(provider) })
            : t("buildSendsThrough", {
                name: provider.name,
                where: providerWhere(provider, true),
                server: through,
              })}
        </p>
        {describing || phase.kind === "writing" ? (
          <fieldset disabled={phase.kind === "writing"} className="build-describe">
            <legend>{t("buildWhat")}</legend>
            {buildKinds.map((each) => (
              <label key={each} className="field-check">
                <input
                  type="radio"
                  name="build-kind"
                  checked={kind === each}
                  onChange={() => {
                    setKind(each);
                  }}
                />
                {t(kindNames[each].label)}
                <span className="hint">{t(kindNames[each].hint)}</span>
              </label>
            ))}
            <label className="field">
              {t("buildDescribe")}
              <textarea
                rows={4}
                autoFocus
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </label>
            {kind === "database" ? (
              <label className="field-check">
                <input
                  type="checkbox"
                  checked={sampleRows}
                  onChange={(event) => {
                    setSampleRows(event.target.checked);
                  }}
                />
                {t("buildSampleRows")}
              </label>
            ) : null}
          </fieldset>
        ) : null}
        {phase.kind === "writing" ? <p role="status">{t("aiAssistWriting")}</p> : null}
        {phase.kind === "failed" ? <p role="alert">{phase.error}</p> : null}
        {phase.kind === "preview" && planned !== undefined ? (
          <div className="build-preview">
            <p role="status">{t("buildPreview")}</p>
            <label className="field">
              {t("buildName")}
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            {phase.warnings.length === 0 ? null : (
              <ul className="import-warnings">
                {phase.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <ul className="build-notes" aria-label={t("buildWillMake")}>
              {planned.plan.notes.map((note) => {
                const what = planned.kinds.get(note.path) ?? "note";
                // The database and the template are what is built; the rest can be left out.
                const optional = what === "row" || what === "note";
                const kept = !leftOut.has(note.path);
                return (
                  <li key={note.path}>
                    {optional ? (
                      <label className="field-check">
                        <input
                          type="checkbox"
                          checked={kept}
                          onChange={(event) => {
                            const next = new Set(leftOut);
                            if (event.target.checked) next.delete(note.path);
                            else next.add(note.path);
                            setLeftOut(next);
                          }}
                        />
                        <span className="build-path">{note.path}</span>
                      </label>
                    ) : (
                      <span className="build-path">{note.path}</span>
                    )}
                    <span className="hint">{t(plannedNames[what])}</span>
                    {(what === "database" ? schemaWords(phase.built) : []).map((words) => (
                      <p key={words} className="hint">
                        {words}
                      </p>
                    ))}
                    {what === "template" || what === "note" ? (
                      <pre className="build-text">
                        {note.text.split("\n").slice(0, 12).join("\n")}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {phase.kind === "making" ? <p role="status">{t("buildMaking")}</p> : null}
        <div className="dialog-actions">
          {phase.kind === "writing" ? (
            <button
              type="button"
              onClick={() => {
                running.current?.abort();
              }}
            >
              {t("aiAssistStop")}
            </button>
          ) : (
            <button type="button" className="quiet" onClick={onClose}>
              {t("cancel")}
            </button>
          )}
          {phase.kind === "preview" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setPhase({ kind: "describing" });
                }}
              >
                {t("buildChange")}
              </button>
              <button type="submit" className="primary">
                {t("buildMake")}
              </button>
            </>
          ) : phase.kind === "writing" || phase.kind === "making" ? null : (
            <button type="submit" className="primary" disabled={description.trim() === ""}>
              {t("buildStart")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

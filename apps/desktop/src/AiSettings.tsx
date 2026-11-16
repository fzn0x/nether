// The AI tab of the vault's settings (ADR 0068): the providers set up on
// this device, each key kept in the system's keychain; which one this
// vault uses, or none; and for a vault that syncs, its workspace's switch,
// which its owners and admins change for everyone in it. It is the one
// place AI shows before a provider is set up.
import { type ProviderKind, providerUrl } from "@nether/ai";
import { type SyntheticEvent, useEffect, useState } from "react";
import type { VaultAiChoice } from "./ai.ts";
import { providerWhere } from "./aiWords.ts";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import type { AIProvider } from "./mygo.ts";
import { hostOf } from "./sync.ts";
import type { VaultAi } from "./useAi.ts";

interface Draft {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly url: string;
  readonly model: string;
  /** A new key to keep; empty keeps the one kept, if any. */
  readonly key: string;
  readonly hasKey: boolean;
  readonly removeKey: boolean;
}

const anthropicUrl = "https://api.anthropic.com";

const blank: Draft = {
  id: "",
  name: "",
  kind: "openai",
  url: "",
  model: "",
  key: "",
  hasKey: false,
  removeKey: false,
};

function draftOf(provider: AIProvider): Draft {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind === "anthropic" ? "anthropic" : "openai",
    url: provider.url,
    model: provider.model,
    key: "",
    hasKey: provider.hasKey,
    removeKey: false,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A provider's fields, to add one or change one. */
function ProviderForm(props: {
  readonly draft: Draft;
  readonly onSave: (draft: Draft) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { onSave, onCancel } = props;
  const [draft, setDraft] = useState(props.draft);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const change = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };
  const field = (name: string) => `ai-provider-${name}`;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (draft.name.trim() === "" || draft.model.trim() === "") {
      setError(t("aiNeedsNameModel"));
      return;
    }
    const url = providerUrl(draft.url);
    if (url === undefined) {
      setError(t("aiBadUrl"));
      return;
    }
    setBusy(true);
    setError(undefined);
    onSave({ ...draft, url }).catch((reason: unknown) => {
      setError(message(reason));
      setBusy(false);
    });
  };

  return (
    <form className="ai-provider-form" onSubmit={submit}>
      <fieldset>
        <legend>
          {draft.id === "" ? t("aiAddProvider") : t("aiEditProvider", { name: props.draft.name })}
        </legend>
        <label className="field">
          {t("aiProviderName")}
          <input
            value={draft.name}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
          />
        </label>
        <label className="field">
          {t("aiProviderKind")}
          <select
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value === "anthropic" ? "anthropic" : "openai";
              // Anthropic's address is known; an OpenAI-compatible one is the user's.
              const url =
                kind === "anthropic" && draft.url.trim() === ""
                  ? anthropicUrl
                  : kind === "openai" && draft.url === anthropicUrl
                    ? ""
                    : draft.url;
              change({ kind, url });
            }}
          >
            <option value="openai">{t("aiKindOpenai")}</option>
            <option value="anthropic">{t("aiKindAnthropic")}</option>
          </select>
        </label>
        {/* The hints describe their fields, apart from their names. */}
        <div className="field">
          <label htmlFor={field("url")}>{t("aiProviderUrl")}</label>
          <input
            id={field("url")}
            value={draft.url}
            spellCheck={false}
            inputMode="url"
            aria-describedby={field("url-hint")}
            onChange={(event) => {
              change({ url: event.target.value });
            }}
          />
          <span className="hint" id={field("url-hint")}>
            {draft.kind === "anthropic"
              ? t("aiProviderUrlHintAnthropic")
              : t("aiProviderUrlHintOpenai")}
          </span>
        </div>
        <div className="field">
          <label htmlFor={field("model")}>{t("aiProviderModel")}</label>
          <input
            id={field("model")}
            value={draft.model}
            spellCheck={false}
            aria-describedby={field("model-hint")}
            onChange={(event) => {
              change({ model: event.target.value });
            }}
          />
          <span className="hint" id={field("model-hint")}>
            {t("aiProviderModelHint")}
          </span>
        </div>
        <div className="field">
          <label htmlFor={field("key")}>{t("aiProviderKey")}</label>
          <input
            id={field("key")}
            type="password"
            value={draft.key}
            autoComplete="off"
            spellCheck={false}
            disabled={draft.removeKey}
            aria-describedby={field("key-hint")}
            onChange={(event) => {
              change({ key: event.target.value });
            }}
          />
          <span className="hint" id={field("key-hint")}>
            {draft.hasKey ? t("aiProviderKeyKept") : t("aiProviderKeyHint")}
          </span>
        </div>
        {draft.hasKey ? (
          <label className="field-check">
            <input
              type="checkbox"
              checked={draft.removeKey}
              onChange={(event) => {
                change({ removeKey: event.target.checked, key: "" });
              }}
            />
            {t("aiRemoveKey")}
          </label>
        ) : null}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {t("save")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/** The select's value for a vault's choice. */
function choiceValue(choice: VaultAiChoice): string {
  return choice.kind === "provider" ? `provider:${choice.id}` : choice.kind;
}

function choiceOf(value: string): VaultAiChoice {
  if (value === "off") return { kind: "off" };
  if (value.startsWith("provider:")) return { kind: "provider", id: value.slice(9) };
  return { kind: "default" };
}

export function AiSettings(props: {
  readonly ai: VaultAi;
  /** Whether the vault syncs with an end-to-end encrypted workspace. */
  readonly encrypted: boolean;
  /** The server the vault syncs with, to name it when it cannot be reached. */
  readonly server: string | undefined;
  readonly onClose: () => void;
}) {
  const { ai, encrypted, server, onClose } = props;
  const { settings, choice, workspace, resolution, lookUpWorkspace } = ai;
  const [editing, setEditing] = useState<Draft | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Its owners and admins change the workspace's switch here, AI set up or not.
  useEffect(lookUpWorkspace, [lookUpWorkspace]);

  const act = (work: () => Promise<void>) => {
    setError(undefined);
    work().then(ai.reload, (reason: unknown) => {
      setError(message(reason));
    });
  };

  const save = async (draft: Draft) => {
    const kept = await backend.saveAiProvider({
      id: draft.id,
      name: draft.name,
      kind: draft.kind,
      url: draft.url,
      model: draft.model,
      hasKey: draft.hasKey,
    });
    if (draft.removeKey) await backend.setAiKey(kept.id, "");
    else if (draft.key !== "") await backend.setAiKey(kept.id, draft.key);
    setEditing(undefined);
    ai.reload();
  };

  const fallback = settings.providers.find((provider) => provider.id === settings.default);
  const manages = workspace?.role === "owner" || workspace?.role === "admin";

  return (
    <div className="settings-form ai-settings">
      <h3>{t("aiTab")}</h3>
      <div className="dialog-body">
        <p className="hint">{t("aiIntro")}</p>
        <h4>{t("aiProviders")}</h4>
        {settings.providers.length === 0 ? (
          <p className="hint">{t("aiNoProviders")}</p>
        ) : (
          <ul className="plugin-list ai-providers">
            {settings.providers.map((provider) => {
              const nameId = `ai-name-${provider.id}`;
              const isDefault = provider.id === settings.default;
              return (
                <li key={provider.id}>
                  <div className="ai-provider-head">
                    <strong id={nameId}>{provider.name}</strong>
                    {isDefault ? <span className="ai-default">{t("aiIsDefault")}</span> : null}
                  </div>
                  <p className="hint">{providerWhere(provider)}</p>
                  <div className="ai-provider-actions">
                    <button
                      type="button"
                      className="quiet"
                      id={`ai-edit-${provider.id}`}
                      aria-labelledby={`ai-edit-${provider.id} ${nameId}`}
                      onClick={() => {
                        setEditing(draftOf(provider));
                      }}
                    >
                      {t("edit")}
                    </button>
                    {isDefault ? null : (
                      <button
                        type="button"
                        className="quiet"
                        id={`ai-default-${provider.id}`}
                        aria-labelledby={`ai-default-${provider.id} ${nameId}`}
                        onClick={() => {
                          act(() => backend.setDefaultAiProvider(provider.id));
                        }}
                      >
                        {t("aiMakeDefault")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="quiet"
                      id={`ai-remove-${provider.id}`}
                      aria-labelledby={`ai-remove-${provider.id} ${nameId}`}
                      onClick={() => {
                        act(async () => {
                          await backend.removeAiProvider(provider.id);
                          if (choice.kind === "provider" && choice.id === provider.id) {
                            await ai.setChoice({ kind: "default" });
                          }
                        });
                      }}
                    >
                      {t("aiRemoveProvider")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {editing === undefined ? (
          <div>
            <button
              type="button"
              onClick={() => {
                setEditing(blank);
              }}
            >
              {t("aiAddProvider")}
            </button>
          </div>
        ) : (
          <ProviderForm
            key={editing.id}
            draft={editing}
            onSave={save}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        )}
        {settings.providers.length === 0 ? null : (
          <>
            <h4>{t("aiVault")}</h4>
            <label className="field">
              {t("aiVaultUses")}
              <select
                value={choiceValue(choice)}
                disabled={workspace?.on === false}
                onChange={(event) => {
                  const next = choiceOf(event.target.value);
                  act(() => ai.setChoice(next));
                }}
              >
                <option value="default">
                  {encrypted || fallback === undefined
                    ? t("aiVaultNoDefault")
                    : t("aiVaultDefault", { name: fallback.name })}
                </option>
                {settings.providers.map((provider) => (
                  <option key={provider.id} value={`provider:${provider.id}`}>
                    {`${provider.name}, ${providerWhere(provider)}`}
                  </option>
                ))}
                <option value="off">{t("aiVaultOff")}</option>
              </select>
            </label>
            {encrypted ? <p className="hint">{t("aiVaultEncrypted")}</p> : null}
            {resolution.reason === "missing" ? <p role="status">{t("aiVaultMissing")}</p> : null}
          </>
        )}
        {workspace === undefined ? null : (
          <>
            {manages ? (
              <>
                <label className="field-check">
                  <input
                    type="checkbox"
                    checked={workspace.on}
                    aria-describedby="ai-workspace-hint"
                    onChange={(event) => {
                      const on = event.target.checked;
                      act(() => ai.setWorkspace(on));
                    }}
                  />
                  {t("aiWorkspaceAllows", { workspace: workspace.name })}
                </label>
                <p className="hint" id="ai-workspace-hint">
                  {t("aiWorkspaceAllowsHint")}
                </p>
              </>
            ) : workspace.on ? null : (
              <p role="status">{t("aiWorkspaceOff", { workspace: workspace.name })}</p>
            )}
            {workspace.error === undefined || server === undefined ? null : (
              <p className="hint">
                {t("aiWorkspaceUnreachable", {
                  server: hostOf(server),
                  workspace: workspace.name,
                  error: workspace.error,
                })}
              </p>
            )}
          </>
        )}
        {error === undefined ? null : <p role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="quiet" onClick={onClose}>
          {t("close")}
        </button>
      </div>
    </div>
  );
}

// Search by meaning in the AI tab (ADR 0074): for this vault, on this
// device, an OpenAI-compatible provider and its embedding model; what turning
// it on sends; how far the vault's embedding has come; and turning it off.
import { type SyntheticEvent, useState } from "react";
import type { AiProviderEntry } from "./ai.ts";
import { t } from "./messages.ts";
import type { VaultMeaning } from "./useMeaning.ts";

const numbers = new Intl.NumberFormat();

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** What search by meaning is doing, while it is on. */
function statusOf(meaning: VaultMeaning, providers: readonly AiProviderEntry[]): string {
  const { choice, blocked, progress } = meaning;
  if (choice === undefined) return "";
  if (blocked === "vaultOff") return t("aiMeaningWaitsVault");
  if (blocked === "workspaceOff") return t("aiMeaningWaitsWorkspace");
  if (blocked === "missing") return t("aiMeaningWaitsProvider");
  if (blocked === "notApproved") return t("aiMeaningWaitsApproved");
  if (progress?.error !== undefined) return t("meaningWaiting", { error: progress.error });
  if (progress === undefined || (!progress.passed && progress.total === 0)) {
    return t("aiMeaningStarting");
  }
  if (!progress.passed || progress.done < progress.total) {
    return t("meaningEmbedding", {
      done: numbers.format(progress.done),
      total: numbers.format(progress.total),
    });
  }
  const provider = providers.find((each) => each.id === choice.provider);
  return t("aiMeaningOn", { model: choice.model, provider: provider?.name ?? choice.provider });
}

export function MeaningSettings(props: {
  readonly meaning: VaultMeaning;
  readonly providers: readonly AiProviderEntry[];
}) {
  const { meaning, providers } = props;
  const { choice } = meaning;
  const embedders = providers.filter((provider) => provider.kind === "openai");
  const [provider, setProvider] = useState(choice?.provider ?? embedders[0]?.id ?? "");
  const [model, setModel] = useState(choice?.model ?? "");
  const [error, setError] = useState<string | undefined>();
  const chosen = embedders.some((each) => each.id === provider)
    ? provider
    : (embedders[0]?.id ?? "");
  const typed = model.trim();
  const same = choice?.provider === chosen && choice.model === typed;

  const turnOn = (event: SyntheticEvent) => {
    event.preventDefault();
    if (chosen === "" || typed === "" || same) return;
    setError(undefined);
    meaning.setChoice({ provider: chosen, model: typed }).catch((reason: unknown) => {
      setError(message(reason));
    });
  };

  return (
    <section className="ai-meaning" aria-labelledby="ai-meaning-title">
      <h4 id="ai-meaning-title">{t("aiMeaning")}</h4>
      <p className="hint">{t("aiMeaningIntro")}</p>
      {embedders.length === 0 ? (
        <p className="hint">{t("aiMeaningNeedsOpenai")}</p>
      ) : (
        <form onSubmit={turnOn}>
          <label className="field">
            {t("aiMeaningProvider")}
            <select
              value={chosen}
              onChange={(event) => {
                setProvider(event.target.value);
              }}
            >
              {embedders.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("aiMeaningModel")}
            <input
              type="text"
              value={model}
              placeholder="text-embedding-3-small"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setModel(event.target.value);
              }}
            />
          </label>
          <p className="hint">{t("aiMeaningSends")}</p>
          <div className="ai-meaning-actions">
            <button type="submit" disabled={chosen === "" || typed === "" || same}>
              {choice === undefined ? t("aiMeaningTurnOn") : t("aiMeaningUse")}
            </button>
            {choice === undefined ? null : (
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  setError(undefined);
                  meaning.setChoice(undefined).catch((reason: unknown) => {
                    setError(message(reason));
                  });
                }}
              >
                {t("aiMeaningTurnOff")}
              </button>
            )}
          </div>
        </form>
      )}
      {choice === undefined ? null : <p role="status">{statusOf(meaning, providers)}</p>}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}

// Search by meaning for the open vault (ADR 0074): its choice on this
// device, its notes embedded in the background while it is on and AI is
// allowed, and the search the sidebar runs. While it is off, or AI is off
// for the vault or its workspace, nothing runs and nothing is sent. The
// workspace's switch is asked again before each search, and at most once a
// minute while the vault is embedded. The indexer, the search and the AI
// adapters load only while it is on. The desktop app has it; the web app,
// whose AI goes through its server, has none yet.
import type { Vault } from "@nether/storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend } from "./backend.ts";
import type { Embed, MeaningProgress, MeaningSearch } from "./meaning.ts";
import { type MeaningChoice, meaningChoice, setMeaningChoice } from "./meaningChoice.ts";
import { t } from "./messages.ts";
import type { MeaningPanel } from "./SearchPanel.tsx";
import type { VaultLink } from "./sync.ts";
import type { VaultAi } from "./useAi.ts";

/** Why search by meaning is chosen but does not run. */
export type MeaningBlock = "vaultOff" | "workspaceOff" | "missing";

export interface VaultMeaning {
  /** Whether this app offers it: the desktop app does, the web app not yet. */
  readonly offered: boolean;
  /** Whether the vault's choice has been read. */
  readonly loaded: boolean;
  /** The provider and model, while search by meaning is on. */
  readonly choice: MeaningChoice | undefined;
  /** Why it is on but does not run, if it does not. */
  readonly blocked: MeaningBlock | undefined;
  /** How far embedding the vault has come, while it runs. */
  readonly progress: MeaningProgress | undefined;
  readonly setChoice: (choice: MeaningChoice | undefined) => Promise<void>;
  /** The search panel's search by meaning, while it runs. */
  readonly panel: MeaningPanel | undefined;
}

/** How long the workspace's word holds for the vault's embedding. */
const askEvery = 60_000;

export function useMeaning(
  vault: Vault | undefined,
  ai: VaultAi,
  link: VaultLink | undefined,
): VaultMeaning {
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoiceState] = useState<MeaningChoice | undefined>();
  const [progress, setProgress] = useState<MeaningProgress | undefined>();
  const [search, setSearch] = useState<MeaningSearch | undefined>();

  useEffect(() => {
    setLoaded(false);
    setChoiceState(undefined);
    if (vault === undefined) return;
    let current = true;
    void meaningChoice(vault).then((found) => {
      if (!current) return;
      setChoiceState(found);
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [vault]);

  // The web app's providers are its server's, which keeps no embedding model.
  const offered = ai.settings.server === undefined;
  const provider =
    choice === undefined || !offered
      ? undefined
      : ai.settings.providers.find((each) => each.id === choice.provider && each.kind === "openai");
  const reason = ai.resolution.reason;
  const blocked: MeaningBlock | undefined =
    choice === undefined
      ? undefined
      : reason === "vaultOff" || reason === "workspaceOff"
        ? reason
        : provider === undefined
          ? "missing"
          : undefined;

  const allowedNow = useRef(ai.allowedNow);
  allowedNow.current = ai.allowedNow;
  const workspaceId = link?.workspaceId;

  /** Sends texts to the chosen model, through this device's access to the provider. */
  const embedWith = useMemo((): Embed | undefined => {
    if (choice === undefined || provider === undefined || blocked !== undefined) return undefined;
    return async (inputs, signal) => {
      const [{ createProvider }, access] = await Promise.all([
        import("@nether/ai"),
        backend.aiAccess(provider, workspaceId),
      ]);
      const model = createProvider(
        { kind: "openai", url: access.url, model: provider.model },
        { fetch: access.fetch, key: access.key },
      );
      return model.embed({ model: choice.model, input: inputs, signal });
    };
  }, [choice, provider, blocked, workspaceId]);

  /** The same, for the vault's embedding: the workspace's switch asked at most once a minute. */
  const background = useMemo((): Embed | undefined => {
    if (embedWith === undefined) return undefined;
    let asked = 0;
    return async (inputs, signal) => {
      if (Date.now() - asked > askEvery) {
        if (!(await allowedNow.current())) throw new Error(t("aiWorkspaceOffNow"));
        asked = Date.now();
      }
      return embedWith(inputs, signal);
    };
  }, [embedWith]);

  useEffect(() => {
    setProgress(undefined);
    setSearch(undefined);
    if (vault === undefined || choice === undefined || background === undefined) return;
    let stop: (() => void) | undefined;
    let current = true;
    void import("./meaning.ts").then(({ MeaningIndexer, MeaningSearch }) => {
      if (!current) return;
      const indexer = new MeaningIndexer(vault, choice, background);
      const searching = new MeaningSearch(vault);
      const stopProgress = indexer.subscribe(setProgress);
      const stopStored = indexer.onStored(() => {
        searching.forget();
      });
      setSearch(searching);
      void indexer.start();
      stop = () => {
        stopProgress();
        stopStored();
        indexer.stop();
        searching.forget();
      };
    });
    return () => {
      current = false;
      stop?.();
    };
  }, [vault, choice, background]);

  const setChoice = useCallback(
    async (next: MeaningChoice | undefined) => {
      if (vault === undefined) return;
      await setMeaningChoice(vault, next);
      setChoiceState(next);
    },
    [vault],
  );

  const panel = useMemo((): MeaningPanel | undefined => {
    if (search === undefined || embedWith === undefined) return undefined;
    return {
      async search(text) {
        if (!(await allowedNow.current())) throw new Error(t("aiWorkspaceOffNow"));
        const [vector] = await embedWith([text], new AbortController().signal);
        return vector === undefined ? [] : search.search(vector);
      },
      progress,
    };
  }, [search, embedWith, progress]);

  return { offered, loaded, choice, blocked, progress, setChoice, panel };
}

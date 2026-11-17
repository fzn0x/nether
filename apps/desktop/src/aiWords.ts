// How the app names where an AI provider is, so the user knows where text
// goes before it is sent (ADR 0068). Loaded with the AI tab and the assist.
import { hostOf, isLocal } from "@nether/ai";
import { t } from "./messages.ts";
import type { AIProvider } from "./mygo.ts";

/** A provider's model and where it runs: on this computer, or at a host. */
export function providerWhere(provider: Pick<AIProvider, "model" | "url">): string {
  return isLocal(provider.url)
    ? t("aiWhereLocal", { model: provider.model })
    : t("aiWhere", { model: provider.model, host: hostOf(provider.url) });
}

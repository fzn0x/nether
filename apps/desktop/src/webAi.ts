// The web app's AI, through its server (ADR 0070): the providers the
// server keeps, the account's own and everyone's, changed through its API,
// and each request sent to the server's relay for the workspace, which adds
// the provider's key. The page never holds a key, and talks to its own
// origin alone, as its content security policy has it.
import type { AiProviderEntry, AiSettingsView, ServerAi } from "./ai.ts";
import type { AiAccess } from "./backend.ts";
import { t } from "./messages.ts";
import type { AIProvider } from "./mygo.ts";
import { request } from "./server.ts";
import { webFetch, webServer } from "./web.ts";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A provider as the server gives it. */
function entryOf(value: unknown): AiProviderEntry {
  const item = record(value);
  return {
    id: text(item.id),
    name: text(item.name),
    kind: text(item.kind),
    url: text(item.url),
    model: text(item.model),
    hasKey: item.hasKey === true,
    scope: item.scope === "instance" ? "instance" : "own",
  };
}

function serverOf(answer: Readonly<Record<string, unknown>>): ServerAi {
  const manage = record(answer.manage);
  return {
    mode: answer.mode === "admin" || answer.mode === "off" ? answer.mode : "on",
    keepsKeys: answer.keepsKeys === true,
    manage: { own: manage.own === true, instance: manage.instance === true },
    // The endpoints its admin locks AI to (ADR 0086); a server from before locks nothing.
    endpoints: Array.isArray(answer.endpoints)
      ? (answer.endpoints as unknown[]).filter(
          (endpoint): endpoint is string => typeof endpoint === "string",
        )
      : null,
  };
}

const call = (path: string, options: Parameters<typeof request>[3] = {}) =>
  request(webFetch, webServer, path, options);

export async function webAiSettings(): Promise<AiSettingsView> {
  const answer = record(await call("/api/ai"));
  const providers = Array.isArray(answer.providers) ? answer.providers.map(entryOf) : [];
  return { providers, default: text(answer.default), server: serverOf(answer) };
}

export async function saveWebAiProvider(
  provider: AIProvider,
  scope: "own" | "instance" = "own",
): Promise<AIProvider> {
  const fields = {
    name: provider.name,
    kind: provider.kind,
    url: provider.url,
    model: provider.model,
  };
  const answer =
    provider.id === ""
      ? await call("/api/ai/providers", { method: "POST", body: { ...fields, scope } })
      : await call(`/api/ai/providers/${provider.id}`, { method: "PATCH", body: fields });
  return entryOf(answer);
}

export async function setWebAiKey(id: string, key: string): Promise<void> {
  await call(`/api/ai/providers/${id}`, {
    method: "PATCH",
    body: { key: key === "" ? null : key },
  });
}

export async function removeWebAiProvider(id: string): Promise<void> {
  await call(`/api/ai/providers/${id}`, { method: "DELETE" });
}

export async function setWebAiDefault(id: string): Promise<void> {
  await call("/api/ai/default", { method: "PUT", body: { provider: id } });
}

/**
 * The relay for a provider in a workspace: the adapter's calls go to it as
 * they would to the provider, and the server sends them on.
 */
export function webAiAccess(
  provider: AIProvider,
  workspaceId: string | undefined,
): Promise<AiAccess> {
  if (workspaceId === undefined) {
    return Promise.reject(new Error(t("aiRelayNeedsWorkspace")));
  }
  return Promise.resolve({
    url: `${webServer}/api/workspaces/${workspaceId}/ai/${provider.id}`,
    fetch: webFetch,
    key: undefined,
  });
}

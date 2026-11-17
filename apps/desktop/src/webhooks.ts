// A workspace's webhooks (ADR 0060), as the app manages them for its
// owners and admins with the account's session: listed, added, changed,
// turned off and on, given a new secret, tested and removed, with their
// recent deliveries. A webhook's secret is in the answer that makes it or
// gives it a new one, and never again.
import { t } from "./messages.ts";
import { ServerError, request } from "./server.ts";

type Fetch = typeof fetch;

export const webhookEvents = ["note.created", "note.updated", "note.deleted"] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly enabled: boolean;
  /** Since when its events fail with no success between; null while they arrive. */
  readonly failingSince: string | null;
  readonly lastError: string | null;
  readonly maker: { readonly id: string; readonly name: string };
  readonly createdAt: string;
}

export interface Delivery {
  readonly id: string;
  readonly type: string;
  readonly status: "waiting" | "sent" | "failed";
  readonly attempts: number;
  /** The last answer's status, if one came. */
  readonly answer: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly nextAt: string | null;
  readonly finishedAt: string | null;
}

export interface WebhookChange {
  readonly url?: string;
  readonly events?: readonly WebhookEvent[];
  readonly enabled?: boolean;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, base: string): string {
  if (typeof value !== "string") throw new ServerError(0, t("serverOddAnswer", { server: base }));
  return value;
}

function textOrNull(value: unknown, base: string): string | null {
  return value === null || value === undefined ? null : text(value, base);
}

function isEvent(value: unknown): value is WebhookEvent {
  return (webhookEvents as readonly unknown[]).includes(value);
}

function webhookOf(value: unknown, base: string): Webhook {
  const hook = record(value);
  const maker = record(hook.maker);
  return {
    id: text(hook.id, base),
    url: text(hook.url, base),
    events: Array.isArray(hook.events) ? hook.events.filter(isEvent) : [],
    enabled: hook.enabled === true,
    failingSince: textOrNull(hook.failingSince, base),
    lastError: textOrNull(hook.lastError, base),
    maker: { id: text(maker.id, base), name: text(maker.name, base) },
    createdAt: text(hook.createdAt, base),
  };
}

function deliveryOf(value: unknown, base: string): Delivery {
  const item = record(value);
  return {
    id: text(item.id, base),
    type: text(item.type, base),
    status: item.status === "sent" ? "sent" : item.status === "failed" ? "failed" : "waiting",
    attempts: typeof item.attempts === "number" ? item.attempts : 0,
    answer: typeof item.answer === "number" ? item.answer : null,
    error: textOrNull(item.error, base),
    createdAt: text(item.createdAt, base),
    nextAt: textOrNull(item.nextAt, base),
    finishedAt: textOrNull(item.finishedAt, base),
  };
}

function path(workspaceId: string, rest = ""): string {
  return `/api/v1/workspaces/${workspaceId}/webhooks${rest}`;
}

/** A workspace's webhooks; refused to those who are not its owners or admins. */
export async function webhooks(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
): Promise<Webhook[]> {
  const answer = record(await request(fetcher, base, path(workspaceId), { token: session }));
  const list = Array.isArray(answer.webhooks) ? (answer.webhooks as unknown[]) : [];
  return list.map((item) => webhookOf(item, base));
}

/** Adds a webhook; its secret is given this once. */
export async function addWebhook(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
  url: string,
  events: readonly WebhookEvent[],
): Promise<{ readonly webhook: Webhook; readonly secret: string }> {
  const answer = await request(fetcher, base, path(workspaceId), {
    token: session,
    body: { url, events },
  });
  return { webhook: webhookOf(answer, base), secret: text(record(answer).secret, base) };
}

/** Changes a webhook's address, events, or whether it is on. */
export async function changeWebhook(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
  id: string,
  change: WebhookChange,
): Promise<Webhook> {
  const answer = await request(fetcher, base, path(workspaceId, `/${id}`), {
    method: "PATCH",
    token: session,
    body: change,
  });
  return webhookOf(answer, base);
}

/** Gives a webhook a new secret, which replaces the old one at once. */
export async function rollWebhookSecret(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
  id: string,
): Promise<string> {
  const answer = await request(fetcher, base, path(workspaceId, `/${id}/secret`), {
    method: "POST",
    token: session,
    body: {},
  });
  return text(record(answer).secret, base);
}

/** Sends a webhook a test event, as soon as the server's worker next runs. */
export async function testWebhook(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
  id: string,
): Promise<void> {
  await request(fetcher, base, path(workspaceId, `/${id}/test`), {
    method: "POST",
    token: session,
    body: {},
  });
}

export async function removeWebhook(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
  id: string,
): Promise<void> {
  await request(fetcher, base, path(workspaceId, `/${id}`), { method: "DELETE", token: session });
}

/** A webhook's last 50 events, the latest first. */
export async function webhookDeliveries(
  fetcher: Fetch,
  base: string,
  session: string,
  workspaceId: string,
  id: string,
): Promise<Delivery[]> {
  const answer = record(
    await request(fetcher, base, path(workspaceId, `/${id}/deliveries`), { token: session }),
  );
  const list = Array.isArray(answer.deliveries) ? (answer.deliveries as unknown[]) : [];
  return list.map((item) => deliveryOf(item, base));
}

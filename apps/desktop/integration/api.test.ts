// The REST API's tokens and the workspace's webhooks as the app manages
// them (ADRs 0059 and 0060), through a real Nether server: tokens made with
// the password, shown once and revoked; webhooks added, refused for an
// address the server will not reach, changed, given a new secret, tested
// and removed.
import type { AddressInfo } from "node:net";
import { buildApp } from "@nether/server/src/app.ts";
import { readConfig } from "@nether/server/src/config.ts";
import type { Database } from "@nether/server/src/db.ts";
import { migrate } from "@nether/server/src/migrations.ts";
import { newSetupCode } from "@nether/server/src/setup.ts";
import { testDatabase } from "@nether/server/test/database.ts";
import { freePort } from "@nether/server/test/ports.ts";
import { afterEach, describe, expect, it } from "vitest";
import { apiTokens, makeApiToken, revokeApiToken } from "../src/apiTokens.ts";
import { ServerError } from "../src/server.ts";
import {
  addWebhook,
  changeWebhook,
  removeWebhook,
  rollWebhookSecret,
  testWebhook,
  webhookDeliveries,
  webhooks,
} from "../src/webhooks.ts";

const password = "a long password";
const config = readConfig({
  NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether",
  NETHER_LOG_LEVEL: "silent",
});

let server: Awaited<ReturnType<typeof buildApp>> | undefined;
let db: Database | undefined;

afterEach(async () => {
  await server?.close();
  await db?.close();
  server = undefined;
  db = undefined;
});

/** A server set up with Ada and her workspace, its worker off, as nothing here is sent. */
async function startServer() {
  db = await testDatabase();
  await migrate(db);
  const setupCode = newSetupCode();
  server = await buildApp(config, { db, setupCode, webhookWorker: false });
  await server.listen({ host: "127.0.0.1", port: await freePort() });
  const url = `http://127.0.0.1:${String((server.server.address() as AddressInfo).port)}`;
  const response = await fetch(`${url}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: setupCode,
      name: "Ada",
      email: "ada@example.org",
      password,
      workspace: "Team",
    }),
  });
  const body = (await response.json()) as { token: string; workspace: { id: string } };
  return { url, session: body.token, workspaceId: body.workspace.id };
}

describe("API tokens in the app", () => {
  it("are made with the password, shown once, listed and revoked", async () => {
    const { url, session, workspaceId } = await startServer();
    expect(await apiTokens(fetch, url, session)).toEqual([]);
    await expect(
      makeApiToken(fetch, url, session, { name: "Backups", access: "read", password: "wrong" }),
    ).rejects.toThrow(new ServerError(403, "That password is not this account's."));

    const made = await makeApiToken(fetch, url, session, {
      name: "Backups",
      access: "write",
      workspace: workspaceId,
      expiresInDays: 90,
      password,
    });
    expect(made.secret.startsWith("nether_")).toBe(true);
    expect(made.token).toMatchObject({
      name: "Backups",
      access: "write",
      hint: made.secret.slice(-4),
      workspace: { id: workspaceId, name: "Team" },
      usedAt: null,
    });
    expect(Date.parse(made.token.expiresAt ?? "")).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(await apiTokens(fetch, url, session)).toEqual([made.token]);

    // The token works on the API, until it is revoked.
    const me = () =>
      fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${made.secret}` } });
    expect((await me()).status).toBe(200);
    await revokeApiToken(fetch, url, session, made.token.id);
    expect(await apiTokens(fetch, url, session)).toEqual([]);
    expect((await me()).status).toBe(401);
  });
});

describe("webhooks in the app", () => {
  it("are added, changed, given a new secret, tested and removed", async () => {
    const { url, session, workspaceId } = await startServer();
    expect(await webhooks(fetch, url, session, workspaceId)).toEqual([]);
    await expect(
      addWebhook(fetch, url, session, workspaceId, "http://127.0.0.1/hook", ["note.created"]),
    ).rejects.toThrow("A webhook's address is https://.");

    const added = await addWebhook(
      fetch,
      url,
      session,
      workspaceId,
      "https://hooks.example.org/n",
      ["note.created", "note.deleted"],
    );
    expect(added.secret.startsWith("whsec_")).toBe(true);
    expect(added.webhook).toMatchObject({
      url: "https://hooks.example.org/n",
      events: ["note.created", "note.deleted"],
      enabled: true,
      failingSince: null,
      maker: { name: "Ada" },
    });
    const id = added.webhook.id;

    const changed = await changeWebhook(fetch, url, session, workspaceId, id, {
      events: ["note.updated"],
      enabled: false,
    });
    expect(changed).toMatchObject({ events: ["note.updated"], enabled: false });
    await expect(testWebhook(fetch, url, session, workspaceId, id)).rejects.toThrow(
      "This webhook is off: turn it on first.",
    );
    await changeWebhook(fetch, url, session, workspaceId, id, { enabled: true });
    const secret = await rollWebhookSecret(fetch, url, session, workspaceId, id);
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(secret).not.toBe(added.secret);

    await testWebhook(fetch, url, session, workspaceId, id);
    const [delivery] = await webhookDeliveries(fetch, url, session, workspaceId, id);
    expect(delivery).toMatchObject({ type: "webhook.test", status: "waiting", attempts: 0 });

    await removeWebhook(fetch, url, session, workspaceId, id);
    expect(await webhooks(fetch, url, session, workspaceId)).toEqual([]);
  });
});

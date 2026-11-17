// The relay of the web app's AI requests (ADR 0070): only a provider's chat
// and embedding calls go, with its model and key, and the answer streams
// back as the provider sent it; an encrypted workspace, one with AI turned
// off, an outsider, and an address that is not public, are refused before
// anything is sent.
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Resolver } from "../src/outbound.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

let running: TestServer | undefined;
const models: Server[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const server of models.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

type Test = TestServer & SetUp;

const secretKey = Buffer.alloc(32, 9).toString("base64");

async function start(env: Record<string, string> = {}, aiResolve?: Resolver): Promise<Test> {
  running = await startServer({
    env: { NETHER_SECRET_KEY: secretKey, NETHER_AI_PRIVATE: "loopback", ...env },
    ...(aiResolve === undefined ? {} : { aiResolve }),
  });
  return { ...running, ...(await setUp(running)) };
}

interface Heard {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

const reply = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

/** A model on the loopback address, answering as an OpenAI-compatible or Anthropic API. */
async function model(status = 200) {
  const heard: Heard[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      heard.push({
        path: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(text) as Record<string, unknown>,
      });
      if (status !== 200) {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Incorrect API key provided." } }));
      } else if (request.url?.endsWith("/embeddings") === true) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ index: 0, embedding: [0.5] }] }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" }).end(reply);
      }
    });
  });
  models.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, heard };
}

async function provider(
  test: Test,
  body: Record<string, unknown>,
  token = test.token,
): Promise<string> {
  const made = await test.server.inject({
    method: "POST",
    url: "/api/ai/providers",
    headers: bearer(token),
    payload: body,
  });
  expect(made.statusCode, made.body).toBe(201);
  return made.json<{ id: string }>().id;
}

function relay(test: Test, id: string, path: string, payload: object, token = test.token) {
  return test.server.inject({
    method: "POST",
    url: `/api/workspaces/${test.workspaceId}/ai/${id}/${path}`,
    headers: { ...bearer(token), cookie: "nether_session=not-for-the-provider" },
    payload,
  });
}

const chat = {
  model: "whatever the page says",
  messages: [{ role: "user", content: "Fix: Teh cat." }],
  stream: true,
};

describe("the AI relay", () => {
  it("sends a chat with the provider's model and key, and streams the answer back", async () => {
    const test = await start();
    const local = await model();
    const id = await provider(test, {
      scope: "instance",
      name: "Team model",
      kind: "openai",
      url: `${local.url}/v1`,
      model: "llama3.2",
      key: "sk-team",
    });
    const answered = await relay(test, id, "chat/completions", chat);
    expect(answered.statusCode).toBe(200);
    expect(answered.headers["content-type"]).toBe("text/event-stream");
    expect(answered.headers["cache-control"]).toBe("no-store");
    expect(answered.body).toBe(reply);
    expect(local.heard).toHaveLength(1);
    const [heard] = local.heard;
    expect(heard?.path).toBe("/v1/chat/completions");
    expect(heard?.headers.authorization).toBe("Bearer sk-team");
    // Nothing of the page's own goes on: not its cookie, nor its session.
    expect(heard?.headers.cookie).toBeUndefined();
    expect(JSON.stringify(heard?.headers)).not.toContain(test.token);
    expect(heard?.body).toEqual({ ...chat, model: "llama3.2" });

    const embedded = await relay(test, id, "embeddings", { model: "x", input: ["a"] });
    expect(embedded.json()).toEqual({ data: [{ index: 0, embedding: [0.5] }] });
    expect(local.heard[1]?.body).toEqual({ model: "llama3.2", input: ["a"] });
  });

  it("sends Anthropic's call with its key and version, and nothing else of the API", async () => {
    const test = await start();
    const local = await model();
    const id = await provider(test, {
      scope: "instance",
      name: "Claude here",
      kind: "anthropic",
      url: local.url,
      model: "claude-sonnet-5-5",
      key: "sk-ant",
    });
    expect(
      (await relay(test, id, "v1/messages", { messages: [], max_tokens: 10 })).statusCode,
    ).toBe(200);
    expect(local.heard[0]?.path).toBe("/v1/messages");
    expect(local.heard[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(local.heard[0]?.headers["anthropic-version"]).toBe("2026-10-21");
    for (const path of ["chat/completions", "embeddings", "v1/models", "v1/messages/../batches"]) {
      expect((await relay(test, id, path, {})).statusCode, path).toBe(404);
    }
    expect(local.heard).toHaveLength(1);
  });

  it("gives the provider's own error back", async () => {
    const test = await start();
    const local = await model(401);
    const id = await provider(test, {
      scope: "instance",
      name: "Team model",
      kind: "openai",
      url: `${local.url}/v1`,
      model: "m",
    });
    const answered = await relay(test, id, "chat/completions", chat);
    expect(answered.statusCode).toBe(401);
    expect(answered.json()).toEqual({ error: { message: "Incorrect API key provided." } });
    // A model that needs no key gets none.
    expect(local.heard[0]?.headers.authorization).toBeUndefined();
  });

  it("refuses an encrypted workspace, one with AI off, and an outsider, sending nothing", async () => {
    const test = await start();
    const local = await model();
    const id = await provider(test, {
      scope: "instance",
      name: "Team model",
      kind: "openai",
      url: `${local.url}/v1`,
      model: "m",
    });
    await test.server.inject({
      method: "PATCH",
      url: `/api/workspaces/${test.workspaceId}`,
      headers: bearer(test.token),
      payload: { ai: false },
    });
    const off = await relay(test, id, "chat/completions", chat);
    expect(off.statusCode).toBe(403);
    expect(off.json<{ message: string }>().message).toContain("turned AI off");

    await test.db.query(
      "UPDATE workspaces SET ai = true, encryption = 'end-to-end' WHERE id = $1",
      [test.workspaceId],
    );
    const encrypted = await relay(test, id, "chat/completions", chat);
    expect(encrypted.statusCode).toBe(403);
    expect(encrypted.json<{ message: string }>().message).toContain("encrypted");

    await test.db.query("UPDATE workspaces SET encryption = 'none' WHERE id = $1", [
      test.workspaceId,
    ]);
    const outsider = await test.server.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: bearer(test.token),
      payload: { name: "Elsewhere" },
    });
    const elsewhere = outsider.json<{ id: string }>().id;
    await test.db.query("DELETE FROM memberships WHERE workspace_id = $1", [elsewhere]);
    const refused = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${elsewhere}/ai/${id}/chat/completions`,
      headers: bearer(test.token),
      payload: chat,
    });
    expect(refused.statusCode).toBe(404);
    const unsigned = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/ai/${id}/chat/completions`,
      payload: chat,
    });
    expect(unsigned.statusCode).toBe(401);
    expect(local.heard).toHaveLength(0);
  });

  it("reaches no address that is not public for an account's own provider, nor for the admin's unless allowed", async () => {
    const local = await model();
    const port = new URL(local.url).port;
    // Names that resolve to this machine, and to the admin's network.
    const resolve: Resolver = (host) =>
      Promise.resolve(
        host === "inside.example.org"
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "10.0.0.5", family: 4 }],
      );
    const test = await start({ NETHER_AI_PRIVATE: "off" }, resolve);
    const mine = await provider(test, {
      name: "Mine",
      kind: "openai",
      url: `https://inside.example.org:${port}/v1`,
      model: "m",
    });
    const refused = await relay(test, mine, "chat/completions", chat);
    expect(refused.statusCode).toBe(502);
    expect(refused.json<{ message: string }>().message).toContain("not a public address");
    expect(refused.json<{ message: string }>().message).toContain("NETHER_AI_PRIVATE");
    const team = await provider(test, {
      scope: "instance",
      name: "Team",
      kind: "openai",
      url: "https://models.example.org/v1",
      model: "m",
    });
    expect((await relay(test, team, "chat/completions", chat)).statusCode).toBe(502);
    expect(local.heard).toHaveLength(0);
  });

  it("is off with the rest of AI", async () => {
    const test = await start({ NETHER_AI: "off" });
    const answered = await relay(
      test,
      "01929f4c-7b00-7a00-8000-0000000000aa",
      "chat/completions",
      chat,
    );
    expect(answered.statusCode).toBe(403);
  });
});

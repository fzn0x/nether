// A real Nether server for the web app's end-to-end tests: PostgreSQL in
// the process (PGlite), the web app's build at `/`, email kept for the tests
// to read, an OpenID Connect provider standing in for single sign-on, and a
// model on the loopback address that answers as an OpenAI-compatible API,
// which the server's AI relay may reach (ADR 0070); and a second server, not
// set up yet. Beside them, on its own port, what the tests ask of it: the
// emails sent, a new person in the workspace, the provider's sign-in, done
// as the provider's own page would, the requests the model heard, the
// second server's setup code, and TXT records for sites' custom domains,
// which the server looks up here instead of in DNS (ADR 0077). Run by
// Playwright: node e2e/server.ts
import { mkdtemp } from "node:fs/promises";
import { type IncomingMessage, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminModule } from "../../../enterprise/admin/src/index.ts";
import { buildApp } from "../../server/src/app.ts";
import { DiskBlobs } from "../../server/src/blobs.ts";
import { readConfig } from "../../server/src/config.ts";
import { migrate } from "../../server/src/migrations.ts";
import { newSetupCode } from "../../server/src/setup.ts";
import { TestMailer } from "../../server/test/app.ts";
import { testDatabase } from "../../server/test/database.ts";
import { startProvider } from "../../server/test/provider.ts";

export const port = 4175;
export const controlPort = 4176;
export const freshPort = 4177;
export const modelPort = 4178;
const url = `http://127.0.0.1:${String(port)}`;
const password = "a long password";

const provider = await startProvider();

// The model: each chat completion answers "Fixed: " and the last message's
// text between its <text> tags, streamed as an OpenAI-compatible API does.
interface Heard {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}
const heard: Heard[] = [];
const model = createServer((request, response) => {
  let text = "";
  request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  request.on("end", () => {
    const body = JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>;
    heard.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    const messages = Array.isArray(body.messages) ? (body.messages as { content?: unknown }[]) : [];
    const content = messages.at(-1)?.content;
    const last = typeof content === "string" ? content : "";
    const asked = /<text>\n([\s\S]*)\n<\/text>/.exec(last)?.[1] ?? "";
    // A question asked of the notes (ADR 0075) gets its first passage back, cited.
    const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(last)?.[1];
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    const answer =
      passage === undefined
        ? `${chunk("Fixed: ")}${chunk(asked.replace("Teh", "The"))}`
        : `${chunk("Your notes say: ")}${chunk(passage.split("\n").at(-1) ?? "")}${chunk(" [1]")}`;
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(`${answer}data: [DONE]\n\n`);
  });
});
model.listen(modelPort, "127.0.0.1");

// The TXT records the tests write, by name, as a domain's DNS would have them.
const txt = new Map<string, string[][]>();
const resolveTxt = (name: string): Promise<string[][]> => {
  const found = txt.get(name);
  return found === undefined
    ? Promise.reject(Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" }))
    : Promise.resolve(found);
};

const mailer = new TestMailer();
const db = await testDatabase();
await migrate(db);
const setupCode = newSetupCode();
const app = await buildApp(
  readConfig({
    NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether",
    NETHER_LOG_LEVEL: "warn",
    NETHER_PUBLIC_URL: url,
    NETHER_WEB_APP: fileURLToPath(new URL("../dist", import.meta.url)),
    NETHER_OIDC_ISSUER: provider.issuer,
    NETHER_OIDC_CLIENT_ID: provider.clientId,
    NETHER_OIDC_CLIENT_SECRET: provider.clientSecret,
    NETHER_OIDC_NAME: "Test SSO",
    // Keys sealed at rest, and the admin's providers may reach the model here.
    NETHER_SECRET_KEY: Buffer.alloc(32, 3).toString("base64"),
    NETHER_AI_PRIVATE: "loopback",
  }),
  {
    db,
    setupCode,
    mailer,
    resolveTxt,
    blobs: new DiskBlobs(await mkdtemp(join(tmpdir(), "nether-web-e2e-"))),
    // As the image has them: each off until the console turns it on (ADR 0079).
    enterpriseModules: [adminModule],
  },
);
await app.listen({ host: "127.0.0.1", port });

// A second server, not set up yet, for the test that sets one up from the
// web app with the code its log would have.
const freshUrl = `http://127.0.0.1:${String(freshPort)}`;
const freshDb = await testDatabase();
await migrate(freshDb);
const freshCode = newSetupCode();
const fresh = await buildApp(
  readConfig({
    NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether",
    NETHER_LOG_LEVEL: "warn",
    NETHER_PUBLIC_URL: freshUrl,
    NETHER_WEB_APP: fileURLToPath(new URL("../dist", import.meta.url)),
  }),
  {
    db: freshDb,
    setupCode: freshCode,
    blobs: new DiskBlobs(await mkdtemp(join(tmpdir(), "nether-web-e2e-fresh-"))),
  },
);
await fresh.listen({ host: "127.0.0.1", port: freshPort });

// Ada sets the server up, with the workspace Team.
const setup = (await (
  await fetch(`${url}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: setupCode,
      name: "Ada",
      email: "ada@example.org",
      password,
      workspace: "Team",
    }),
  })
).json()) as { token: string; workspace: { id: string } };

async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${setup.token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      try {
        resolve(text === "" ? {} : (JSON.parse(text) as Record<string, unknown>));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}

const control = createServer((request, response) => {
  void (async () => {
    try {
      const body = await readBody(request);
      let answer: unknown;
      if (request.url === "/mail") {
        answer = mailer.sent;
      } else if (request.url === "/model") {
        // What the model heard, from the server's relay.
        answer = heard;
      } else if (request.url === "/txt") {
        // A TXT record at a name, as a domain's owner adds one.
        txt.set(String(body.name), [[String(body.value)]]);
        answer = {};
      } else if (request.url === "/fresh") {
        // The server not set up yet, and the code its log has.
        answer = { url: freshUrl, setupCode: freshCode };
      } else if (request.url === "/invitation") {
        // A link to Team, for anyone, as Ada would share it.
        answer = await api(`/api/workspaces/${setup.workspace.id}/invitations`, { role: "member" });
      } else if (request.url === "/person") {
        // Someone in Team, with an account of their own.
        const name = String(body.name);
        const email = String(body.email);
        const { token } = await api(`/api/workspaces/${setup.workspace.id}/invitations`, {
          role: "member",
          email,
        });
        const accepted = await fetch(`${url}/api/invitations/accept`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, name, email, password }),
        });
        if (!accepted.ok) throw new Error(`accept: ${String(accepted.status)}`);
        answer = { email, password };
      } else if (request.url === "/provider") {
        // Who the provider signs in next, and its page: signing in at the address the popup opened.
        provider.person = {
          sub: String(body.email),
          email: String(body.email),
          email_verified: true,
        };
        answer = { location: provider.authorize(String(body.url)) };
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  })();
});
control.listen(controlPort, "127.0.0.1");

const stop = () => {
  control.close();
  model.close();
  void app.close().then(() => provider.close());
  void fresh.close().then(() => freshDb.close());
  void db.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

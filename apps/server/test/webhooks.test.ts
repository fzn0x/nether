// Webhooks (ADR 0060): managed by a workspace's owners and admins through
// the API; notes made, changed and removed found as they are stored, a
// burst told once; events signed as Standard Webhooks has them, sent one at
// a time, tried again with backoff, and a webhook failing for days turned
// off; only notes its maker opens, and only to addresses the admin allows.
import { createHmac, randomUUID } from "node:crypto";
import {
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readText } from "../src/db.ts";
import { maxAttempts, retryDelay, retryDelays, sendDue } from "../src/deliveries.ts";
import { fanOut, fold } from "../src/outbox.ts";
import { storeDocument } from "../src/sync.ts";
import { maxWebhooks } from "../src/webhooks.ts";
import {
  type SetUp,
  type TestServer,
  TestMailer,
  admin,
  bearer,
  setUp,
  startServer,
} from "./app.ts";

let running: TestServer | undefined;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await running?.close();
  running = undefined;
});

type Test = TestServer & SetUp & { readonly mailer: TestMailer };

/** A server whose webhooks may reach this machine, with its worker run by hand. */
async function start(env: Record<string, string> = { NETHER_WEBHOOK_PRIVATE: "loopback" }) {
  const mailer = new TestMailer();
  running = await startServer({ env, mailer, webhookWorker: false });
  return { ...running, ...(await setUp(running)), mailer } as Test;
}

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A receiver on the loopback address, answering each request with `status`. */
async function receiver(
  status: () => number = () => 204,
  heard: (body: string) => void = () => undefined,
) {
  const received: Received[] = [];
  const server = createServer((request, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(status()).end();
      heard(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${String(port)}/hook`, received };
}

async function token(test: Test, access: "read" | "write" = "write", session = test.token) {
  const response = await test.server.inject({
    method: "POST",
    url: "/api/tokens",
    headers: bearer(session),
    payload: { name: "Script", access, password: admin.password },
  });
  return response.json<{ token: string }>().token;
}

function call(
  test: Test,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  secret: string = test.token,
  payload?: object,
) {
  return test.server.inject({
    method,
    url: path.startsWith("/") ? path : `/api/v1/workspaces/${test.workspaceId}/${path}`,
    headers: bearer(secret),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface Shown {
  readonly id: string;
  readonly url: string;
  readonly events: string[];
  readonly enabled: boolean;
  readonly failingSince: string | null;
  readonly lastError: string | null;
  readonly secret?: string;
}

async function hook(test: Test, url: string, events?: string[]): Promise<Shown> {
  const made = await call(test, "POST", "webhooks", test.token, {
    url,
    ...(events === undefined ? {} : { events }),
  });
  if (made.statusCode !== 201) throw new Error(`No webhook: ${made.body}`);
  return made.json<Shown>();
}

/** One round of the worker, with every change due now. */
async function round(test: Test, policy: boolean | readonly string[] = ["loopback"]) {
  await test.db.query("UPDATE webhook_changes SET due_at = now()");
  await fanOut(test.db);
  await sendDue(test.db, { policy, mailer: test.mailer, random: () => 0.5 });
}

/** A vault document's state listing notes, from the one before it. */
function vault(paths: Record<string, string>, from?: Uint8Array): Uint8Array {
  const document = new Y.Doc();
  if (from !== undefined) Y.applyUpdate(document, from);
  const notes = document.getMap<string>("notes");
  for (const id of [...notes.keys()]) if (!(id in paths)) notes.delete(id);
  for (const [id, path] of Object.entries(paths)) notes.set(id, path);
  return Y.encodeStateAsUpdate(document);
}

/** A note's state with one line of text. */
function note(text: string): Uint8Array {
  const document = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  document.getXmlFragment("content").push([paragraph]);
  return Y.encodeStateAsUpdate(document);
}

async function changes(test: Test) {
  const { rows } = await test.db.query(
    "SELECT note, kind, path FROM webhook_changes ORDER BY path",
  );
  return rows.map((row) => ({ note: row.note, kind: row.kind, path: row.path }));
}

describe("fold", () => {
  it("tells a burst of one note's changes as one", () => {
    expect(fold(undefined, "updated")).toBe("updated");
    expect(fold("created", "updated")).toBe("created");
    expect(fold("created", "deleted")).toBeNull();
    expect(fold("updated", "deleted")).toBe("deleted");
    expect(fold("updated", "updated")).toBe("updated");
    expect(fold("deleted", "created")).toBe("updated");
    expect(fold("deleted", "updated")).toBe("deleted");
  });
});

describe("retryDelay", () => {
  it("backs off over about two days, a tenth either way", () => {
    expect(retryDelays.reduce((sum, delay) => sum + delay, 0) / 3600).toBeCloseTo(44.6, 1);
    expect(maxAttempts).toBe(8);
    expect(retryDelay(1, () => 0.5)).toBe(60);
    expect(retryDelay(1, () => 0)).toBe(54);
    expect(retryDelay(7, () => 1)).toBe(95_040);
  });
});

describe("webhooks", () => {
  it("are made, changed and removed by owners and admins, their secret shown once", async () => {
    const test = await start({});
    const made = await hook(test, "https://hooks.example.org/nether");
    expect(made).toMatchObject({
      url: "https://hooks.example.org/nether",
      events: ["note.created", "note.updated", "note.deleted"],
      enabled: true,
      failingSince: null,
    });
    expect(made.secret).toMatch(/^whsec_/);
    const listed = await call(test, "GET", "webhooks");
    expect(listed.json<{ webhooks: Shown[] }>().webhooks.map((item) => item.id)).toEqual([made.id]);
    expect(listed.body).not.toContain(made.secret);

    const changed = await call(test, "PATCH", `webhooks/${made.id}`, test.token, {
      events: ["note.deleted"],
    });
    expect(changed.json()).toMatchObject({ events: ["note.deleted"] });
    const rolled = await call(test, "POST", `webhooks/${made.id}/secret`);
    expect(rolled.json<Shown>().secret).toMatch(/^whsec_/);
    expect(rolled.json<Shown>().secret).not.toBe(made.secret);

    // Addresses: https only here, never a private one, and no password.
    for (const url of [
      "http://hooks.example.org/",
      "https://127.0.0.1/hook",
      "https://[::ffff:169.254.169.254]/",
      "https://user:pass@hooks.example.org/",
    ]) {
      const refused = await call(test, "POST", "webhooks", test.token, { url });
      expect(refused.statusCode, url).toBe(400);
    }

    // A read token lists them, and changes nothing.
    const reader = await token(test, "read");
    expect((await call(test, "GET", "webhooks", reader)).statusCode).toBe(200);
    expect(
      (await call(test, "POST", "webhooks", reader, { url: "https://hooks.example.org/" }))
        .statusCode,
    ).toBe(403);

    expect((await call(test, "DELETE", `webhooks/${made.id}`)).statusCode).toBe(204);
    expect((await call(test, "GET", `webhooks/${made.id}`)).statusCode).toBe(404);
  });

  it("are refused to members, to encrypted workspaces, and past the most", async () => {
    const test = await start({});
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const bea = (
      await test.server.inject({
        method: "POST",
        url: "/api/invitations/accept",
        payload: {
          token: invited.json<{ token: string }>().token,
          name: "Bea",
          email: "bea@example.org",
          password: "Bea's long password",
        },
      })
    ).json<{ token: string; user: { id: string } }>();
    const url = "https://hooks.example.org/";
    expect((await call(test, "POST", "webhooks", bea.token, { url })).statusCode).toBe(403);
    expect((await call(test, "GET", "webhooks", bea.token)).statusCode).toBe(403);

    // Made an admin, she makes one; leaving the workspace takes it with her.
    await test.server.inject({
      method: "PATCH",
      url: `/api/workspaces/${test.workspaceId}/members/${bea.user.id}`,
      headers: bearer(test.token),
      payload: { role: "admin" },
    });
    const hers = await call(test, "POST", "webhooks", bea.token, { url });
    expect(hers.statusCode).toBe(201);
    await test.server.inject({
      method: "DELETE",
      url: `/api/workspaces/${test.workspaceId}/members/${bea.user.id}`,
      headers: bearer(test.token),
    });
    expect((await call(test, "GET", "webhooks")).json()).toEqual({ webhooks: [] });

    const secret = randomUUID();
    await test.db.query(
      "INSERT INTO workspaces (id, name, encryption) VALUES ($1, 'Secret', 'end-to-end')",
      [secret],
    );
    await test.db.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [secret, test.userId],
    );
    const encrypted = await call(
      test,
      "POST",
      `/api/v1/workspaces/${secret}/webhooks`,
      test.token,
      {
        url,
      },
    );
    expect(encrypted.statusCode).toBe(409);

    await test.db.query(
      `INSERT INTO webhooks (id, workspace_id, maker_id, url, secret, events)
       SELECT gen_random_uuid(), $1, $2, $3, 'whsec_x', '{note.created}'
         FROM generate_series(1, $4::integer)`,
      [test.workspaceId, test.userId, url, maxWebhooks],
    );
    expect((await call(test, "POST", "webhooks", test.token, { url })).statusCode).toBe(409);
  });

  it("tell of a note made, changed and removed, signed, once for each burst", async () => {
    const test = await start();
    const { url, received } = await receiver();
    const made = await hook(test, url);
    const secret = await token(test);

    const created = await call(test, "POST", "notes", secret, {
      path: "Projects/Launch.md",
      markdown: "Ship it\n",
    });
    const id = created.json<{ id: string }>().id;
    await call(test, "PUT", `notes/${id}`, secret, { markdown: "Ship it soon\n" });
    // Made, then changed, is made: one change waits.
    expect(await changes(test)).toEqual([
      { note: id, kind: "created", path: "Projects/Launch.md" },
    ]);
    await round(test);
    expect(received).toHaveLength(1);
    const [first] = received;
    const body = JSON.parse(first?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "note.created",
      data: { workspace: test.workspaceId, note: id, path: "Projects/Launch.md", title: "Launch" },
    });
    expect(first?.body).not.toContain("Ship it");
    const headers = first?.headers ?? {};
    const eventId = String(headers["webhook-id"]);
    const timestamp = String(headers["webhook-timestamp"]);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    const key = Buffer.from((made.secret ?? "").slice("whsec_".length), "base64");
    const expected = createHmac("sha256", key)
      .update(`${eventId}.${timestamp}.${first?.body ?? ""}`)
      .digest("base64");
    expect(headers["webhook-signature"]).toBe(`v1,${expected}`);
    expect(headers["content-type"]).toBe("application/json");

    // Changed, then removed, is removed, with its last path.
    await call(test, "PUT", `notes/${id}`, secret, { markdown: "Shipped\n" });
    await call(test, "DELETE", `notes/${id}`, secret);
    await round(test);
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[1]?.body ?? "{}")).toMatchObject({
      type: "note.deleted",
      data: { note: id, path: "Projects/Launch.md", title: "Launch" },
    });

    // Made and removed before it was told is nothing.
    const brief = await call(test, "POST", "notes", secret, { path: "Brief.md", markdown: "x\n" });
    await call(test, "DELETE", `notes/${brief.json<{ id: string }>().id}`, secret);
    await round(test);
    expect(received).toHaveLength(2);

    const deliveries = await call(test, "GET", `webhooks/${made.id}/deliveries`);
    expect(
      deliveries.json<{ deliveries: { type: string; status: string }[] }>().deliveries,
    ).toEqual([
      expect.objectContaining({ type: "note.deleted", status: "sent", attempts: 1, answer: 204 }),
      expect.objectContaining({ type: "note.created", status: "sent" }),
    ]);
  });

  it("wait 30 seconds after a note's last store, and at most five minutes after its first", async () => {
    const test = await start();
    await hook(test, (await receiver()).url);
    const id = randomUUID();
    await storeDocument(test.db, test.workspaceId, id, note("One"));
    await storeDocument(test.db, test.workspaceId, "vault", vault({ [id]: "One.md" }));
    const due = async () => {
      const { rows } = await test.db.query(
        "SELECT extract(epoch FROM due_at - now()) AS wait FROM webhook_changes",
      );
      return Number(rows[0]?.wait);
    };
    expect(await due()).toBeGreaterThan(25);
    expect(await due()).toBeLessThanOrEqual(30);
    await test.db.query("UPDATE webhook_changes SET first_at = now() - interval '6 minutes'");
    await storeDocument(test.db, test.workspaceId, id, note("One, changed"));
    expect(await due()).toBeLessThan(0);
    // A store of the same state is no change.
    await round(test);
    expect(await changes(test)).toEqual([]);
    const { rows } = await test.db.query("SELECT state FROM documents WHERE name = $1", [id]);
    await storeDocument(test.db, test.workspaceId, id, rows[0]?.state as Uint8Array);
    expect(await changes(test)).toEqual([]);
    await storeDocument(test.db, test.workspaceId, id, note("One, changed again"));
    expect(await changes(test)).toEqual([{ note: id, kind: "updated", path: "One.md" }]);
  });

  it("tell a note moved to another unit as changed, and say nothing of comments", async () => {
    const test = await start();
    const { url, received } = await receiver();
    await hook(test, url);
    const id = randomUUID();
    const general = vault({ [id]: "Plan.md" });
    await storeDocument(test.db, test.workspaceId, id, note("Plan"));
    await storeDocument(test.db, test.workspaceId, "vault", general);
    await round(test);
    expect(received).toHaveLength(1);

    const board = (
      await test.server.inject({
        method: "POST",
        url: `/api/workspaces/${test.workspaceId}/teamspaces`,
        headers: bearer(test.token),
        payload: { name: "Board" },
      })
    ).json<{ id: string }>().id;
    await test.server.inject({
      method: "PUT",
      url: `/api/workspaces/${test.workspaceId}/notes/${id}/unit`,
      headers: bearer(test.token),
      payload: { unit: board },
    });
    await storeDocument(
      test.db,
      test.workspaceId,
      `vault.${board}`,
      vault({ [id]: "Board/Plan.md" }),
    );
    await storeDocument(test.db, test.workspaceId, "vault", vault({}, general));
    await storeDocument(test.db, test.workspaceId, `${id}.comments`, note("A comment"));
    expect(await changes(test)).toEqual([{ note: id, kind: "updated", path: "Board/Plan.md" }]);
    await round(test);
    expect(JSON.parse(received[1]?.body ?? "{}")).toMatchObject({
      type: "note.updated",
      data: { path: "Board/Plan.md", title: "Plan" },
    });
  });

  it("tell only of notes their maker opens, and of the events they listen to", async () => {
    const test = await start();
    const everything = await receiver();
    const removals = await receiver();
    await hook(test, everything.url);
    await hook(test, removals.url, ["note.deleted"]);
    const board = (
      await test.server.inject({
        method: "POST",
        url: `/api/workspaces/${test.workspaceId}/teamspaces`,
        headers: bearer(test.token),
        payload: { name: "Board" },
      })
    ).json<{ id: string }>().id;
    const secret = await token(test);
    await call(test, "POST", "notes", secret, { path: "Board/Merger.md", markdown: "x\n" });
    await call(test, "POST", "notes", secret, { path: "Open.md", markdown: "y\n" });
    // The owner leaves the teamspace, keeping someone else there to manage it.
    const other = (
      await test.db.query(
        `INSERT INTO users (id, email, email_key, name) VALUES (gen_random_uuid(), 'c@example.org', 'c@example.org', 'Cy')
         RETURNING id`,
      )
    ).rows[0];
    await test.db.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [test.workspaceId, readText(other, "id")],
    );
    await test.db.query("UPDATE unit_grants SET user_id = $2 WHERE unit_id = $1", [
      board,
      readText(other, "id"),
    ]);
    await round(test);
    expect(
      everything.received.map(
        (item) => (JSON.parse(item.body) as { data: { path: string } }).data.path,
      ),
    ).toEqual(["Open.md"]);
    expect(removals.received).toHaveLength(0);
  });

  it("try a failed event again later, drop it after eight tries, and turn off a webhook failing for days", async () => {
    const test = await start();
    let status = 500;
    const { url, received } = await receiver(() => status);
    const made = await hook(test, url);
    const test202 = await call(test, "POST", `webhooks/${made.id}/test`);
    expect(test202.statusCode).toBe(202);
    await round(test);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({
      type: "webhook.test",
      data: { webhook: made.id },
    });
    const { rows: waiting } = await test.db.query(
      `SELECT attempts, status, answer, error, extract(epoch FROM next_at - now()) AS wait
         FROM webhook_deliveries`,
    );
    expect(waiting[0]).toMatchObject({ attempts: 1, status: "waiting", answer: 500 });
    expect(Number(waiting[0]?.wait)).toBeGreaterThan(50);
    expect(Number(waiting[0]?.wait)).toBeLessThanOrEqual(60);
    let shown = (await call(test, "GET", `webhooks/${made.id}`)).json<Shown>();
    expect(shown.failingSince).not.toBeNull();
    expect(shown.lastError).toBe("The address answered 500.");

    // A later success forgets the failures.
    status = 200;
    await test.db.query("UPDATE webhook_deliveries SET next_at = now()");
    await round(test);
    shown = (await call(test, "GET", `webhooks/${made.id}`)).json<Shown>();
    expect(shown).toMatchObject({ failingSince: null, lastError: null, enabled: true });

    // The eighth try is the last.
    status = 503;
    await call(test, "POST", `webhooks/${made.id}/test`);
    await test.db.query("UPDATE webhook_deliveries SET attempts = $1 WHERE status = 'waiting'", [
      maxAttempts - 1,
    ]);
    await round(test);
    const { rows: dropped } = await test.db.query(
      "SELECT status, next_at FROM webhook_deliveries WHERE attempts = $1",
      [maxAttempts],
    );
    expect(dropped[0]).toMatchObject({ status: "failed", next_at: null });

    // Failing for three days turns it off, drops what waits, and tells its maker.
    await call(test, "POST", `webhooks/${made.id}/test`);
    await call(test, "POST", `webhooks/${made.id}/test`);
    await test.db.query("UPDATE webhooks SET failing_since = now() - interval '4 days'");
    await round(test);
    shown = (await call(test, "GET", `webhooks/${made.id}`)).json<Shown>();
    expect(shown.enabled).toBe(false);
    const { rows: left } = await test.db.query(
      "SELECT 1 FROM webhook_deliveries WHERE status = 'waiting'",
    );
    expect(left).toHaveLength(0);
    const mail = await test.mailer.next();
    expect(mail).toMatchObject({ to: admin.email, subject: "A Nether webhook was turned off" });
    expect(mail.text).toContain(url);
    expect((await call(test, "POST", `webhooks/${made.id}/test`)).statusCode).toBe(409);

    // Turned on again, it starts afresh.
    const again = await call(test, "PATCH", `webhooks/${made.id}`, test.token, { enabled: true });
    expect(again.json()).toMatchObject({ enabled: true, failingSince: null, lastError: null });
  });

  it("send nothing to an address the admin does not allow, whatever it was saved as", async () => {
    const test = await start();
    const { url, received } = await receiver();
    const made = await hook(test, url);
    await call(test, "POST", `webhooks/${made.id}/test`);
    // The admin no longer allows this machine.
    await round(test, false);
    expect(received).toHaveLength(0);
    const { rows } = await test.db.query("SELECT error FROM webhook_deliveries");
    expect(readText(rows[0], "error")).toContain("not a public address");
  });

  it("are sent by the server's own worker, with the admin's setting", async () => {
    running = await startServer({ env: { NETHER_WEBHOOK_PRIVATE: "127.0.0.1" } });
    const test = { ...running, ...(await setUp(running)), mailer: new TestMailer() };
    let arrived: (body: string) => void = () => undefined;
    const body = new Promise<string>((resolve) => (arrived = resolve));
    const { url } = await receiver(() => 200, arrived);
    const made = await hook(test, url);
    await call(test, "POST", `webhooks/${made.id}/test`);
    // Its round comes every five seconds.
    expect(JSON.parse(await body)).toMatchObject({ type: "webhook.test" });
  });
});

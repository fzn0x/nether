// Sending the audit log to a SIEM (ADR 0081): by a webhook, signed as
// Standard Webhooks has it, to an address on the server's own network; by
// syslog over TLS, RFC 5424 framed by its length, trusted by a certificate
// authority or a pinned fingerprint. Every event in order, from where each
// destination stopped; a failure waits and is tried again, never turning
// the destination off; a purge records what a destination never took.
// Adding, changing and removing a destination is recorded, never its
// secret; the environment may pin one of each.
import { randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type TLSSocket, createServer as createTlsServer } from "node:tls";
import { X509Certificate } from "node:crypto";
import { serverVersion } from "@nether/server/src/app.ts";
import { signature } from "@nether/server/src/outbound.ts";
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  signIn,
  startServer,
} from "@nether/server/test/app.ts";
import { afterEach, describe, expect, it } from "vitest";
import { newServiceKey } from "../../sso/src/certificate.ts";
import { chainKey, createAuditModule, purge, searchLog, waitAfter } from "../src/index.ts";

type Test = TestServer & SetUp;
let running: Test | undefined;
const closing: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const close of closing.splice(0)) await close();
});

const sealingKey = Buffer.alloc(32, 9).toString("base64");

async function start(
  moduleEnv: Record<string, string> = {},
  env: Record<string, string> = {},
): Promise<Test> {
  const server = await startServer({
    env: { NETHER_ENTERPRISE_AUDIT: "on", NETHER_SECRET_KEY: sealingKey, ...env },
    enterpriseModules: [createAuditModule(moduleEnv, { sendEvery: 50 })],
  });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

async function until(what: string, check: () => boolean | Promise<boolean>, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The newest event's place in the log. */
async function head(test: Test): Promise<number> {
  const { rows } = await test.db.query("SELECT max(seq) AS seq FROM audit_events");
  return Number(rows[0]?.seq ?? 0);
}

interface Delivery {
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** A SIEM's webhook on this machine: what it was sent, and the status it answers. */
async function receiver(answer: () => number = () => 204) {
  const received: Delivery[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answer();
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closing.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${String(port)}/siem/hook?token=kept-out` };
}

/** The seqs a webhook was sent, in the order it got them. */
function sentSeqs(received: readonly Delivery[]): number[] {
  return received.flatMap((delivery) =>
    (JSON.parse(delivery.body) as { data: { events: { seq: number }[] } }).data.events.map(
      (event) => event.seq,
    ),
  );
}

function add(test: Test, body: Record<string, unknown>) {
  return test.server.inject({
    method: "POST",
    url: "/api/audit/destinations",
    headers: bearer(test.token),
    payload: body,
  });
}

function list(test: Test) {
  return test.server.inject({
    method: "GET",
    url: "/api/audit/destinations",
    headers: bearer(test.token),
  });
}

/** The log's own events about destinations, newest last. */
async function destinationEvents(test: Test) {
  const { events } = await searchLog(test.db, { group: "log", limit: 100 });
  return events.reverse().filter((row) => row.action.startsWith("audit.destination_"));
}

describe("a webhook", () => {
  it("is sent every event in order, signed, to an address on the server's network", async () => {
    const test = await start();
    const siem = await receiver();
    const made = await add(test, {
      kind: "webhook",
      name: "SIEM",
      address: siem.url,
      from: "oldest",
    });
    expect(made.statusCode).toBe(201);
    const { destination, secret } = made.json<{
      destination: { id: string; kind: string; address: string };
      secret: string;
    }>();
    expect(secret).toMatch(/^whsec_/);
    // Shown once: the list never gives it.
    expect((await list(test)).body).not.toContain(secret);
    const reached = await head(test);
    await until("every event so far", () => sentSeqs(siem.received).at(-1) === reached);

    // More events come as they happen, after the ones before, none twice.
    await signIn(test.server, "ada@example.org", "a wrong password");
    await until(
      "the next event",
      async () => sentSeqs(siem.received).at(-1) === (await head(test)),
    );
    const seqs = sentSeqs(siem.received);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));

    for (const delivery of siem.received) {
      const id = String(delivery.headers["webhook-id"]);
      const timestamp = Number(delivery.headers["webhook-timestamp"]);
      const batch = JSON.parse(delivery.body) as {
        type: string;
        data: { events: { seq: number; id: string; action: string; hash: string }[] };
      };
      expect(batch.type).toBe("audit.events");
      expect(batch.data.events.length).toBeLessThanOrEqual(100);
      const first = batch.data.events[0]?.seq;
      const last = batch.data.events.at(-1)?.seq;
      expect(id).toBe(`${destination.id}:${String(first)}-${String(last)}`);
      expect(delivery.headers["webhook-signature"]).toBe(
        signature(secret, id, timestamp, delivery.body),
      );
      expect(batch.data.events[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const failed = JSON.parse(siem.received.at(-1)?.body ?? "{}") as {
      data: {
        events: { action: string; outcome: string; actor: { type: string; email: string } }[];
      };
    };
    expect(failed.data.events.at(-1)).toMatchObject({
      action: "session.signed_in",
      outcome: "failure",
      reason: "wrong password",
      actor: { type: "account", email: "Ada@Example.org" },
    });

    // Recorded, by the address's origin alone: its path may hold a secret.
    const recorded = await destinationEvents(test);
    expect(recorded.map((row) => row.action)).toEqual(["audit.destination_added"]);
    expect(recorded[0]?.details).toEqual({
      kind: "webhook",
      address: new URL(siem.url).origin,
      from: "oldest",
    });
    expect(JSON.stringify(recorded)).not.toContain(secret);
  });

  it("waits after a failure, tries again from where it stopped, and is never turned off", async () => {
    const test = await start();
    let failing = true;
    const siem = await receiver(() => (failing ? 503 : 200));
    const made = await add(test, { kind: "webhook", name: "SIEM", address: siem.url });
    const id = made.json<{ destination: { id: string } }>().destination.id;
    await signIn(test.server, "ada@example.org", "a wrong password");
    await until("a try", () => siem.received.length > 0);
    await until("the failure kept", async () => {
      const shown = (await list(test)).json<{
        destinations: {
          failures: number;
          lastError: string | null;
          waiting: number;
          nextTryAt: string | null;
        }[];
      }>().destinations[0];
      return (shown?.failures ?? 0) >= 1;
    });
    const shown = (await list(test)).json<{
      destinations: { failures: number; lastError: string; waiting: number; nextTryAt: string }[];
    }>().destinations[0];
    expect(shown?.lastError).toBe("The address answered 503.");
    // Its own addition, then the sign-in: a destination is told it was added.
    expect(shown?.waiting).toBe(2);
    // Thirty seconds after the first failure, then longer.
    expect(new Date(shown?.nextTryAt ?? 0).getTime() - Date.now()).toBeGreaterThan(20_000);
    const tries = siem.received.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(siem.received.length).toBe(tries);

    // Its wait over, it takes up where it stopped.
    failing = false;
    await test.db.query("UPDATE audit_destinations SET next_try_at = now() WHERE id = $1", [id]);
    await until("the delivery", async () => {
      const after = (await list(test)).json<{
        destinations: { failures: number; waiting: number; deliveredAt: string | null }[];
      }>().destinations[0];
      return after?.waiting === 0 && after.deliveredAt !== null && after.failures === 0;
    });
    // The batch taken held both, from where the destination stopped.
    const taken = sentSeqs(siem.received.slice(-1));
    expect(taken).toHaveLength(2);
    expect(taken[1]).toBe(await head(test));
  });

  it("waits 30 seconds, a minute, 2, 5, 10, then every 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(waitAfter)).toEqual([
      30, 60, 120, 300, 600, 900, 900, 900,
    ]);
  });
});

describe("syslog over TLS", () => {
  /** A syslog server on this machine with a certificate of its own: the frames it got. */
  async function syslogServer() {
    const service = newServiceKey("localhost");
    const received: Buffer[] = [];
    const server = createTlsServer(
      { key: service.privateKey, cert: service.certificate, minVersion: "TLSv1.2" },
      (socket: TLSSocket) => {
        socket.on("data", (chunk: Buffer) => received.push(chunk));
        socket.on("error", () => undefined);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closing.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    const { port } = server.address() as AddressInfo;
    return {
      received,
      certificate: service.certificate,
      fingerprint: new X509Certificate(service.certificate).fingerprint256,
      address: `localhost:${String(port)}`,
    };
  }

  /** RFC 5425's frames: MSG-LEN SP SYSLOG-MSG, one after another. */
  function frames(received: readonly Buffer[]): Buffer[] {
    const all = Buffer.concat(received);
    const found: Buffer[] = [];
    let at = 0;
    while (at < all.length) {
      const space = all.indexOf(0x20, at);
      const length = Number(all.subarray(at, space).toString("ascii"));
      found.push(all.subarray(space + 1, space + 1 + length));
      at = space + 1 + length;
    }
    return found;
  }

  it("sends RFC 5424 messages framed by their length to a server its certificate authority vouches for", async () => {
    const test = await start({}, { NETHER_PUBLIC_URL: "https://nether.example.org" });
    const siem = await syslogServer();
    const made = await add(test, {
      kind: "syslog",
      name: "Syslog",
      address: siem.address,
      ca: siem.certificate,
      from: "oldest",
    });
    expect(made.statusCode).toBe(201);
    expect(made.json<{ secret: string | null }>().secret).toBeNull();
    await signIn(test.server, "ada@example.org", "a wrong password");
    const reached = await head(test);
    await until("every event", () => frames(siem.received).length === reached);
    const messages = frames(siem.received);
    const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);
    const parsed = messages.map((message) => {
      const mark = message.indexOf(byteOrderMark);
      const header = message.subarray(0, mark).toString("utf8");
      const json = JSON.parse(message.subarray(mark + 3).toString("utf8")) as {
        seq: number;
        at: string;
        action: string;
      };
      return { header, json };
    });
    expect(parsed.map((each) => each.json.seq)).toEqual(
      Array.from({ length: reached }, (_, index) => index + 1),
    );
    const last = parsed.at(-1);
    // Facility 13, log audit; severity 4, warning, for a failure, else 5, notice.
    expect(last?.header).toBe(
      `<108>1 ${last?.json.at ?? ""} nether.example.org nether - session.signed_in [origin software="nether" swVersion="${serverVersion()}"] `,
    );
    expect(parsed[0]?.header.startsWith("<109>1 ")).toBe(true);
  });

  it("trusts a pinned fingerprint, and refuses a server it cannot vouch for", async () => {
    const test = await start();
    const siem = await syslogServer();
    await add(test, {
      kind: "syslog",
      name: "Pinned",
      address: siem.address,
      fingerprint: siem.fingerprint.replaceAll(":", "").toLowerCase(),
      from: "oldest",
    });
    await add(test, { kind: "syslog", name: "Unvouched", address: siem.address, from: "oldest" });
    await until("the pinned one's events", async () => {
      const shown = (await list(test)).json<{
        destinations: { name: string; waiting: number; failures: number }[];
      }>().destinations;
      return (
        shown.find((each) => each.name === "Pinned")?.waiting === 0 &&
        (shown.find((each) => each.name === "Unvouched")?.failures ?? 0) >= 1
      );
    });
    const unvouched = (await list(test))
      .json<{
        destinations: { name: string; lastError: string; waiting: number }[];
      }>()
      .destinations.find((each) => each.name === "Unvouched");
    expect(unvouched?.lastError).toMatch(/Could not reach localhost:\d+ by TLS/);
    expect(unvouched?.waiting).toBeGreaterThan(0);
  });
});

describe("destinations", () => {
  it("are an instance admin's, five at most, a webhook's needing NETHER_SECRET_KEY, each change recorded", async () => {
    const test = await start();
    const siem = await receiver();
    const made = await add(test, { kind: "webhook", name: "One", address: siem.url });
    const id = made.json<{ destination: { id: string } }>().destination.id;
    expect(
      (await add(test, { kind: "webhook", name: "Bad", address: "ftp://siem.example.org" })).json(),
    ).toMatchObject({ statusCode: 400 });
    expect(
      (await add(test, { kind: "syslog", name: "Bad", address: "siem.example.org:99999" }))
        .statusCode,
    ).toBe(400);
    for (const name of ["Two", "Three", "Four", "Five"]) {
      expect(
        (await add(test, { kind: "syslog", name, address: "siem.example.org" })).statusCode,
      ).toBe(201);
    }
    expect(
      (await add(test, { kind: "syslog", name: "Six", address: "siem.example.org" })).statusCode,
    ).toBe(409);

    const changed = await test.server.inject({
      method: "PATCH",
      url: `/api/audit/destinations/${id}`,
      headers: bearer(test.token),
      payload: { name: "Renamed", address: "https://siem.example.org/other?key=kept-out" },
    });
    expect(changed.statusCode).toBe(200);
    const removed = await test.server.inject({
      method: "DELETE",
      url: `/api/audit/destinations/${id}`,
      headers: bearer(test.token),
    });
    expect(removed.statusCode).toBe(204);
    const recorded = await destinationEvents(test);
    expect(recorded.map((row) => row.action)).toEqual([
      "audit.destination_added",
      "audit.destination_added",
      "audit.destination_added",
      "audit.destination_added",
      "audit.destination_added",
      "audit.destination_changed",
      "audit.destination_removed",
    ]);
    expect(recorded[5]?.details).toEqual({
      kind: "webhook",
      nameFrom: "One",
      nameTo: "Renamed",
      addressFrom: "http://127.0.0.1:" + new URL(siem.url).port,
      addressTo: "https://siem.example.org",
    });
    expect(JSON.stringify(recorded)).not.toContain("kept-out");

    // Not a member's: refused.
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "admin" },
    });
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invited.json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "Bea's long password",
      },
    });
    const bea = accepted.json<{ token: string }>().token;
    const refused = await test.server.inject({
      method: "GET",
      url: "/api/audit/destinations",
      headers: bearer(bea),
    });
    expect(refused.statusCode).toBe(403);
  });

  it("need NETHER_SECRET_KEY for a webhook's secret", async () => {
    const test = await start({}, { NETHER_SECRET_KEY: "" });
    const siem = await receiver();
    const refused = await add(test, { kind: "webhook", name: "SIEM", address: siem.url });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toContain("NETHER_SECRET_KEY");
  });

  it("may be pinned by the environment, shown with no control", async () => {
    const siem = await receiver();
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    const test = await start({
      NETHER_AUDIT_WEBHOOK: siem.url,
      NETHER_AUDIT_WEBHOOK_SECRET: secret,
    });
    const shown = (await list(test)).json<{
      destinations: { id: string; pinnedBy: string | null; kind: string }[];
    }>().destinations;
    expect(shown).toMatchObject([{ kind: "webhook", pinnedBy: "NETHER_AUDIT_WEBHOOK" }]);
    const id = shown[0]?.id ?? "";
    for (const method of ["PATCH", "DELETE"] as const) {
      const refused = await test.server.inject({
        method,
        url: `/api/audit/destinations/${id}`,
        headers: bearer(test.token),
        ...(method === "PATCH" ? { payload: { name: "Mine" } } : {}),
      });
      expect(refused.statusCode).toBe(409);
    }
    // It starts after the newest event when it is first pinned, and is sent what comes next.
    await signIn(test.server, "ada@example.org", "a wrong password");
    await until("a delivery", () => siem.received.length > 0);
    const delivery = siem.received[0];
    const idHeader = String(delivery?.headers["webhook-id"]);
    expect(delivery?.headers["webhook-signature"]).toBe(
      signature(
        secret,
        idHeader,
        Number(delivery?.headers["webhook-timestamp"]),
        delivery?.body ?? "",
      ),
    );
    await expect(
      start({ NETHER_AUDIT_WEBHOOK: siem.url, NETHER_AUDIT_WEBHOOK_SECRET: "not one" }),
    ).rejects.toThrow("NETHER_AUDIT_WEBHOOK needs NETHER_AUDIT_WEBHOOK_SECRET");
  });

  it("record what a purge took before a destination did, and go on after it", async () => {
    const test = await start();
    const siem = await receiver(() => 503);
    const made = await add(test, {
      kind: "webhook",
      name: "SIEM",
      address: siem.url,
      from: "oldest",
    });
    const id = made.json<{ destination: { id: string } }>().destination.id;
    // Kept zero days: everything but the newest goes.
    const through = (await head(test)) - 1;
    await purge(test.db, 0, chainKey(Buffer.from(sealingKey, "base64")));
    const { events } = await searchLog(test.db, { action: "audit.export_gap", limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "failure",
      reason: "purged before it was sent",
      targetType: "audit_destination",
      targetId: id,
      targetName: "SIEM",
      details: { kind: "webhook", fromSeq: 1, throughSeq: through, count: through },
    });
    const { rows } = await test.db.query("SELECT cursor FROM audit_destinations WHERE id = $1", [
      id,
    ]);
    expect(Number(rows[0]?.cursor)).toBe(through);
  });
});

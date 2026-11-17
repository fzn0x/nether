// Two nodes of one server (ADR 0082): one database, one bus. The relay
// sends a push through one node to the subscribers of the other, and tells
// the vault's of it there; a pusher is told its number after the other
// node's earlier update; and a node that misses a hint reads on its own
// within seconds.
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type ClusterBus, ProcessBus } from "../src/cluster.ts";
import { type SetUp, type TestServer, bearer, setUp, signIn, startServer } from "./app.ts";
import { freePort } from "./ports.ts";

const running: TestServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  // The second node first: the first closes the database they share.
  for (const node of running.splice(0).reverse()) await node.close();
});

const b64 = (bytes: number) => randomBytes(bytes).toString("base64");

/** Two nodes over one database and one bus, set up, with an encrypted workspace. */
async function cluster(bus: ClusterBus = new ProcessBus()) {
  const first = await startServer({ bus });
  running.push(first);
  const setup: SetUp = await setUp(first);
  const second = await startServer({ bus, nodeOf: first });
  running.push(second);
  await first.server.inject({
    method: "PUT",
    url: "/api/me/keys",
    headers: bearer(setup.token),
    payload: { publicKey: b64(32), recoveryBox: b64(73) },
  });
  const made = await first.server.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: bearer(setup.token),
    payload: { name: "Secret", encryption: "end-to-end", sealedKey: b64(80) },
  });
  const workspace = made.json<{ id: string }>().id;
  const token = async () =>
    (await signIn(second.server, "ada@example.org", "a long password")).json<{ token: string }>()
      .token;
  return { first, second, workspace, token };
}

/** A relay client of a node: its messages as they come, and a way to wait for one. */
async function relay(node: TestServer, token: string) {
  if (node.server.server.address() === null) {
    await node.server.listen({ host: "127.0.0.1", port: await freePort() });
  }
  const { port } = node.server.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/relay`);
  sockets.push(socket);
  const received: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  socket.addEventListener("message", (event) => {
    received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    for (const waiter of waiters.splice(0)) waiter();
  });
  await new Promise((resolve) => {
    socket.addEventListener("open", resolve);
  });
  const client = {
    received,
    send: (message: object) => {
      socket.send(JSON.stringify(message));
    },
    async next(match: (message: Record<string, unknown>) => boolean) {
      for (;;) {
        const found = received.find(match);
        if (found !== undefined) return found;
        if (socket.readyState === WebSocket.CLOSED) throw new Error("The relay closed");
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async subscribe(name: string) {
      socket.send(JSON.stringify({ type: "subscribe", name, after: 0 }));
      await client.next((message) => message.type === "subscribed" && message.name === name);
    },
  };
  client.send({ type: "auth", token });
  await client.next((message) => message.type === "ready");
  return client;
}

/** Whether an update with a number came in a message. */
function carries(message: Record<string, unknown>, seq: number): boolean {
  return (
    message.type === "updates" &&
    (message.updates as { seq: number }[]).some((update) => update.seq === seq)
  );
}

describe("two nodes", () => {
  it("send a push through one node to the other's subscribers, and tell its vault's", async () => {
    const { first, second, workspace, token } = await cluster();
    const note = `${workspace}/${randomUUID()}`;
    const laptop = await relay(first, await token());
    const phone = await relay(second, await token());
    const vault = await relay(second, await token());
    await laptop.subscribe(note);
    await phone.subscribe(note);
    await vault.subscribe(`${workspace}/vault`);

    laptop.send({ type: "push", id: "1", name: note, data: "AAEC" });
    const seq = Number((await laptop.next((message) => message.id === "1")).seq);
    expect(await phone.next((message) => carries(message, seq))).toEqual({
      type: "updates",
      name: note,
      updates: [{ seq, data: "AAEC" }],
    });
    expect(await vault.next((message) => message.type === "stored")).toEqual({
      type: "stored",
      document: note.split("/")[1],
      seq,
    });
    // Its own update is not sent back to the pusher.
    expect(laptop.received.some((message) => carries(message, seq))).toBe(false);
  });

  it("tell each pusher its number after the other node's update numbered before it", async () => {
    const { first, second, workspace, token } = await cluster();
    const laptop = await relay(first, await token());
    const phone = await relay(second, await token());
    for (let round = 0; round < 10; round++) {
      const note = `${workspace}/${randomUUID()}`;
      await laptop.subscribe(note);
      await phone.subscribe(note);
      laptop.send({ type: "push", id: `l${String(round)}`, name: note, data: "AAEC" });
      phone.send({ type: "push", id: `p${String(round)}`, name: note, data: "AwQF" });
      const fromLaptop = Number(
        (await laptop.next((message) => message.id === `l${String(round)}`)).seq,
      );
      const fromPhone = Number(
        (await phone.next((message) => message.id === `p${String(round)}`)).seq,
      );
      const [later, earlier] = fromLaptop < fromPhone ? [phone, fromLaptop] : [laptop, fromPhone];
      const told = later.received.findIndex(
        (message) => message.id === (later === phone ? `p${String(round)}` : `l${String(round)}`),
      );
      const sent = later.received.findIndex((message) => carries(message, earlier));
      expect(sent).toBeGreaterThanOrEqual(0);
      expect(sent).toBeLessThan(told);
    }
  });

  it("read on their own within seconds when a hint is lost", async () => {
    // A bus that loses every hint.
    const deaf: ClusterBus = {
      publish: () => undefined,
      subscribe: () => () => undefined,
    };
    const { first, second, workspace, token } = await cluster(deaf);
    const note = `${workspace}/${randomUUID()}`;
    const laptop = await relay(first, await token());
    const phone = await relay(second, await token());
    await laptop.subscribe(note);
    await phone.subscribe(note);
    laptop.send({ type: "push", id: "1", name: note, data: "AAEC" });
    const seq = Number((await laptop.next((message) => message.id === "1")).seq);
    const sent = Date.now();
    await phone.next((message) => carries(message, seq));
    expect(Date.now() - sent).toBeLessThan(6_000);
  }, 15_000);
});

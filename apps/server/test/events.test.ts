// The server's events (ADR 0081): told to every listener with the change's
// transaction; a listener that fails fails the change, unless it was an
// attempt that changed nothing, whose missing record is logged instead.
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Queryable } from "../src/db.ts";
import {
  type ServerEvent,
  ServerEvents,
  accountActor,
  fromServer,
  serverActions,
} from "../src/events.ts";

const tx: Queryable = { query: () => Promise.resolve({ rows: [] }) };
const signedIn: ServerEvent = {
  action: "session.signed_in",
  actor: accountActor("8d0f5c3e-2b7a-4c1e-9f6d-0a1b2c3d4e5f"),
  details: { method: "password" },
};

describe("ServerEvents", () => {
  it("tells every listener, with the transaction, until it stops listening", async () => {
    const events = new ServerEvents();
    const heard: string[] = [];
    const stop = events.listen((event, origin, db) => {
      heard.push(`${event.action} ${String(origin.address)} ${String(db === tx)}`);
      return Promise.resolve();
    });
    await events.emit(tx, signedIn, { address: "203.0.113.7", userAgent: null });
    stop();
    await events.emit(tx, signedIn, fromServer);
    expect(heard).toEqual(["session.signed_in 203.0.113.7 true"]);
  });

  it("is wanted while a listener wants it, or listens with no say", async () => {
    const events = new ServerEvents();
    expect(await events.wanted(tx)).toBe(false);
    let on = false;
    const stop = events.listen(
      () => Promise.resolve(),
      () => Promise.resolve(on),
    );
    expect(await events.wanted(tx)).toBe(false);
    on = true;
    expect(await events.wanted(tx)).toBe(true);
    stop();
    events.listen(() => Promise.resolve());
    expect(await events.wanted(tx)).toBe(true);
  });

  it("fails a change a listener cannot record, and logs an attempt's", async () => {
    const events = new ServerEvents();
    events.listen(() => Promise.reject(new Error("no room")));
    await expect(events.emit(tx, signedIn, fromServer)).rejects.toThrow("no room");
    const error = vi.fn();
    await events.attempt(
      tx,
      { ...signedIn, outcome: "failure", reason: "wrong password" },
      fromServer,
      { error } as unknown as FastifyBaseLogger,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.signed_in" }),
      "Could not record an event",
    );
  });

  it("names its actions short enough for syslog's MSGID, and an account's token beside it", () => {
    for (const action of serverActions) expect(action.length).toBeLessThanOrEqual(32);
    expect(new Set(serverActions).size).toBe(serverActions.length);
    expect(accountActor("a", { id: "t", name: "Script" })).toEqual({
      kind: "account",
      id: "a",
      token: { id: "t", name: "Script" },
    });
    expect(accountActor("a", null)).toEqual({ kind: "account", id: "a" });
  });
});

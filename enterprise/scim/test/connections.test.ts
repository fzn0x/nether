// A user the directory deactivates or removes loses its open connections
// once the change commits: its sync connection closes, and its apps are
// refused when they connect again (ADR 0085); so does one whose place a
// group gave, when the group lets it go.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { freePort } from "@nether/server/test/ports.ts";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { newToken, tokenHash } from "@nether/server/src/sessions.ts";
import { type Test, addDirectory, admin, join, patchSchema, scim, start, stop } from "./server.ts";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await stop();
});

describe("a user the directory deactivates", () => {
  it("has its sync connection closed, and is refused when it connects again", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const bea = await join(test, "bea@corp.example", "Bea");
    await scim(test, okta, "POST", "/Users", { userName: "bea@corp.example", displayName: "Bea" });
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const port = String((test.server.server.address() as AddressInfo).port);

    let refused: string | undefined;
    let closed = false;
    await new Promise<void>((resolve, reject) => {
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/api/sync`,
        name: `${test.workspaceId}/vault`,
        token: bea.token,
        document: new Y.Doc(),
        onSynced: () => {
          resolve();
        },
        onClose: () => {
          closed = true;
        },
        onAuthenticationFailed: ({ reason }) => {
          refused = reason;
          reject(new Error(reason));
        },
      });
      providers.push(provider);
    });

    const off = await scim(test, okta, "PATCH", `/Users/${bea.id}`, {
      schemas: [patchSchema],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.json()).toMatchObject({ active: false });
    const deadline = Date.now() + 10_000;
    while (refused === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(closed).toBe(true);
    expect(refused).toBeDefined();
  });
});

/** Connects a sync provider as a session token, and says when it closes and is refused. */
async function connect(test: Test, token: string) {
  await test.server.listen({ host: "127.0.0.1", port: await freePort() });
  const port = String((test.server.server.address() as AddressInfo).port);
  const state: { closed: boolean; refused: string | undefined } = {
    closed: false,
    refused: undefined,
  };
  await new Promise<void>((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/api/sync`,
      name: `${test.workspaceId}/vault`,
      token,
      document: new Y.Doc(),
      onSynced: () => {
        resolve();
      },
      onClose: () => {
        state.closed = true;
      },
      onAuthenticationFailed: ({ reason }) => {
        state.refused = reason;
        reject(new Error(reason));
      },
    });
    providers.push(provider);
  });
  return state;
}

describe("a member a group placed", () => {
  it("has its sync connection closed when the group lets it go, and is refused again", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const made = await scim(test, okta, "POST", "/Users", { userName: "cy@corp.example" });
    const cy = made.json<{ id: string }>().id;
    const group = await scim(test, okta, "POST", "/Groups", {
      displayName: "Staff",
      members: [{ value: cy }],
    });
    const groupId = group.json<{ id: string }>().id;
    await admin(
      test,
      "PUT",
      `/api/admin/directories/okta/groups/${groupId}/workspaces/${test.workspaceId}`,
      { role: "member" },
    );
    // Cy has no password: a session of his, as signing in by a code starts one.
    const token = newToken();
    await test.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), cy, tokenHash(token)],
    );
    const state = await connect(test, token);
    await scim(test, okta, "PATCH", `/Groups/${groupId}`, {
      schemas: [patchSchema],
      Operations: [{ op: "remove", path: `members[value eq "${cy}"]` }],
    });
    const deadline = Date.now() + 10_000;
    while (state.refused === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(state.closed).toBe(true);
    expect(state.refused).toBeDefined();
  });
});

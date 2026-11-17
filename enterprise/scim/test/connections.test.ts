// A user the directory deactivates or removes loses its open connections
// once the change commits: its sync connection closes, and its apps are
// refused when they connect again (ADR 0085).
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { freePort } from "@nether/server/test/ports.ts";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addDirectory, join, patchSchema, scim, start, stop } from "./server.ts";

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

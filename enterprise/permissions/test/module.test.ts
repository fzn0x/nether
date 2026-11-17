// The `permissions` feature's module (ADR 0089): in every build, off until
// an instance admin turns it on, and with nothing but the built-in roles
// while its parts come.
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  startServer,
} from "@nether/server/test/app.ts";
import { builtInSettings } from "@nether/server/src/places.ts";
import { afterEach, describe, expect, it } from "vitest";
import { permissionsModule } from "../src/index.ts";

type Test = TestServer & SetUp;
let running: Test | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(env: Record<string, string> = {}): Promise<Test> {
  const server = await startServer({ env, enterpriseModules: [permissionsModule] });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

function features(test: Test) {
  return test.server.inject({
    method: "GET",
    url: "/api/instance/features",
    headers: bearer(test.token),
  });
}

describe("advanced permissions", () => {
  it("are in the build, off until an instance admin turns them on", async () => {
    const test = await start();
    expect((await features(test)).json<{ features: unknown[] }>().features).toContainEqual({
      feature: "permissions",
      on: false,
      pinned: null,
      available: true,
    });
    const turned = await test.server.inject({
      method: "PUT",
      url: "/api/instance/features/permissions",
      headers: bearer(test.token),
      payload: { on: true },
    });
    expect(turned.json()).toEqual({
      feature: "permissions",
      on: true,
      pinned: null,
      available: true,
    });
  });

  it("are pinned by NETHER_ENTERPRISE_PERMISSIONS", async () => {
    const test = await start({ NETHER_ENTERPRISE_PERMISSIONS: "on" });
    expect((await features(test)).json<{ features: unknown[] }>().features).toContainEqual({
      feature: "permissions",
      on: true,
      pinned: "on",
      available: true,
    });
  });

  it("leave the setup account an owner's settings while on", async () => {
    const test = await start({ NETHER_ENTERPRISE_PERMISSIONS: "on" });
    const me = await test.server.inject({
      method: "GET",
      url: "/api/me",
      headers: bearer(test.token),
    });
    const [workspace] = me.json<{ workspaces: { may: unknown }[] }>().workspaces;
    expect(workspace?.may).toEqual(builtInSettings.owner);
  });
});

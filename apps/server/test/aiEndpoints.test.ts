// The approved AI endpoints' list (ADR 0086): read in order without
// repeats, kept by the console or pinned by the environment, and locking
// AI only while the `policies` feature is on.
import { afterEach, describe, expect, it } from "vitest";
import { AiEndpoints, maxEndpoints, readEndpoints } from "../src/aiEndpoints.ts";
import { SettingRefused } from "../src/settings.ts";
import { type TestServer, startServer } from "./app.ts";

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("the approved endpoints", () => {
  it("are read from a list in order, without repeats, and refused when not an address", () => {
    expect(
      readEndpoints(["https://a.example/v1", " ", "https://A.example/v1/", "http://b.example:1"]),
    ).toEqual(["https://a.example/v1", "http://b.example:1"]);
    expect(() => readEndpoints(["https://a.example", "not one"])).toThrow(
      "not one is not an http or https address.",
    );
    const many = Array.from(
      { length: maxEndpoints + 1 },
      (_, at) => `https://e${String(at)}.example`,
    );
    expect(() => readEndpoints(many)).toThrow(SettingRefused);
  });

  async function endpoints(pin?: readonly string[], on = true) {
    running = await startServer();
    return new AiEndpoints(running.db, pin, () => Promise.resolve(on));
  }

  it("lock nothing until the list holds one, then lock to it", async () => {
    const list = await endpoints();
    expect(await list.locked()).toBeNull();
    expect(await list.set(["https://llm.corp.example/v1/"])).toEqual([
      "https://llm.corp.example/v1",
    ]);
    expect(await list.locked()).toEqual(["https://llm.corp.example/v1"]);
    expect(await list.state()).toEqual({
      endpoints: ["https://llm.corp.example/v1"],
      pinnedBy: null,
    });
    await list.set([]);
    expect(await list.locked()).toBeNull();
  });

  it("lock nothing while the policies feature is off", async () => {
    const list = await endpoints(undefined, false);
    await list.set(["https://llm.corp.example/v1"]);
    expect(await list.locked()).toBeNull();
  });

  it("are the environment's when it pins them, and the console cannot change them", async () => {
    const list = await endpoints(["https://llm.corp.example/v1"]);
    expect(await list.state()).toEqual({
      endpoints: ["https://llm.corp.example/v1"],
      pinnedBy: "NETHER_AI_ENDPOINTS",
    });
    await expect(list.set([])).rejects.toThrow("NETHER_AI_ENDPOINTS sets it: change it there.");
  });
});

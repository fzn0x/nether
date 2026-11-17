// Requests to a server from the phones (ADR 0087): native, with their
// answers read back as a Response, whatever form the native side gave.
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/mobileFiles.ts";
import { nativeFetch } from "../src/mobileHttp.ts";

/** The native side, answering as given and recording what it was asked. */
function native(answer: Partial<HttpResponse> & { readonly error?: boolean }) {
  const asked: HttpOptions[] = [];
  const fetcher = nativeFetch((options) => {
    asked.push(options);
    return Promise.resolve({ data: "", status: 200, headers: {}, url: options.url, ...answer });
  });
  return { fetcher, asked };
}

describe("nativeFetch", () => {
  it("sends JSON as text, with its headers, and reads the JSON the native side parsed", async () => {
    const { fetcher, asked } = native({
      status: 201,
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Kept": "yes" },
      data: { token: "t", user: { id: "u" } },
    });
    const response = await fetcher("https://nether.example.org/api/sessions", {
      method: "post",
      headers: { "content-type": "application/json", authorization: "Bearer a" },
      body: JSON.stringify({ email: "ada@example.org" }),
    });
    expect(asked).toEqual([
      {
        url: "https://nether.example.org/api/sessions",
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer a" },
        responseType: "arraybuffer",
        data: '{"email":"ada@example.org"}',
      },
    ]);
    expect(response.status).toBe(201);
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(await response.json()).toEqual({ token: "t", user: { id: "u" } });
  });

  it("gives text a content type, as fetch does, since the native sides send none without one", async () => {
    const { fetcher, asked } = native({});
    await fetcher(new URL("https://nether.example.org/api/x"), { method: "PUT", body: "hi" });
    expect(asked[0]?.headers).toEqual({ "content-type": "text/plain;charset=UTF-8" });
    expect(asked[0]?.data).toBe("hi");
    expect(asked[0]?.dataType).toBeUndefined();
  });

  it("sends bytes as base64 for the native side to decode, and reads bytes back", async () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const { fetcher, asked } = native({
      headers: { "content-type": "application/octet-stream" },
      data: toBase64(bytes),
    });
    const response = await fetcher("https://nether.example.org/api/workspaces/w/attachments/b", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes.slice(1),
    });
    expect(asked[0]).toMatchObject({
      method: "PUT",
      data: toBase64(bytes.slice(1)),
      dataType: "file",
      headers: { "content-type": "application/octet-stream" },
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("sends a view's own bytes, and a Blob's with its type", async () => {
    const { fetcher, asked } = native({});
    const whole = new Uint8Array([9, 8, 7, 6]);
    await fetcher("https://n.example.org/a", { method: "POST", body: whole.subarray(1, 3) });
    expect(asked[0]).toMatchObject({
      data: toBase64(new Uint8Array([8, 7])),
      dataType: "file",
      headers: { "content-type": "application/octet-stream" },
    });
    await fetcher("https://n.example.org/a", {
      method: "POST",
      body: new Blob([new Uint8Array([1, 2])], { type: "image/png" }),
    });
    expect(asked[1]).toMatchObject({
      data: toBase64(new Uint8Array([1, 2])),
      dataType: "file",
      headers: { "content-type": "image/png" },
    });
  });

  it("reads an error's text, as Android gives it, and iOS's as base64", async () => {
    const android = native({ status: 502, data: "Bad gateway", error: true });
    const answer = await android.fetcher("https://n.example.org/api/me");
    expect(answer.ok).toBe(false);
    expect(answer.status).toBe(502);
    expect(await answer.text()).toBe("Bad gateway");
    const ios = native({ status: 502, data: toBase64(new TextEncoder().encode("Bad gateway")) });
    expect(await (await ios.fetcher("https://n.example.org/api/me")).text()).toBe("Bad gateway");
  });

  it("reads an error's JSON, and an answer with no body", async () => {
    const refused = native({
      status: 401,
      headers: { "content-type": "application/json" },
      data: { message: "Sign in again." },
      error: true,
    });
    const answer = await refused.fetcher("https://n.example.org/api/me");
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ message: "Sign in again." });
    const empty = native({ status: 204, data: "" });
    const none = await empty.fetcher("https://n.example.org/api/me", { method: "DELETE" });
    expect(none.status).toBe(204);
    expect(none.body).toBeNull();
  });

  it("sends a GET with no body and no content type", async () => {
    const { fetcher, asked } = native({});
    await fetcher("https://n.example.org/api/me", { headers: [["Accept", "application/json"]] });
    expect(asked[0]).toEqual({
      url: "https://n.example.org/api/me",
      method: "GET",
      headers: { accept: "application/json" },
      responseType: "arraybuffer",
    });
  });

  it("refuses a request already aborted, and stops waiting when it is aborted", async () => {
    const { fetcher, asked } = native({});
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      fetcher("https://n.example.org/a", { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(asked).toEqual([]);

    const waiting = nativeFetch(() => new Promise(() => undefined));
    const later = new AbortController();
    const pending = waiting("https://n.example.org/a", { signal: later.signal });
    later.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a body the native side cannot carry", async () => {
    const { fetcher } = native({});
    await expect(
      fetcher("https://n.example.org/a", { method: "POST", body: new FormData() }),
    ).rejects.toThrow(TypeError);
  });
});

// Requests to a server from the mobile apps (ADR 0087): native, through
// Capacitor's CapacitorHttp, outside the page's CORS, as Go's fetch is on
// the desktop; the page's own fetch is left as it is. Its answers come back
// as a `Response`, so the page's code reads them as it reads any other.
//
// The native sides hand bodies over as text: bytes go as base64, and come
// back as base64 too, asked for as an "arraybuffer". An answer in JSON comes
// back parsed, and an error's answer on Android as its text.
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { fromBase64, toBase64 } from "./mobileFiles.ts";

/** What sends a request natively: `CapacitorHttp.request` in the apps. */
export type NativeRequest = (options: HttpOptions) => Promise<HttpResponse>;

/** Statuses whose answers have no body, which a `Response` refuses one for. */
const bodiless = new Set([101, 103, 204, 205, 304]);

/** A request's body as the native side takes it: text, or bytes as base64 with dataType "file". */
async function bodyOf(
  body: BodyInit | null | undefined,
): Promise<{ readonly data?: string; readonly file?: boolean; readonly type?: string }> {
  if (body === null || body === undefined) return {};
  if (typeof body === "string") return { data: body, type: "text/plain;charset=UTF-8" };
  if (body instanceof URLSearchParams) {
    return { data: body.toString(), type: "application/x-www-form-urlencoded;charset=UTF-8" };
  }
  if (body instanceof ArrayBuffer) return { data: toBase64(new Uint8Array(body)), file: true };
  if (ArrayBuffer.isView(body)) {
    return {
      data: toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      file: true,
    };
  }
  if (body instanceof Blob) {
    return {
      data: toBase64(new Uint8Array(await body.arrayBuffer())),
      file: true,
      ...(body.type === "" ? {} : { type: body.type }),
    };
  }
  throw new TypeError("This kind of body cannot be sent from the app.");
}

/** An answer's body as bytes or text, from what the native side gave. */
function answerOf(response: HttpResponse): BodyInit | null {
  if (bodiless.has(response.status)) return null;
  const data: unknown = response.data;
  if (data === null || data === undefined) return null;
  // JSON, which the native side parsed.
  if (typeof data !== "string") return JSON.stringify(data);
  const type = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  const json = typeof type === "string" && type.toLowerCase().includes("application/json");
  // Android gives an error's answer as its text, whatever was asked for.
  if (json || (response as HttpResponse & { error?: boolean }).error === true) return data;
  return fromBase64(data) as Uint8Array<ArrayBuffer>;
}

/** fetch for a server's API, through the native side's requests. */
export function nativeFetch(send: NativeRequest): typeof fetch {
  // The page's code gives an address and its init; a Request's own body is not read.
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init.signal ?? request?.signal;
    if (signal?.aborted === true) throw new DOMException("The request was aborted.", "AbortError");
    // The native request runs on; an abort stops the wait for it.
    const abort =
      signal === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The request was aborted.", "AbortError"));
            });
          });
    // Unhandled until raced: an abort after the answer must not be reported.
    abort?.catch(() => undefined);
    const headers = new Headers(request?.headers);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    const body = await bodyOf(init.body);
    // Both sides write a body only under a content type.
    if (body.data !== undefined && !headers.has("content-type")) {
      headers.set("content-type", body.type ?? "application/octet-stream");
    }
    const sending = send({
      url,
      method: (init.method ?? request?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(headers),
      responseType: "arraybuffer",
      ...(body.data === undefined ? {} : { data: body.data }),
      ...(body.file === true ? { dataType: "file" as const } : {}),
    });
    const answered = await (abort === undefined ? sending : Promise.race([sending, abort]));
    return new Response(answerOf(answered), {
      status: answered.status,
      headers: Object.entries(answered.headers).flatMap(([name, value]) =>
        typeof value === "string" ? [[name, value] as [string, string]] : [],
      ),
    });
  };
}

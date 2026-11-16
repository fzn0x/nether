// The plugin's side of its sandboxed frame (ADR 0058): a worker the frame
// makes, with the frame's opaque origin and policy and no page of its own,
// so nothing to navigate and no WebRTC. It is given the plugin's code and
// the app's port, imports the code from a blob, and starts the plugin over
// the port. What goes wrong it tells the frame, which tells the app. Its
// views draw in a DOM of the worker's own, which the page copies (ADR 0063).
import { type Plugin, portTransport, startPlugin } from "@nether/plugin-api";
import { attachSurface, remoteSurface } from "./remote.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};
// The worker's own, before the DOM's globals are put in place.
const tellFrame = scope.postMessage.bind(scope);
// Before the plugin's code, which may use `document` as it loads.
const surface = remoteSurface();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { activate?: unknown }).activate === "function"
  );
}

async function start(code: string, port: MessagePort): Promise<void> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const module = (await import(/* @vite-ignore */ url)) as { readonly default?: unknown };
  URL.revokeObjectURL(url);
  if (!isPlugin(module.default)) {
    throw new Error("Its main.js does not export a plugin as its default.");
  }
  attachSurface(surface, await startPlugin(module.default, portTransport(port), surface));
}

// The frame's one message: the plugin's code, with the app's port.
scope.onmessage = (event) => {
  scope.onmessage = null;
  const port = event.ports[0];
  const code = (event.data as { readonly code?: unknown } | null)?.code;
  if (port === undefined || typeof code !== "string") {
    tellFrame({ failed: "The frame gave no plugin." });
    return;
  }
  start(code, port).catch((error: unknown) => {
    tellFrame({ failed: errorText(error) });
  });
};

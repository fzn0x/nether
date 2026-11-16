// The plugin's side of its sandboxed frame (ADR 0058): a worker the frame
// makes, with the frame's opaque origin and policy and no page of its own,
// so nothing to navigate and no WebRTC. It is given the plugin's code and
// the app's port, imports the code from a blob, and starts the plugin over
// the port. What goes wrong it tells the frame, which tells the app.
import { type Plugin, portTransport, startPlugin } from "@nether/plugin-api";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

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
  await startPlugin(module.default, portTransport(port));
}

// The frame's one message: the plugin's code, with the app's port.
scope.onmessage = (event) => {
  scope.onmessage = null;
  const port = event.ports[0];
  const code = (event.data as { readonly code?: unknown } | null)?.code;
  if (port === undefined || typeof code !== "string") {
    scope.postMessage({ failed: "The frame gave no plugin." });
    return;
  }
  start(code, port).catch((error: unknown) => {
    scope.postMessage({ failed: errorText(error) });
  });
};

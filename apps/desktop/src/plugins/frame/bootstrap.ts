// The one script of a plugin's sandboxed frame (ADR 0058), a classic
// script, since a frame of an opaque origin cannot load the app's modules.
// It tells the page it is there, and when the page sends the plugin's code
// with a port, starts the worker that runs it, passing both on. The
// plugin's code never runs here, in the frame's page.

/** The worker's code, which the build puts here. */
declare const pluginWorker: string;

function failed(message: string): void {
  parent.postMessage({ nether: "failed", message }, "*");
}

let started = false;
addEventListener("message", (event: MessageEvent) => {
  // Only the page that made the frame, and only once.
  if (started || event.source !== parent) return;
  const port = event.ports[0];
  const code = (event.data as { readonly code?: unknown } | null)?.code;
  if (port === undefined || typeof code !== "string") return;
  started = true;
  let worker: Worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([pluginWorker], { type: "text/javascript" })));
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
    return;
  }
  worker.onmessage = (message: MessageEvent) => {
    const text = (message.data as { readonly failed?: unknown } | null)?.failed;
    if (typeof text === "string") failed(text);
  };
  worker.onerror = (error) => {
    error.preventDefault();
    failed(error.message === "" ? "The plugin's worker failed." : error.message);
  };
  worker.postMessage({ code }, [port]);
});
parent.postMessage({ nether: "ready" }, "*");
export {};

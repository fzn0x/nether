// Opens a plugin's sandboxed frame (ADR 0058): a hidden frame of the app's
// own page for it, with no `allow-same-origin`, so its origin is opaque,
// and a policy of its own that reaches the network only for a plugin
// approved for it. Once the frame says it is there, it gets the plugin's
// code and the plugin's end of a port; the app keeps the other end.

export interface FrameRequest {
  /** The plugin's main.js. */
  readonly code: string;
  /** Whether it was approved for the network. */
  readonly network: boolean;
  /** Told what goes wrong in the frame: its code not loading, or its worker failing. */
  readonly onFailure: (message: string) => void;
}

export interface OpenedFrame {
  /** The app's end of the plugin's connection. */
  readonly port: MessagePort;
  /** Takes the frame away, which stops the plugin. */
  close(): void;
}

export type FrameOpener = (request: FrameRequest) => OpenedFrame;

/** The frame's page, as the build makes it, beside the app's. */
export function framePage(network: boolean): string {
  return network ? "/plugin-frame-network.html" : "/plugin-frame.html";
}

export const openFrame: FrameOpener = ({ code, network, onFailure }) => {
  const channel = new MessageChannel();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.className = "plugin-frame";
  let sent = false;
  const listen = (event: MessageEvent) => {
    // Only this frame's page, which only the app's script runs in.
    if (event.source === null || event.source !== frame.contentWindow) return;
    const data = event.data as { readonly nether?: unknown; readonly message?: unknown } | null;
    if (data?.nether === "ready" && !sent) {
      sent = true;
      frame.contentWindow.postMessage({ code }, "*", [channel.port2]);
    } else if (data?.nether === "failed") {
      onFailure(typeof data.message === "string" ? data.message : "The plugin failed.");
    }
  };
  window.addEventListener("message", listen);
  frame.src = framePage(network);
  document.body.append(frame);
  return {
    port: channel.port1,
    close() {
      window.removeEventListener("message", listen);
      channel.port1.close();
      frame.remove();
    },
  };
};

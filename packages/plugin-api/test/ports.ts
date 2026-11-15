// Node's MessageChannel, as a sandboxed plugin's port will be, for tests:
// the SDK's own types know only the part of a port it uses.
import type { PortLike } from "../src/protocol.ts";

const { MessageChannel } = globalThis as unknown as {
  MessageChannel: new () => { port1: PortLike; port2: PortLike };
};

export function channel(): { port1: PortLike; port2: PortLike } {
  return new MessageChannel();
}

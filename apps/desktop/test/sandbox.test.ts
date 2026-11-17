// @vitest-environment jsdom
// Plugins from a vault's folders (ADR 0058): what they draw is cleaned, the
// folders are read with what keeps each from running, this device's
// approval is of the code as it is, and the host runs one through a frame,
// which a test stands in for here with a port.
import { type Plugin, definePlugin, portTransport, startPlugin } from "@nether/plugin-api";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { afterEach, describe, expect, it } from "vitest";
import { cleanHtml } from "../src/plugins/clean.ts";
import { BlockRegistry } from "../src/plugins/blocks.ts";
import { CodeBlockRegistry } from "../src/plugins/codeBlocks.ts";
import {
  type FolderEntry,
  approvalOf,
  isApproved,
  readApprovals,
  readFolders,
  writeApprovals,
} from "../src/plugins/folders.ts";
import type { FrameOpener, FrameRequest } from "../src/plugins/frame.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { LayoutRegistry } from "../src/plugins/layouts.ts";
import { PanelRegistry } from "../src/plugins/panels.ts";
import { PropertyTypeRegistry } from "../src/plugins/propertyTypes.ts";
import { CommandRegistry } from "../src/plugins/registry.ts";
import { isFolderOn } from "../src/plugins/state.ts";
import { ViewRegistry } from "../src/plugins/views.ts";

describe("cleanHtml", () => {
  it("takes away scripts, event handlers, styles, forms and frames", () => {
    expect(
      cleanHtml(
        '<b onclick="steal()">Hi</b><script>steal()</script><style>p{}</style>' +
          '<p style="color:red">x</p><form action="/a"><input></form><iframe src="#a"></iframe>',
        false,
      ),
      // A form's fields stay, with no form to send them.
    ).toBe("<b>Hi</b><p>x</p><input>");
  });

  it("keeps fragments and images as data, and takes away other addresses", () => {
    expect(
      cleanHtml(
        '<a href="#part">in</a><a href="https://example.com/?q=note">out</a>' +
          '<a href="javascript:steal()">js</a><img src="data:image/png;base64,AA==">' +
          '<img src="https://example.com/a.png"><img srcset="https://example.com/b.png 2x">' +
          '<img src="data:text/html,x"><img src="blob:x">',
        false,
      ),
    ).toBe(
      '<a href="#part">in</a><a>out</a><a>js</a><img src="data:image/png;base64,AA==">' +
        "<img><img><img><img>",
    );
  });

  it("takes away url() pointing outside the drawing, in SVG too", () => {
    expect(
      cleanHtml(
        '<svg><rect fill="url(#g)"></rect><rect fill="url( \'https://example.com/a#g\')"></rect>' +
          '<image href="https://example.com/a.png"></image><use href="#g"></use></svg>',
        false,
      ),
      // DOMPurify takes away <use>, whatever it points at.
    ).toBe('<svg><rect fill="url(#g)"></rect><rect></rect><image></image></svg>');
  });

  it("keeps https: addresses for a plugin approved for the network, and no others", () => {
    expect(
      cleanHtml(
        '<img src="https://example.com/a.png"><a href="http://example.com/">plain</a>' +
          '<rect fill="url(https://example.com/a#g)"></rect>',
        true,
      ),
    ).toBe('<img src="https://example.com/a.png"><a>plain</a>');
    // Approving one plugin for the network does not approve the next.
    expect(cleanHtml('<img src="https://example.com/a.png">', false)).toBe("<img>");
  });
});

const echo = {
  id: "echo",
  name: "Echo",
  version: "1.0.0",
  api: "^0.1",
  permissions: ["network"],
  contributes: { commands: [{ id: "say", name: "Say" }], codeBlocks: [{ language: "echo" }] },
};

async function vaultWith(files: Readonly<Record<string, string>>): Promise<Vault> {
  const vault = new Vault(new MemoryFiles({ "a.md": "A", ...files }), new MemoryStore());
  await vault.open();
  return vault;
}

describe("a vault's plugin folders", () => {
  it("reads each folder, with what keeps it from running", async () => {
    const vault = await vaultWith({
      ".nether/plugins/echo/manifest.json": JSON.stringify(echo),
      ".nether/plugins/echo/main.js": "export default {}",
      ".nether/plugins/broken/manifest.json": "{",
      ".nether/plugins/moved/manifest.json": JSON.stringify(echo),
      ".nether/plugins/moved/main.js": "export default {}",
      ".nether/plugins/panes/manifest.json": JSON.stringify({
        ...echo,
        id: "panes",
        contributes: { panels: [{ id: "p", name: "P", place: "note" }] },
      }),
      ".nether/plugins/tags/manifest.json": JSON.stringify({ ...echo, id: "tags" }),
      ".nether/plugins/tags/main.js": "export default {}",
      // A built-in plugin's settings, which is no plugin of the vault's.
      ".nether/plugins/backlinks/data.json": "{}",
      ".nether/plugins/empty/data.json": "{}",
    });
    const folders = await readFolders(vault, new Set(["tags", "backlinks"]));
    expect(folders.map(({ folder, problems }) => [folder, problems])).toEqual([
      ["broken", ["Its manifest.json is not JSON.", "It has no main.js."]],
      ["echo", []],
      ["empty", ["It has no manifest.json.", "It has no main.js."]],
      ["moved", ["Its manifest's id is echo, and its folder moved."]],
      ["panes", ["It has no main.js."]],
      ["tags", ["A plugin that comes with the app is tags."]],
    ]);
    const entry = folders.find((each) => each.folder === "echo");
    expect(entry?.manifest?.permissions).toEqual(["network"]);
    expect(entry?.code?.text).toBe("export default {}");
    expect(entry?.code?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has none when the vault has no plugins folder", async () => {
    expect(await readFolders(await vaultWith({}), new Set())).toEqual([]);
  });
});

describe("approving a plugin from a folder", () => {
  const entry = async (code: string, manifest: object = echo): Promise<FolderEntry> => {
    const vault = await vaultWith({
      ".nether/plugins/echo/manifest.json": JSON.stringify(manifest),
      ".nether/plugins/echo/main.js": code,
    });
    const [read] = await readFolders(vault, new Set());
    if (read === undefined) throw new Error("No folder.");
    return read;
  };

  afterEach(() => {
    localStorage.clear();
  });

  it("approves the code as it is: its hash, its version and what it asks for", async () => {
    const first = await entry("export default 1");
    const approval = approvalOf(first);
    expect(approval).toEqual({
      version: "1.0.0",
      hash: first.code?.hash,
      permissions: ["network"],
    });
    expect(isApproved(first, approval)).toBe(true);
    expect(isApproved(await entry("export default 2"), approval)).toBe(false);
    expect(
      isApproved(await entry("export default 1", { ...echo, version: "1.0.1" }), approval),
    ).toBe(false);
    expect(
      isApproved(
        await entry("export default 1", { ...echo, permissions: ["network", "vault:read"] }),
        approval,
      ),
    ).toBe(false);
    expect(isApproved(first, undefined)).toBe(false);
  });

  it("approves nothing that cannot run", async () => {
    expect(approvalOf(await entry("export default 1", { ...echo, id: "other" }))).toBeUndefined();
  });

  it("runs one only when the vault has it on and this device approved it", async () => {
    const read = await entry("export default 1");
    const approval = approvalOf(read);
    if (approval === undefined) throw new Error("Not approved.");
    expect(isFolderOn({ on: { echo: true }, approvals: { echo: approval } }, read)).toBe(true);
    expect(isFolderOn({ on: {}, approvals: { echo: approval } }, read)).toBe(false);
    expect(isFolderOn({ on: { echo: true }, approvals: {} }, read)).toBe(false);
  });

  it("keeps approvals on this device, per vault, leaving out what does not read", () => {
    const approval = { version: "1.0.0", hash: "ab", permissions: [] };
    writeApprovals("vault-1", { echo: approval });
    expect(readApprovals("vault-1")).toEqual({ echo: approval });
    expect(readApprovals("vault-2")).toEqual({});
    localStorage.setItem(
      "nether.pluginApprovals.vault-3",
      JSON.stringify({ echo: approval, odd: { version: 1 } }),
    );
    expect(readApprovals("vault-3")).toEqual({ echo: approval });
    localStorage.setItem("nether.pluginApprovals.vault-4", "{");
    expect(readApprovals("vault-4")).toEqual({});
  });
});

describe("PluginHost, a plugin from a folder", () => {
  /** Opens a frame that runs `plugin` at the other end of a port, as the frame's worker would. */
  function frames(plugin?: Plugin) {
    const opened: FrameRequest[] = [];
    const closed: number[] = [];
    const open: FrameOpener = (request) => {
      const at = opened.push(request);
      const { port1, port2 } = new MessageChannel();
      if (plugin !== undefined) void startPlugin(plugin, portTransport(port2));
      return {
        port: port1,
        close() {
          closed.push(at);
          port1.close();
          port2.close();
        },
      };
    };
    return { open, opened, closed };
  }

  const make = (openFrame: FrameOpener, startTime?: number) => {
    const commands = new CommandRegistry();
    const codeBlocks = new CodeBlockRegistry();
    const errors: string[] = [];
    const host = new PluginHost(
      {
        commands,
        codeBlocks,
        blocks: new BlockRegistry(),
        panels: new PanelRegistry(),
        views: new ViewRegistry(),
        layouts: new LayoutRegistry(),
        propertyTypes: new PropertyTypeRegistry(),
      },
      {
        language: "en",
        direction: "ltr",
        openFrame,
        ...(startTime === undefined ? {} : { startTime }),
        onError: (plugin, message) => {
          errors.push(`${plugin}: ${message}`);
        },
      },
    );
    return { host, commands, codeBlocks, errors };
  };

  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  const drawn = '<img src="https://example.com/a.png" onerror="steal()"><b>hi</b>';
  const echoing = (said: string[]) =>
    definePlugin({
      async activate(context) {
        await context.commands.register("say", () => {
          said.push("said");
        });
        await context.codeBlocks.register("echo", () => ({ html: drawn }));
      },
    });

  it("runs it in a frame when first used, with the network it was approved for", async () => {
    const said: string[] = [];
    const frame = frames(echoing(said));
    const { host, commands, errors } = make(frame.open);
    close = () => {
      host.close();
    };
    expect(host.addFolder({ manifest: echo, code: "the code" })).toEqual([]);
    expect(frame.opened).toEqual([]);
    // A button asks each time it runs a command of a plugin from the vault (ADR 0072).
    expect(commands.get("echo:say")?.fromVault).toBe(true);
    commands.get("echo:say")?.run();
    await settle();
    expect(said).toEqual(["said"]);
    expect(errors).toEqual([]);
    expect(frame.opened.map(({ code, network }) => [code, network])).toEqual([["the code", true]]);
    host.remove("echo");
    await settle();
    expect(frame.closed).toEqual([1]);
  });

  it("cleans what it draws, keeping addresses only with the network", async () => {
    for (const [permissions, html] of [
      [["network"], '<img src="https://example.com/a.png"><b>hi</b>'],
      [[], "<img><b>hi</b>"],
    ] as const) {
      const { host, codeBlocks } = make(frames(echoing([])).open);
      close = () => {
        host.close();
      };
      host.addFolder({ manifest: { ...echo, permissions }, code: "" });
      const { render } = (await codeBlocks.get("echo")?.load()) ?? {};
      expect(
        await render?.("x", { language: "echo", info: "echo", theme: "light", target: "editor" }),
      ).toEqual({ html });
      host.close();
    }
  });

  it("stops it when its frame fails before it starts, and tries again when next used", async () => {
    let failing = true;
    const opened: string[] = [];
    const frame = frames(echoing([]));
    const open: FrameOpener = (request) => {
      if (!failing) return frame.open(request);
      opened.push("failing");
      queueMicrotask(() => {
        request.onFailure("Its main.js does not export a plugin as its default.");
      });
      return { port: new MessageChannel().port1, close: () => opened.push("closed") };
    };
    const { host, commands, errors } = make(open);
    close = () => {
      host.close();
    };
    host.addFolder({ manifest: echo, code: "" });
    commands.get("echo:say")?.run();
    await settle();
    expect(errors).toEqual(["echo: Its main.js does not export a plugin as its default."]);
    expect(opened).toEqual(["failing", "closed"]);
    failing = false;
    commands.get("echo:say")?.run();
    await settle();
    expect(errors).toHaveLength(1);
    expect(frame.opened).toHaveLength(1);
  });

  it("stops it when it does not start in time", async () => {
    const frame = frames();
    const { host, commands, errors } = make(frame.open, 20);
    close = () => {
      host.close();
    };
    host.addFolder({ manifest: echo, code: "" });
    commands.get("echo:say")?.run();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(errors).toEqual(["echo: It did not start in time."]);
    expect(frame.closed).toEqual([1]);
  });

  it("says what goes wrong in its frame once it runs", async () => {
    let fail: ((message: string) => void) | undefined;
    const frame = frames(echoing([]));
    const { host, commands, errors } = make((request) => {
      fail = request.onFailure;
      return frame.open(request);
    });
    close = () => {
      host.close();
    };
    host.addFolder({ manifest: echo, code: "" });
    commands.get("echo:say")?.run();
    await settle();
    fail?.("The worker stopped.");
    expect(errors).toEqual(["echo: The worker stopped."]);
  });
});

/** Waits for what a command set going to finish, as menus run commands without waiting. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

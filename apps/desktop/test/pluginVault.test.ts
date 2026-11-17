// A plugin reaches the vault as far as its manifest asks (ADR 0064): the
// app reads notes as they are now, writes them through their documents,
// moves them to the trash as it does itself, and never reaches a hidden
// folder.
import { type PluginContext, definePlugin, portTransport, startPlugin } from "@nether/plugin-api";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { newBlockId } from "@nether/core";
import { documentBlocks } from "@nether/editor";
import { serializeMarkdown } from "@nether/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenNote, noteDocuments } from "../src/noteDocuments.ts";
import { BlockRegistry } from "../src/plugins/blocks.ts";
import { CodeBlockRegistry } from "../src/plugins/codeBlocks.ts";
import type { FrameOpener } from "../src/plugins/frame.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { LayoutRegistry } from "../src/plugins/layouts.ts";
import { PanelRegistry } from "../src/plugins/panels.ts";
import { PropertyTypeRegistry } from "../src/plugins/propertyTypes.ts";
import { PropertyChangeRegistry } from "../src/plugins/propertyChanges.ts";
import { CommandRegistry } from "../src/plugins/registry.ts";
import { pluginPath, reachable, toBase64, vaultAccess } from "../src/plugins/vault.ts";
import { ViewRegistry } from "../src/plugins/views.ts";

const watching: AbortController[] = [];

afterEach(() => {
  for (const controller of watching.splice(0)) controller.abort();
});

async function setUp(files: Record<string, string>) {
  const vault = new Vault(new MemoryFiles(files), new MemoryStore());
  await vault.open();
  const controller = new AbortController();
  watching.push(controller);
  void vault.watch(controller.signal);
  const id = (path: string) => {
    const note = vault.noteAt(path);
    if (note === undefined) throw new Error(`No note at ${path}.`);
    return note.id;
  };
  return { vault, id, documents: noteDocuments(vault) };
}

/** Waits until `check` holds, a few seconds at most. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The note's blocks as Markdown, as the editor's document holds them. */
function textOf(note: OpenNote): string {
  const { state } = note.snapshot;
  if (state.status !== "ready") return "";
  return serializeMarkdown({ properties: [], content: documentBlocks(state.document, newBlockId) })
    .text;
}

describe("a plugin's paths", () => {
  it("reach the vault's notes and files, and no hidden folder", () => {
    expect(reachable("Ideas.md")).toBe(true);
    expect(reachable("Projects/Plan.md")).toBe(true);
    for (const path of [
      "",
      "/etc/passwd",
      "../Ideas.md",
      "Projects/../Ideas.md",
      "./Ideas.md",
      "Projects//Plan.md",
      "Projects\\Plan.md",
      ".nether/plugins/echo/main.js",
      ".obsidian/plugins/x/main.js",
      "Projects/.git/config",
    ]) {
      expect(reachable(path), path).toBe(false);
    }
    expect(pluginPath("Projects/Plan.md", true)).toBe("Projects/Plan.md");
    expect(() => pluginPath("Plan.txt", true)).toThrow(
      "Plan.txt is not a note: a note's path ends in .md.",
    );
    expect(() => pluginPath(".nether/plugins.json", false)).toThrow(
      'A plugin reaches no ".nether/plugins.json": not outside the vault, nor in a hidden folder.',
    );
    expect(() => pluginPath(3, false)).toThrow("A path is text.");
  });

  it("send bytes as Base64, however many", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, at) => at % 256);
    expect(Uint8Array.from(atob(toBase64(bytes)), (char) => char.charCodeAt(0))).toEqual(bytes);
  });
});

describe("vaultAccess", () => {
  it("reads a note as it is now, and writes it through its document", async () => {
    const { vault, id, documents } = await setUp({ "Ideas.md": "# Ideas\n\nFirst.\n" });
    const access = vaultAccess(vault, () => undefined);
    // An editor holds the note, with an edit not saved yet.
    const editor = documents.open(id("Ideas.md"));
    await until(() => editor.note.snapshot.state.status === "ready");
    editor.note.editText("# Ideas\n\nFirst.\n\nSecond.\n");
    expect(await access.read("Ideas.md")).toBe("# Ideas\n\nFirst.\n\nSecond.\n");
    await access.write("Ideas.md", "# Ideas\n\nFirst.\n\nSecond.\n\nThird.\n");
    // The editor's document has it, as source mode's text would be.
    expect(textOf(editor.note)).toBe("# Ideas\n\nFirst.\n\nSecond.\n\nThird.\n");
    editor.release();
    expect((await vault.read(id("Ideas.md"))).text).toBe(
      "# Ideas\n\nFirst.\n\nSecond.\n\nThird.\n",
    );
  });

  it("makes a note, lists notes and files, and moves a note to the trash", async () => {
    const { vault } = await setUp({
      "Ideas.md": "# Ideas\n",
      "pic.png": "png",
      "Projects/Plan.md": "Plan.\n",
    });
    const removed: string[] = [];
    const access = vaultAccess(vault, ({ title, plugin, where }) => {
      removed.push(`${plugin} ${title} ${where}`);
    });
    await access.write("Projects/New.md", "Made.\n");
    expect(access.notes().map((note) => note.path)).toEqual([
      "Ideas.md",
      "Projects/New.md",
      "Projects/Plan.md",
    ]);
    expect(await access.read("Projects/New.md")).toBe("Made.\n");
    expect(access.files()).toEqual(["pic.png"]);
    expect(new TextDecoder().decode(await access.readFile("pic.png"))).toBe("png");
    await expect(access.readFile("Ideas.md")).rejects.toThrow(
      "The vault has no file Ideas.md that is not a note.",
    );
    await expect(access.read("Gone.md")).rejects.toThrow("The vault has no note Gone.md.");
    await access.remove("Projects/New.md", "tidy");
    expect(vault.noteAt("Projects/New.md")).toBeUndefined();
    expect(removed).toEqual([expect.stringMatching(/^tidy New \S+/)]);
  });

  it("tells of the notes that change, by their paths", async () => {
    const { vault } = await setUp({ "Ideas.md": "# Ideas\n" });
    const access = vaultAccess(vault, () => undefined);
    const heard: string[][] = [];
    const stop = access.subscribe((paths) => heard.push([...paths]));
    await access.write("Ideas.md", "# Ideas\n\nMore.\n");
    await until(() => heard.some((paths) => paths.includes("Ideas.md")));
    stop();
  });
});

describe("a plugin reaching the vault, through the host", () => {
  const make = async (permissions: readonly string[]) => {
    const { vault } = await setUp({ "Ideas.md": "# Ideas\n" });
    const commands = new CommandRegistry();
    let context: PluginContext | undefined;
    const plugin = definePlugin({
      async activate(given) {
        context = given;
        await given.commands.register("go", () => undefined);
      },
    });
    const open: FrameOpener = () => {
      const { port1, port2 } = new MessageChannel();
      void startPlugin(plugin, portTransport(port2));
      return {
        port: port1,
        close() {
          port1.close();
          port2.close();
        },
      };
    };
    const access = vaultAccess(vault, () => undefined);
    const host = new PluginHost(
      {
        commands,
        codeBlocks: new CodeBlockRegistry(),
        blocks: new BlockRegistry(),
        panels: new PanelRegistry(),
        views: new ViewRegistry(),
        layouts: new LayoutRegistry(),
        propertyTypes: new PropertyTypeRegistry(),
        propertyChanges: new PropertyChangeRegistry(),
      },
      { language: "en", direction: "ltr", openFrame: open, vault: () => access },
    );
    expect(
      host.addFolder({
        manifest: {
          id: "reader",
          name: "Reader",
          version: "1.0.0",
          api: "^0.1",
          permissions,
          contributes: { commands: [{ id: "go", name: "Go" }] },
        },
        code: "",
      }),
    ).toEqual([]);
    // Its code starts when its command is first used.
    commands.get("reader:go")?.run();
    await until(() => context !== undefined);
    if (context === undefined) throw new Error("It did not start.");
    return { host, vault, reached: context.vault };
  };

  it("answers what the manifest asks for", async () => {
    const { host, vault, reached } = await make(["vault:read", "vault:write"]);
    expect(await reached.notes()).toEqual([
      { id: vault.noteAt("Ideas.md")?.id, path: "Ideas.md", title: "Ideas" },
    ]);
    expect(await reached.read("Ideas.md")).toBe("# Ideas\n");
    await reached.write("Ideas.md", "# Ideas\n\nWritten.\n");
    expect(await reached.read("Ideas.md")).toBe("# Ideas\n\nWritten.\n");
    const heard: string[] = [];
    const listening = await reached.onChange((paths) => heard.push(...paths));
    await reached.write("Ideas.md", "# Ideas\n\nAgain.\n");
    await until(() => heard.includes("Ideas.md"));
    await listening.dispose();
    await expect(reached.read(".nether/plugins.json")).rejects.toThrow("A plugin reaches no");
    host.close();
  });

  it("refuses what it did not ask for", async () => {
    const { host, reached } = await make(["vault:read"]);
    expect(await reached.read("Ideas.md")).toBe("# Ideas\n");
    await expect(reached.write("Ideas.md", "Gone.\n")).rejects.toThrow(
      "The plugin did not ask for vault:write.",
    );
    await expect(reached.remove("Ideas.md")).rejects.toThrow(
      "The plugin did not ask for vault:write.",
    );
    host.close();
    const { host: other, reached: none } = await make([]);
    await expect(none.notes()).rejects.toThrow("The plugin did not ask for vault:read.");
    other.close();
  });
});

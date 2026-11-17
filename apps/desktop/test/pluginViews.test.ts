// @vitest-environment jsdom
// A vault plugin's views (ADR 0063): the page shows what its worker draws,
// cleaned, and sends back the events it listens for. The worker's DOM runs
// here beside the page's, without taking the page's globals.
import {
  type Endpoint,
  type JsonObject,
  type Plugin,
  definePlugin,
  portTransport,
  startPlugin,
} from "@nether/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockRegistry } from "../src/plugins/blocks.ts";
import { CodeBlockRegistry } from "../src/plugins/codeBlocks.ts";
import type { FrameOpener } from "../src/plugins/frame.ts";
import { attachSurface, remoteSurface } from "../src/plugins/frame/remote.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { LayoutRegistry } from "../src/plugins/layouts.ts";
import { PanelRegistry } from "../src/plugins/panels.ts";
import { PropertyTypeRegistry } from "../src/plugins/propertyTypes.ts";
import { PropertyChangeRegistry } from "../src/plugins/propertyChanges.ts";
import { CommandRegistry } from "../src/plugins/registry.ts";
import { cssAllowed, nodeLimit, renderView } from "../src/plugins/render.ts";
import { ViewRegistry } from "../src/plugins/views.ts";

describe("cssAllowed", () => {
  it("refuses what loads from an address, or hides it in an escape", () => {
    expect(cssAllowed("color: red; margin: 0 auto;", false)).toBe(true);
    expect(cssAllowed('background: url("https://a.example/1");', false)).toBe(false);
    expect(cssAllowed("background: URL(x);", false)).toBe(false);
    expect(cssAllowed("--v: u\\72l(x);", false)).toBe(false);
    expect(cssAllowed('background-image: image-set(url("x") 1x);', false)).toBe(false);
    expect(cssAllowed("background: cross-fade(a, b);", false)).toBe(false);
    // A function that only ends like one that loads, as `myurl(`, is not one.
    expect(cssAllowed("width: calc(100% - 2px); color: rgb(0 0 0);", false)).toBe(true);
  });

  it("lets `https:` addresses stay with the network", () => {
    expect(cssAllowed('background: url("https://a.example/1");', true)).toBe(true);
    expect(cssAllowed("background: url(https://a.example/1);", true)).toBe(true);
    expect(cssAllowed('background: url("http://a.example/1");', true)).toBe(false);
    expect(cssAllowed('background: url("data:image/png;base64,AA");', true)).toBe(false);
    expect(cssAllowed("background: element(#a);", true)).toBe(false);
  });
});

describe("renderView", () => {
  const show = (network = false) => {
    const element = document.createElement("div");
    document.body.append(element);
    const sent: JsonObject[] = [];
    const refused: string[] = [];
    const view = renderView(element, {
      network,
      send: (event) => sent.push(event),
      onRefused: (message) => refused.push(message),
    });
    const shadow = element.shadowRoot;
    if (shadow === null) throw new Error("No shadow root.");
    const root = () => shadow.lastElementChild;
    return { element, view, sent, refused, shadow, root };
  };
  const el = (
    id: number,
    tag: string,
    attrs: [string, string][] = [],
    children: object[] = [],
  ) => ({
    id,
    tag,
    attrs,
    props: {},
    listens: [],
    children,
  });
  const text = (id: number, data: string) => ({ id, text: data });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("builds what it allows, and an empty comment for anything else", () => {
    const { view, root } = show();
    view.apply([
      ["root", 1],
      [
        "insert",
        1,
        0,
        el(
          2,
          "div",
          [
            ["onclick", "steal()"],
            ["class", "box"],
            ["popover", ""],
            ["autofocus", ""],
          ],
          [
            el(3, "script", [], [text(4, "steal()")]),
            el(5, "b", [], [text(6, "hi")]),
            el(7, "iframe", [["src", "https://a.example"]]),
            el(
              8,
              "a",
              [
                ["href", "https://a.example"],
                ["title", "t"],
              ],
              [text(9, "link")],
            ),
            el(10, "img", [
              ["src", "https://a.example/1.png"],
              ["alt", "a"],
            ]),
            el(11, "img", [["src", "data:image/png;base64,AA"]]),
            el(12, "input", [
              ["type", "file"],
              ["value", "v"],
            ]),
            el(13, "button", [["type", "submit"]], [text(14, "Go")]),
            el(15, "p", [["style", "color: red; background: url(https://a.example/2)"]]),
            el(16, "p", [
              ["style", "color: red"],
              ["data-x", "1"],
              ["aria-label", "l"],
            ]),
          ],
        ),
      ],
    ]);
    expect(root()?.innerHTML).toBe(
      '<div class="box"><!----><b>hi</b><!----><a title="t">link</a><img alt="a">' +
        '<img src="data:image/png;base64,AA"><input value="v"><button type="button">Go</button>' +
        '<p></p><p style="color: red;" data-x="1" aria-label="l"></p></div>',
    );
  });

  it("keeps SVG within itself", () => {
    const { view, root } = show();
    view.apply([
      ["root", 1],
      [
        "insert",
        1,
        0,
        el(
          2,
          "svg",
          [["viewbox", "0 0 1 1"]],
          [
            el(3, "lineargradient", [["id", "g"]]),
            el(4, "rect", [
              ["fill", "url(#g)"],
              ["stroke", "url(https://a.example/x)"],
            ]),
            el(5, "use", [["href", "https://a.example/s.svg#x"]]),
            el(6, "circle", [
              ["fill", "u\\72l(https://a.example)"],
              ["r", "1"],
            ]),
          ],
        ),
      ],
    ]);
    const svg = root()?.firstElementChild;
    expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 1 1");
    expect(svg?.innerHTML).toBe(
      '<linearGradient id="g"></linearGradient><rect fill="url(#g)"></rect><!----><circle r="1"></circle>',
    );
  });

  it("keeps `https:` images with the network", () => {
    const { view, root } = show(true);
    view.apply([
      ["root", 1],
      ["insert", 1, 0, el(2, "img", [["src", "https://a.example/1.png"]])],
    ]);
    expect(root()?.innerHTML).toBe('<img src="https://a.example/1.png">');
  });

  it("follows the worker's changes, in place", () => {
    const { view, root } = show();
    view.apply([
      ["root", 1],
      [
        "insert",
        1,
        0,
        el(2, "ul", [], [el(3, "li", [], [text(4, "a")]), el(5, "li", [], [text(6, "c")])]),
      ],
    ]);
    view.apply([
      ["insert", 2, 1, el(7, "li", [], [text(8, "b")])],
      ["text", 4, "A"],
      ["attr", 2, "class", "list"],
      ["attr", 5, "onmouseover", "steal()"],
    ]);
    expect(root()?.innerHTML).toBe('<ul class="list"><li>A</li><li>b</li><li>c</li></ul>');
    view.apply([
      ["remove", 2, 7],
      ["attr", 2, "class", null],
      // What is gone, or never was, is left alone.
      ["text", 8, "B"],
      ["remove", 2, 99],
      ["bogus", 2],
      "not a change",
    ]);
    expect(root()?.innerHTML).toBe("<ul><li>A</li><li>c</li></ul>");
  });

  it("sets what an input shows, and focuses it", () => {
    const { view, shadow } = show();
    view.apply([
      ["root", 1],
      ["insert", 1, 0, el(2, "input", [["type", "checkbox"]])],
      ["insert", 1, 1, el(3, "input", [])],
      ["prop", 2, "checked", true],
      ["prop", 3, "value", "typed"],
      ["call", 3, "focus"],
    ]);
    const [box, field] = shadow.querySelectorAll("input");
    expect(box?.checked).toBe(true);
    expect(field?.value).toBe("typed");
    expect(shadow.activeElement).toBe(field);
  });

  it("sends the events listened for, from their targets", () => {
    const { view, shadow, sent } = show();
    view.apply([
      ["root", 1],
      [
        "insert",
        1,
        0,
        el(2, "div", [], [el(3, "button", [], [text(4, "Go")]), el(5, "input", [])]),
      ],
      ["listen", 1, "click"],
      ["listen", 5, "input"],
      ["listen", 5, "onclick"],
    ]);
    shadow.querySelector("button")?.click();
    const input = shadow.querySelector("input");
    if (input === null) throw new Error("No input.");
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sent).toEqual([
      expect.objectContaining({ type: "click", target: 3 }),
      expect.objectContaining({ type: "input", target: 5, value: "hello" }),
    ]);
    view.apply([["unlisten", 1, "click"]]);
    shadow.querySelector("button")?.click();
    expect(sent).toHaveLength(2);
  });

  it("draws no more than its limit, and says so once", () => {
    const { view, refused, root } = show();
    const many = Array.from({ length: nodeLimit + 5 }, (_, at) => el(at + 3, "i"));
    view.apply([
      ["root", 1],
      ["insert", 1, 0, el(2, "div", [], many)],
    ]);
    expect(root()?.querySelectorAll("i")).toHaveLength(nodeLimit - 1);
    expect(refused).toEqual([`A view may draw at most ${String(nodeLimit)} nodes.`]);
  });

  it("empties the view when disposed", () => {
    const { view, shadow } = show();
    view.apply([
      ["root", 1],
      ["insert", 1, 0, el(2, "b", [], [text(3, "x")])],
    ]);
    view.dispose();
    expect(shadow.childNodes).toHaveLength(0);
  });
});

describe("a vault plugin's views, through the host", () => {
  /** Runs `plugin` at the other end of a port, with a DOM of the worker's own beside the page's. */
  function frames(plugin: Plugin) {
    const ends: Promise<Endpoint>[] = [];
    const open: FrameOpener = () => {
      const { port1, port2 } = new MessageChannel();
      const surface = remoteSurface(false);
      const end = startPlugin(plugin, portTransport(port2), surface).then((endpoint) => {
        attachSurface(surface, endpoint);
        return endpoint;
      });
      ends.push(end);
      return {
        port: port1,
        close() {
          port1.close();
          port2.close();
        },
      };
    };
    return { open, ends };
  }

  const make = (openFrame: FrameOpener) => {
    const panels = new PanelRegistry();
    const errors: string[] = [];
    const host = new PluginHost(
      {
        commands: new CommandRegistry(),
        codeBlocks: new CodeBlockRegistry(),
        blocks: new BlockRegistry(),
        panels,
        views: new ViewRegistry(),
        layouts: new LayoutRegistry(),
        propertyTypes: new PropertyTypeRegistry(),
        propertyChanges: new PropertyChangeRegistry(),
      },
      {
        language: "en",
        direction: "ltr",
        openFrame,
        onError: (plugin, message) => {
          errors.push(`${plugin}: ${message}`);
        },
      },
    );
    return { host, panels, errors };
  };

  const manifest = {
    id: "counter",
    name: "Counter",
    version: "1.0.0",
    api: "^0.1",
    contributes: { panels: [{ id: "count", name: "Count", place: "note" }] },
  };

  const counter = definePlugin({
    async activate(context) {
      await context.panels.register("count", {
        mount(element, props) {
          const page = element.ownerDocument;
          const button = page.createElement("button");
          let clicks = 0;
          button.textContent = `${props.theme} 0`;
          button.addEventListener("click", () => {
            clicks++;
            button.textContent = `${props.theme} ${String(clicks)}`;
          });
          const style = page.createElement("style");
          style.textContent = "button { color: red }";
          element.append(style, button);
          element.style.padding = "2px";
          return {
            unmount() {
              element.replaceChildren();
            },
          };
        },
      });
    },
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows what the plugin draws, and sends it the clicks it listens for", async () => {
    const { open, ends } = frames(counter);
    const { host, panels, errors } = make(open);
    expect(host.addFolder({ manifest, code: "" })).toEqual([]);
    const drawing = await panels.get("counter:count")?.load();
    const element = document.createElement("div");
    document.body.append(element);
    const mounted = await drawing?.mount?.(element, { theme: "light" });
    const shadow = element.shadowRoot;
    if (shadow === null) throw new Error("No shadow root.");
    await vi.waitFor(() => {
      expect(shadow.querySelector("button")?.textContent).toBe("light 0");
    });
    expect(shadow.lastElementChild?.getAttribute("style")).toBe("padding: 2px;");
    shadow.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(shadow.querySelector("button")?.textContent).toBe("light 1");
    });
    // A plugin draws only in its own views.
    const [end] = ends;
    await expect((await end)?.call("views.draw", "other:1", [])).rejects.toThrow(
      "The plugin shows no such view.",
    );
    mounted?.unmount();
    expect(shadow.childNodes).toHaveLength(0);
    expect(errors).toEqual([]);
    host.close();
  });
});

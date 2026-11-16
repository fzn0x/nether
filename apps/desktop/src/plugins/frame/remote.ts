// The DOM a plugin from a vault draws its views in, in its worker (ADR
// 0063). It is @remote-dom/polyfill's, with what views need added: input
// values, `style` and focus. Each view's root is an element of it; what
// changes under a root the page has is sent to the page, once per task,
// by the view's slot. Events the page sends back are dispatched here, at
// their targets.
import {
  type Endpoint,
  type Json,
  type JsonObject,
  type PluginSurface,
  isJsonObject,
} from "@nether/plugin-api";
import { Window, type WindowExtension } from "@remote-dom/polyfill";

/** A node as it crosses to the page, with all under it. */
export type Tree =
  | { readonly id: number; readonly text: string }
  | { readonly id: number; readonly comment: true }
  | {
      readonly id: number;
      readonly tag: string;
      readonly svg?: true;
      readonly attrs: readonly (readonly [string, string])[];
      readonly props: JsonObject;
      readonly listens: readonly string[];
      readonly children: readonly Tree[];
    };

/** One change to a view the page shows. */
export type Change =
  | readonly ["root", number]
  | readonly ["insert", number, number, Tree]
  | readonly ["remove", number, number]
  | readonly ["attr", number, string, string | null]
  | readonly ["text", number, string]
  | readonly ["prop", number, string, Json]
  | readonly ["listen", number, string]
  | readonly ["unlisten", number, string]
  | readonly ["call", number, string];

/** Sends a view's changes to the page. */
export type Sender = (slot: string, changes: readonly Change[]) => void;

/** An event as the page sends it: its type, its target's ID, and what it carries. */
export type SentEvent = JsonObject;

/** The surface a plugin in a worker mounts its views on, and what the worker drives it with. */
export interface RemoteSurface extends PluginSurface {
  /** Starts sending changes, those waiting first. */
  connect(send: Sender): void;
  /** Dispatches an event the page sends, at its target in the view of `slot`. */
  dispatch(slot: string, event: SentEvent): void;
}

const svgNamespace = "http://www.w3.org/2000/svg";

/** The properties a view sets that the page keeps in step, with the values they start at. */
const properties = {
  value: (element: Element): Json => element.getAttribute("value") ?? "",
  checked: (element: Element): Json => element.hasAttribute("checked"),
  selected: (element: Element): Json => element.hasAttribute("selected"),
  indeterminate: (): Json => false,
} as const;

type Property = keyof typeof properties;

/** Events that rise through the elements around their target, as in a page. */
const rising = new Set([
  "click",
  "dblclick",
  "input",
  "change",
  "keydown",
  "keyup",
  "focusin",
  "focusout",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseover",
  "mouseout",
  "wheel",
]);

/** Splits a style attribute into its declarations, minding quotes and brackets. */
function declarations(text: string): Map<string, string> {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === ";" && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  const found = new Map<string, string>();
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (name !== "" && value !== "")
      found.set(name.startsWith("--") ? name : name.toLowerCase(), value);
  }
  return found;
}

/** A value written into a style or an input, as text. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/** A style's property as CSS names it: `backgroundColor` is `background-color`. */
function cssName(name: string): string {
  if (name.startsWith("--")) return name;
  if (name === "cssFloat") return "float";
  const kebab = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  // `WebkitTransform` is `-webkit-transform`.
  return /^(?:webkit|moz|ms)-/.test(kebab) && /^[A-Z]/.test(name) ? `-${kebab}` : kebab;
}

/** An element's `style`: what it reads and writes is its style attribute. */
function styleOf(element: Element): CSSStyleDeclaration {
  const read = () => declarations(element.getAttribute("style") ?? "");
  const write = (found: Map<string, string>) => {
    const text = [...found].map(([name, value]) => `${name}: ${value}`).join("; ");
    if (text === "") element.removeAttribute("style");
    else element.setAttribute("style", text);
  };
  const methods = {
    getPropertyValue: (name: string) => read().get(cssName(name)) ?? "",
    setProperty: (name: string, value: unknown) => {
      const found = read();
      const text = asText(value).trim();
      if (text === "") found.delete(cssName(name));
      else found.set(cssName(name), text);
      write(found);
    },
    removeProperty: (name: string) => {
      const found = read();
      const before = found.get(cssName(name)) ?? "";
      found.delete(cssName(name));
      write(found);
      return before;
    },
    item: (index: number) => [...read().keys()][index] ?? "",
  };
  return new Proxy(methods, {
    get(target, name) {
      if (typeof name !== "string") return undefined;
      if (Object.hasOwn(target, name)) return target[name as keyof typeof methods];
      if (name === "cssText") return element.getAttribute("style") ?? "";
      if (name === "length") return read().size;
      return target.getPropertyValue(name);
    },
    set(target, name, value) {
      if (typeof name !== "string") return false;
      if (name === "cssText") {
        write(declarations(asText(value)));
        return true;
      }
      target.setProperty(name, value);
      return true;
    },
  }) as unknown as CSSStyleDeclaration;
}

/** What an element's added properties and methods reach, in the DOM it is of. */
interface Owner {
  property(element: Element, name: Property): Json | undefined;
  setProperty(element: Element, name: Property, value: Json): void;
  call(element: Element, method: string): void;
}

/** Each worker DOM's owner, by its document. */
const owners = new WeakMap<object, Owner>();
/** The classes already given what views need. */
const added = new WeakSet<object>();

/**
 * Gives the polyfill's elements what views need and it lacks: input
 * values, `style`, and focus. Its HTML and SVG elements share one class
 * for every DOM it makes, so each element finds its own by its document.
 */
function addToElements(prototype: object): void {
  if (added.has(prototype)) return;
  added.add(prototype);
  const ownerOf = (element: Element) => owners.get(element.ownerDocument);
  for (const name of Object.keys(properties) as Property[]) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      get(this: Element) {
        return ownerOf(this)?.property(this, name) ?? properties[name](this);
      },
      set(this: Element, value: unknown) {
        ownerOf(this)?.setProperty(this, name, name === "value" ? asText(value) : Boolean(value));
      },
    });
  }
  Object.defineProperty(prototype, "style", {
    configurable: true,
    get(this: Element) {
      return styleOf(this);
    },
    set(this: Element, value: unknown) {
      styleOf(this).cssText = asText(value);
    },
  });
  for (const method of ["focus", "blur"]) {
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value(this: Element) {
        ownerOf(this)?.call(this, method);
      },
    });
  }
}

/**
 * Makes the worker's DOM, and puts it in place as `document`, `window` and
 * their classes unless `install` is false, as in a test with a page's DOM
 * already; gives the surface the plugin's views mount on.
 */
export function remoteSurface(install = true): RemoteSurface {
  const ids = new WeakMap<object, number>();
  let lastId = 0;
  const idOf = (node: object): number => {
    let id = ids.get(node);
    if (id === undefined) {
      id = ++lastId;
      ids.set(node, id);
    }
    return id;
  };
  /** The view each node the page has is in. */
  const viewOf = new WeakMap<object, string>();
  /** The nodes the page has, by ID. */
  const shown = new Map<number, Node>();
  /** Each view's root, by its slot. */
  const roots = new Map<string, Element>();
  /** The types of events each node listens for, each with how many listeners. */
  const listening = new WeakMap<object, Map<string, number>>();
  /** The properties a view set on each element. */
  const set = new WeakMap<object, Map<Property, Json>>();
  const waiting = new Map<string, Change[]>();
  let send: Sender | undefined;
  let flushing = false;

  const flush = () => {
    flushing = false;
    if (send === undefined) return;
    const changes = [...waiting];
    waiting.clear();
    for (const [slot, list] of changes) send(slot, list);
  };
  const queue = (slot: string, change: Change) => {
    let list = waiting.get(slot);
    if (list === undefined) {
      list = [];
      waiting.set(slot, list);
    }
    list.push(change);
    if (!flushing && send !== undefined) {
      flushing = true;
      queueMicrotask(flush);
    }
  };

  /** A node and all under it, as the page builds them; from now on in `slot`'s view. */
  const tree = (node: Node, slot: string): Tree => {
    const id = idOf(node);
    viewOf.set(node, slot);
    shown.set(id, node);
    if (node.nodeType === 3) return { id, text: (node as Text).data };
    if (node.nodeType !== 1) return { id, comment: true };
    const element = node as Element;
    return {
      id,
      tag: element.localName,
      ...(element.namespaceURI === svgNamespace ? { svg: true as const } : {}),
      attrs: [...element.attributes].map((attribute) => [attribute.name, attribute.value] as const),
      props: Object.fromEntries(set.get(element) ?? []),
      listens: [...(listening.get(element) ?? [])]
        .filter(([, count]) => count > 0)
        .map(([type]) => type),
      children: [...element.childNodes].map((child) => tree(child, slot)),
    };
  };
  /** Takes a node and all under it out of the page's view. */
  const forget = (node: Node) => {
    viewOf.delete(node);
    shown.delete(idOf(node));
    // The polyfill's text has no child nodes at all.
    if (node.nodeType === 1) for (const child of node.childNodes) forget(child);
  };

  /** Sets a property a view keeps in step; `quietly`, for what the page already shows. */
  const setProperty = (element: Element, name: Property, value: Json, quietly = false) => {
    let own = set.get(element);
    if (own === undefined) {
      own = new Map();
      set.set(element, own);
    }
    own.set(name, value);
    const slot = viewOf.get(element);
    if (!quietly && slot !== undefined) queue(slot, ["prop", idOf(element), name, value]);
  };

  const extension: WindowExtension = (window) => {
    const { Element: elements, document } = window as unknown as {
      readonly Element: { readonly prototype: object };
      readonly document: object;
    };
    addToElements(elements.prototype);
    owners.set(document, {
      property: (element, name) => set.get(element)?.get(name),
      setProperty: (element, name, value) => {
        setProperty(element, name, value);
      },
      call: (element, method) => {
        const slot = viewOf.get(element);
        if (slot !== undefined) queue(slot, ["call", idOf(element), method]);
      },
    });
    return {
      insertChild(parent, node) {
        const slot = viewOf.get(parent);
        if (slot === undefined) return;
        const index = [...parent.childNodes].indexOf(node);
        queue(slot, ["insert", idOf(parent), index, tree(node, slot)]);
      },
      removeChild(parent, node) {
        const slot = viewOf.get(parent);
        if (slot === undefined || viewOf.get(node) !== slot) return;
        queue(slot, ["remove", idOf(parent), idOf(node)]);
        forget(node);
      },
      setAttribute(element, name, value) {
        const slot = viewOf.get(element);
        if (slot !== undefined) queue(slot, ["attr", idOf(element), name, value]);
      },
      removeAttribute(element, name) {
        const slot = viewOf.get(element);
        if (slot !== undefined) queue(slot, ["attr", idOf(element), name, null]);
      },
      setText(node, data) {
        const slot = viewOf.get(node);
        if (slot !== undefined) queue(slot, ["text", idOf(node), data]);
      },
      addEventListener(target, type) {
        let counts = listening.get(target);
        if (counts === undefined) {
          counts = new Map();
          listening.set(target, counts);
        }
        const count = (counts.get(type) ?? 0) + 1;
        counts.set(type, count);
        const slot = viewOf.get(target);
        if (count === 1 && slot !== undefined) queue(slot, ["listen", idOf(target), type]);
      },
      removeEventListener(target, type) {
        const counts = listening.get(target);
        const count = counts?.get(type) ?? 0;
        if (counts === undefined || count === 0) return;
        counts.set(type, count - 1);
        const slot = viewOf.get(target);
        if (count === 1 && slot !== undefined) queue(slot, ["unlisten", idOf(target), type]);
      },
    };
  };

  const DomWindow = Window.with(extension);
  const window = new DomWindow();
  if (install) Window.setGlobal(window);
  const events = window as unknown as {
    readonly Event: new (type: string, init: { bubbles: boolean; cancelable: boolean }) => Event;
  };

  return {
    element(slot) {
      const root = window.document.createElement("div") as unknown as HTMLElement;
      roots.set(slot, root);
      viewOf.set(root, slot);
      shown.set(idOf(root), root);
      queue(slot, ["root", idOf(root)]);
      return root;
    },
    release(slot) {
      const root = roots.get(slot);
      waiting.delete(slot);
      if (root === undefined) return;
      roots.delete(slot);
      forget(root);
    },
    connect(sender) {
      send = sender;
      if (waiting.size > 0 && !flushing) {
        flushing = true;
        queueMicrotask(flush);
      }
    },
    dispatch(slot, sent) {
      const { target, type } = sent;
      if (typeof target !== "number" || typeof type !== "string") return;
      const node = shown.get(target);
      if (node === undefined || viewOf.get(node) !== slot) return;
      const element = node as Element;
      // What the page already shows, the worker's DOM now knows.
      if (typeof sent.value === "string") setProperty(element, "value", sent.value, true);
      if (typeof sent.checked === "boolean") setProperty(element, "checked", sent.checked, true);
      if (type === "resize") {
        for (const [field, name] of [
          ["width", "clientWidth"],
          ["height", "clientHeight"],
        ] as const) {
          const size = sent[field];
          if (typeof size === "number")
            Object.defineProperty(element, name, { configurable: true, value: size });
        }
      }
      const event = new events.Event(type, { bubbles: rising.has(type), cancelable: true });
      for (const [field, value] of Object.entries(sent)) {
        if (field === "target" || field === "type") continue;
        Object.defineProperty(event, field, { configurable: true, enumerable: true, value });
      }
      element.dispatchEvent(event);
    },
  };
}

/**
 * Joins a surface to the plugin's end of its connection: what its views
 * draw goes to the app, and the events the app sends come to them.
 */
export function attachSurface(surface: RemoteSurface, endpoint: Endpoint): void {
  endpoint.handle("views.event", (slot, event) => {
    if (typeof slot === "string" && isJsonObject(event)) surface.dispatch(slot, event);
    return null;
  });
  surface.connect((slot, changes) => {
    // A view the app has already taken away refuses what it drew last.
    endpoint.call("views.draw", slot, changes).catch(() => undefined);
  });
}

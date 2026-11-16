// Shows a view a plugin from a vault draws in its worker (ADR 0063): the
// page builds, in a shadow root on the app's element, only the elements,
// attributes and styles it allows, from the changes the worker sends, and
// sends back the events the plugin listens for. Anything it does not
// allow becomes an empty comment, so what follows stays in step.
import type { Json, JsonObject } from "@nether/plugin-api";

/** A view the page shows for a plugin, from the changes it sends. */
export interface ViewRenderer {
  /** Applies a batch of changes; what does not read as one is left out. */
  apply(changes: unknown): void;
  /** Empties the view and stops listening. */
  dispose(): void;
}

export interface RenderOptions {
  /** Whether the plugin was approved for the network, which lets `https:` addresses stay. */
  readonly network: boolean;
  /** Sends an event the plugin listens for to its worker. */
  readonly send: (event: JsonObject) => void;
  /** Told once, of what the page refused to show. */
  readonly onRefused?: (message: string) => void;
}

/** The most nodes a view may have. */
export const nodeLimit = 10_000;

const svgNamespace = "http://www.w3.org/2000/svg";

const htmlElements = new Set([
  ..."div span p br hr b i em strong u s small mark code pre kbd samp var sub sup abbr cite q dfn".split(
    " ",
  ),
  ..."time data bdi bdo wbr ruby rt rp del ins blockquote figure figcaption".split(" "),
  ..."h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col".split(
    " ",
  ),
  ..."section article header footer nav aside main address details summary a img".split(" "),
  ..."label input textarea select option optgroup button fieldset legend output progress meter".split(
    " ",
  ),
  "datalist",
  "style",
]);

/** SVG's elements, by their name in lower case, as SVG spells them. */
const svgElements = new Map(
  [
    ..."svg g path rect circle ellipse line polyline polygon text tspan title desc defs".split(" "),
    ..."linearGradient radialGradient stop clipPath mask marker pattern filter style".split(" "),
    ..."feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting".split(
      " ",
    ),
    ..."feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR".split(
      " ",
    ),
    ..."feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight".split(" "),
    ..."feSpecularLighting feSpotLight feTile feTurbulence".split(" "),
  ].map((name) => [name.toLowerCase(), name]),
);

const globalAttributes = new Set(
  "id class title lang dir role tabindex hidden translate spellcheck style".split(" "),
);

const htmlAttributes: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    img: "src alt width height loading decoding",
    input:
      "type name value checked placeholder min max step minlength maxlength pattern disabled readonly required multiple size list autocomplete inputmode",
    textarea: "name rows cols placeholder disabled readonly required minlength maxlength wrap",
    select: "name disabled multiple required size",
    option: "value selected disabled label",
    optgroup: "label disabled",
    button: "type name value disabled",
    label: "for",
    output: "for name",
    fieldset: "disabled name",
    td: "colspan rowspan headers",
    th: "colspan rowspan headers scope abbr",
    col: "span",
    colgroup: "span",
    ol: "start reversed type",
    li: "value",
    progress: "value max",
    meter: "value min max low high optimum",
    details: "open",
    time: "datetime",
    data: "value",
    del: "datetime",
    ins: "datetime",
  }).map(([tag, names]) => [tag, new Set(names.split(" "))]),
);

/** SVG's attributes, by their name in lower case, as SVG spells them. */
const svgAttributes = new Map(
  [
    ..."viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr d points".split(
      " ",
    ),
    ..."transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap".split(
      " ",
    ),
    ..."stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity offset".split(
      " ",
    ),
    ..."stop-color stop-opacity color display visibility clip-path clip-rule mask filter".split(
      " ",
    ),
    ..."marker-start marker-mid marker-end flood-color flood-opacity lighting-color".split(" "),
    ..."font-family font-size font-weight font-style text-anchor dominant-baseline".split(" "),
    ..."alignment-baseline baseline-shift letter-spacing word-spacing text-decoration".split(" "),
    ..."writing-mode vector-effect shape-rendering paint-order pointer-events overflow dx dy".split(
      " ",
    ),
    ..."rotate pathLength textLength lengthAdjust gradientUnits gradientTransform spreadMethod".split(
      " ",
    ),
    ..."patternUnits patternContentUnits patternTransform clipPathUnits maskUnits".split(" "),
    ..."maskContentUnits markerUnits markerWidth markerHeight refX refY orient filterUnits".split(
      " ",
    ),
    ..."primitiveUnits in in2 result operator k1 k2 k3 k4 mode type values stdDeviation".split(" "),
    ..."baseFrequency numOctaves seed stitchTiles tableValues slope intercept amplitude".split(" "),
    ..."exponent kernelMatrix order divisor bias targetX targetY edgeMode preserveAlpha".split(" "),
    ..."surfaceScale diffuseConstant specularConstant specularExponent kernelUnitLength".split(" "),
    ..."azimuth elevation z pointsAtX pointsAtY pointsAtZ limitingConeAngle radius scale".split(
      " ",
    ),
    ..."xChannelSelector yChannelSelector href xlink:href".split(" "),
  ].map((name) => [name.toLowerCase(), name]),
);

/** The kinds of input a view may draw; any other is a text box. */
const inputTypes = new Set(
  "text search number range checkbox radio date time datetime-local month week color email url tel button hidden".split(
    " ",
  ),
);

/** Images as data, the only addresses a view without the network keeps. */
const dataImage = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp)[;,]/i;

/** Functions of CSS that load from an address, or draw something else in. */
const loading = new Set([
  "url",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
  "element",
  "-moz-element",
  "paint",
  "src",
]);

/**
 * Whether CSS, as the browser writes it out, loads nothing from an
 * address: with the network, `url(https:…)` and `image-set` may stay.
 * Written out, escapes are undone, so one left is refused.
 */
export function cssAllowed(text: string, network: boolean): boolean {
  if (text.includes("\\")) return false;
  for (const match of text.matchAll(/([a-z-]+)\s*\(/gi)) {
    const name = (match.at(1) ?? "").toLowerCase();
    if (!loading.has(name)) continue;
    if (network && (name === "image-set" || name === "-webkit-image-set")) continue;
    if (network && name === "url") {
      const after = text.slice(match.index + match[0].length).trimStart();
      if (/^["']?https:/i.test(after)) continue;
    }
    return false;
  }
  return true;
}

/** What a group of rules says before its `{`, as `@media (min-width: 40em)`. */
function prelude(rule: CSSRule): string {
  const text = rule.cssText;
  const brace = text.indexOf("{");
  return brace < 0 ? "" : text.slice(0, brace).trim();
}

/**
 * The rules of a sheet a view may keep: style and keyframes rules that
 * load nothing, inside media, supports and container rules as found.
 */
function keptRules(rules: CSSRuleList, network: boolean): string[] {
  const kept: string[] = [];
  const grouping = [
    globalThis.CSSMediaRule,
    globalThis.CSSSupportsRule,
    globalThis.CSSContainerRule,
  ];
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule || rule instanceof CSSKeyframesRule) {
      if (cssAllowed(rule.cssText, network)) kept.push(rule.cssText);
    } else if (grouping.some((kind) => typeof kind === "function" && rule instanceof kind)) {
      const head = prelude(rule);
      const inner = keptRules((rule as CSSGroupingRule).cssRules, network);
      if (head !== "" && cssAllowed(head, network) && inner.length > 0) {
        kept.push(`${head} {\n${inner.join("\n")}\n}`);
      }
    }
  }
  return kept;
}

/** A `style` element's text, as the browser reads it, with only what a view may keep. */
export function cleanSheet(text: string, network: boolean): string {
  if (typeof CSSStyleSheet !== "function" || !("replaceSync" in CSSStyleSheet.prototype)) return "";
  const sheet = new CSSStyleSheet();
  try {
    // `@import` is left out by the browser here.
    sheet.replaceSync(text);
  } catch {
    return "";
  }
  return keptRules(sheet.cssRules, network).join("\n");
}

/** Events a view may listen for, and how often each crosses. */
const listenable = new Set([
  "click",
  "dblclick",
  "input",
  "change",
  "keydown",
  "keyup",
  "focus",
  "blur",
  "focusin",
  "focusout",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "pointerenter",
  "pointerleave",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "wheel",
  "scroll",
  "toggle",
  "resize",
]);
/** Events that come many at once: only the last of each frame crosses. */
const frequent = new Set(["pointermove", "mousemove", "wheel", "scroll"]);

/** The fields of an event a view is told of. */
const eventFields = [
  "key",
  "code",
  "altKey",
  "ctrlKey",
  "metaKey",
  "shiftKey",
  "repeat",
  "isComposing",
  "button",
  "buttons",
  "clientX",
  "clientY",
  "offsetX",
  "offsetY",
  "detail",
  "pointerId",
  "pointerType",
  "isPrimary",
  "pressure",
  "deltaX",
  "deltaY",
  "deltaZ",
  "deltaMode",
  "newState",
  "oldState",
] as const;

function readEvent(event: Event, target: Node): Record<string, Json> {
  const read: Record<string, Json> = {};
  const fields = event as unknown as Record<string, unknown>;
  for (const field of eventFields) {
    const value = fields[field];
    if (typeof value === "string" || typeof value === "boolean") read[field] = value;
    else if (typeof value === "number" && Number.isFinite(value)) read[field] = value;
  }
  if (target instanceof HTMLInputElement) {
    read.value = target.value;
    if (target.type === "checkbox" || target.type === "radio") read.checked = target.checked;
  } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    read.value = target.value;
  }
  if (event.type === "scroll" && target instanceof Element) {
    read.scrollTop = target.scrollTop;
    read.scrollLeft = target.scrollLeft;
  }
  if (event.type === "toggle" && target instanceof HTMLDetailsElement) read.open = target.open;
  return read;
}

type Tree = JsonObject;

function isTree(value: unknown): value is Tree {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Tree).id === "number"
  );
}

/** Shows a plugin's view in a shadow root on `element`, from the changes it sends. */
export function renderView(element: HTMLElement, options: RenderOptions): ViewRenderer {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const base = document.createElement("style");
  // Nothing the view draws leaves its box, a fixed position included.
  base.textContent = ":host { display: block; contain: content; }";
  const wrapper = document.createElement("div");
  shadow.append(base, wrapper);

  /** The nodes shown, by the IDs the worker gave them. */
  const nodes = new Map<number, Node>();
  const idOf = new WeakMap<Node, number>();
  /** Each `style` element's text, as the worker has it, apart from what is shown. */
  const sheetOf = new WeakMap<Node, HTMLStyleElement | SVGStyleElement>();
  /** The `style` elements whose text changed in this batch. */
  const restyle = new Set<Node>();
  /** The types each node listens for. */
  const listensOf = new Map<number, Set<string>>();
  /** For each type of event, how many nodes listen for it, and the page's listener. */
  const listeners = new Map<string, { count: number; readonly listener: (event: Event) => void }>();
  let rootId: number | undefined;
  let count = 0;
  let refused = false;
  let resizing: ResizeObserver | undefined;
  const pending = new Map<string, JsonObject>();
  let frameAsked = false;
  const scratch = document.createElement("div");

  const refuse = (message: string) => {
    if (refused) return;
    refused = true;
    options.onRefused?.(message);
  };

  const flushFrequent = () => {
    frameAsked = false;
    const sent = [...pending.values()];
    pending.clear();
    for (const event of sent) options.send(event);
  };
  const nextFrame = (run: () => void) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  };

  const onEvent = (event: Event) => {
    const path = event.composedPath();
    let target: Node | undefined;
    let id: number | undefined;
    for (const step of path) {
      if (!(step instanceof Node) || step.nodeType !== 1) continue;
      id = idOf.get(step);
      if (id !== undefined) {
        target = step;
        break;
      }
      if (step === wrapper) break;
    }
    if (target === undefined || id === undefined) return;
    const sent = { ...readEvent(event, target), type: event.type, target: id };
    if (frequent.has(event.type)) {
      pending.set(event.type, sent);
      if (!frameAsked) {
        frameAsked = true;
        nextFrame(flushFrequent);
      }
    } else {
      options.send(sent);
    }
  };

  const listen = (id: number, type: string) => {
    if (!listenable.has(type)) return;
    let types = listensOf.get(id);
    if (types === undefined) {
      types = new Set();
      listensOf.set(id, types);
    }
    if (types.has(type)) return;
    types.add(type);
    if (type === "resize") {
      if (id !== rootId || typeof ResizeObserver !== "function") return;
      resizing ??= new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box !== undefined && rootId !== undefined) {
          options.send({ type: "resize", target: rootId, width: box.width, height: box.height });
        }
      });
      resizing.observe(wrapper);
      return;
    }
    const known = listeners.get(type);
    if (known !== undefined) {
      known.count++;
      return;
    }
    const listener = (event: Event) => {
      onEvent(event);
    };
    // Caught on the way in, so that events that do not rise are heard too.
    shadow.addEventListener(type, listener, { capture: true, passive: true });
    listeners.set(type, { count: 1, listener });
  };
  const unlisten = (id: number, type: string) => {
    const types = listensOf.get(id);
    if (types?.delete(type) !== true) return;
    if (type === "resize") {
      if (id === rootId) resizing?.disconnect();
      return;
    }
    const known = listeners.get(type);
    if (known === undefined) return;
    known.count--;
    if (known.count === 0) {
      shadow.removeEventListener(type, known.listener, { capture: true });
      listeners.delete(type);
    }
  };

  const setAttribute = (node: Element, name: string, value: string | null) => {
    const svg = node.namespaceURI === svgNamespace;
    const lower = name.toLowerCase();
    if (value === null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
      return;
    }
    let shown: string | undefined;
    if (lower.startsWith("on")) return;
    if (lower.startsWith("aria-") || lower.startsWith("data-")) {
      shown = value;
    } else if (lower === "style") {
      scratch.setAttribute("style", value);
      const text = scratch.style.cssText;
      scratch.removeAttribute("style");
      if (!cssAllowed(text, options.network)) return;
      shown = text;
    } else if (globalAttributes.has(lower)) {
      shown = value;
    } else if (svg) {
      const spelled = svgAttributes.get(lower);
      if (spelled === undefined) return;
      // An SVG drawing links only within itself.
      if ((spelled === "href" || spelled === "xlink:href") && !value.trim().startsWith("#")) return;
      // Read as CSS, where an escape could spell `url(`.
      if (value.includes("\\") || /url\s*\(\s*['"]?\s*(?!#)/i.test(value)) return;
      if (spelled === "xlink:href") {
        node.setAttributeNS("http://www.w3.org/1999/xlink", spelled, value);
        return;
      }
      name = spelled;
      shown = value;
    } else {
      const tag = node.localName;
      if (htmlAttributes.get(tag)?.has(lower) !== true) return;
      if (tag === "img" && lower === "src") {
        const address = value.trim();
        if (!dataImage.test(address) && !(options.network && /^https:/i.test(address))) return;
      }
      if (tag === "input" && lower === "type" && !inputTypes.has(value.toLowerCase())) return;
      // A button never sends a form.
      shown = tag === "button" && lower === "type" ? "button" : value;
      name = lower;
    }
    node.setAttribute(name, shown);
  };

  const setProperty = (node: Node, name: string, value: Json) => {
    if (name === "value" && typeof value === "string") {
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLOptionElement
      ) {
        // The caret stays where it is when the value is what is shown.
        if (node.value !== value) node.value = value;
      }
    } else if (typeof value === "boolean") {
      if (node instanceof HTMLInputElement && (name === "checked" || name === "indeterminate")) {
        node[name] = value;
      } else if (node instanceof HTMLOptionElement && name === "selected") {
        node.selected = value;
      }
    }
  };

  /** Builds a node and all under it; anything not allowed, as an empty comment. */
  const build = (tree: Tree, inSvg: boolean): Node => {
    const id = tree.id as number;
    let node: Node;
    let childrenIn: Element | undefined;
    let svg = inSvg;
    if (count >= nodeLimit) {
      refuse(`A view may draw at most ${String(nodeLimit)} nodes.`);
      node = document.createComment("");
    } else if (typeof tree.text === "string") {
      node = document.createTextNode(tree.text);
    } else if (typeof tree.tag !== "string") {
      node = document.createComment("");
    } else {
      const tag = tree.tag.toLowerCase();
      const spelled = svgElements.get(tag);
      svg = inSvg || tag === "svg";
      if (svg ? spelled === undefined : !htmlElements.has(tag)) {
        node = document.createComment("");
      } else {
        const made = svg
          ? document.createElementNS(svgNamespace, spelled ?? tag)
          : document.createElement(tag);
        node = made;
        if (tag === "style") {
          // Its text is kept apart, and shown only once cleaned.
          const kept = document.createElement("div");
          sheetOf.set(kept, made as HTMLStyleElement);
          childrenIn = kept;
          restyle.add(kept);
        } else {
          childrenIn = made;
        }
        const attrs = Array.isArray(tree.attrs) ? tree.attrs : [];
        for (const pair of attrs) {
          if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
            setAttribute(made, pair[0], pair[1]);
          }
        }
        const props = tree.props;
        if (typeof props === "object" && props !== null && !Array.isArray(props)) {
          for (const [name, value] of Object.entries(props)) setProperty(made, name, value);
        }
      }
    }
    count++;
    nodes.set(id, childrenIn ?? node);
    idOf.set(node, id);
    if (childrenIn !== undefined && childrenIn !== node) idOf.set(childrenIn, id);
    if (Array.isArray(tree.listens)) {
      for (const type of tree.listens) if (typeof type === "string") listen(id, type);
    }
    if (childrenIn !== undefined && Array.isArray(tree.children)) {
      for (const child of tree.children) {
        if (isTree(child)) childrenIn.append(build(child, svg));
      }
    }
    return node;
  };

  /** Forgets a node shown and all under it. */
  const forget = (node: Node) => {
    const id = idOf.get(node);
    if (id !== undefined && nodes.get(id) !== undefined) {
      nodes.delete(id);
      count--;
      for (const type of [...(listensOf.get(id) ?? [])]) unlisten(id, type);
      listensOf.delete(id);
    }
    for (const child of node.childNodes) forget(child);
  };

  /** The node to put on the page for one the worker has: a `style` element, not its kept text. */
  const shownNode = (node: Node): Node => sheetOf.get(node) ?? node;
  /** The `style` element's kept text a node is in, if it is. */
  const keptIn = (node: Node): Node | undefined => {
    const parent = node.parentNode;
    return parent !== null && sheetOf.has(parent) ? parent : undefined;
  };

  const applyOne = (change: readonly unknown[]): void => {
    const [kind, id] = change;
    if (typeof id !== "number") return;
    switch (kind) {
      case "root": {
        rootId = id;
        nodes.set(id, wrapper);
        idOf.set(wrapper, id);
        return;
      }
      case "insert": {
        const [, , index, tree] = change;
        const parent = nodes.get(id);
        if (parent?.nodeType !== 1 || typeof index !== "number" || !isTree(tree)) {
          return;
        }
        const old = nodes.get(tree.id as number);
        // Moved: it is built again where it is now.
        if (old !== undefined && old !== wrapper) {
          shownNode(old).parentNode?.removeChild(shownNode(old));
          forget(old);
        }
        const built = build(tree, parent instanceof SVGElement);
        parent.insertBefore(built, parent.childNodes[index] ?? null);
        if (sheetOf.has(parent)) restyle.add(parent);
        return;
      }
      case "remove": {
        const [, , child] = change;
        if (typeof child !== "number") return;
        const node = nodes.get(child);
        if (node === undefined || node === wrapper) return;
        const shown = shownNode(node);
        const kept = keptIn(shown);
        shown.parentNode?.removeChild(shown);
        forget(node);
        if (kept !== undefined) restyle.add(kept);
        return;
      }
      case "attr": {
        const [, , name, value] = change;
        const node = nodes.get(id);
        if (typeof name !== "string" || (typeof value !== "string" && value !== null)) return;
        const target = node === undefined ? undefined : shownNode(node);
        if (target instanceof Element) setAttribute(target, name, value);
        return;
      }
      case "text": {
        const [, , data] = change;
        const node = nodes.get(id);
        if (typeof data !== "string" || !(node instanceof CharacterData)) return;
        node.data = data;
        const kept = keptIn(node);
        if (kept !== undefined) restyle.add(kept);
        return;
      }
      case "prop": {
        const [, , name, value] = change;
        const node = nodes.get(id);
        if (node !== undefined && typeof name === "string") setProperty(node, name, value as Json);
        return;
      }
      case "listen":
      case "unlisten": {
        const [, , type] = change;
        if (typeof type !== "string" || !nodes.has(id)) return;
        if (kind === "listen") listen(id, type);
        else unlisten(id, type);
        return;
      }
      case "call": {
        const [, , method] = change;
        const node = nodes.get(id);
        if (!(node instanceof HTMLElement || node instanceof SVGElement)) return;
        if (method === "focus") node.focus();
        else if (method === "blur") node.blur();
        return;
      }
      default:
        return;
    }
  };

  return {
    apply(changes) {
      if (!Array.isArray(changes)) return;
      for (const change of changes) if (Array.isArray(change)) applyOne(change);
      for (const kept of restyle) {
        const sheet = sheetOf.get(kept);
        if (sheet !== undefined)
          sheet.textContent = cleanSheet(kept.textContent ?? "", options.network);
      }
      restyle.clear();
    },
    dispose() {
      for (const [type, { listener }] of listeners) {
        shadow.removeEventListener(type, listener, { capture: true });
      }
      listeners.clear();
      resizing?.disconnect();
      pending.clear();
      nodes.clear();
      listensOf.clear();
      shadow.replaceChildren();
    },
  };
}

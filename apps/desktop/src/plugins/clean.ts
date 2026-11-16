// Cleans the HTML a plugin from a vault draws (ADR 0058) before the page
// shows it, in a note and in an exported page: no scripts, event handlers,
// styles, forms or frames, and, unless it was approved for the network,
// no address outside the page, which would carry what it knows out.
import createDOMPurify from "dompurify";

type Purify = ReturnType<typeof createDOMPurify>;

/** The attributes that load or link to an address. */
const addressed = new Set(["src", "href", "xlink:href", "poster", "background", "data", "cite"]);

/** Addresses within the page: fragments, and images as data. */
const local = /^(?:#|data:image\/(?:png|gif|jpe?g|webp|avif|bmp)[;,])/i;
/** With the network, `https:` addresses too. */
const withNetwork = /^(?:#|https:|data:image\/(?:png|gif|jpe?g|webp|avif|bmp)[;,])/i;

/** A value that points at something by `url(…)` that is not in the drawing, as SVG's fill="url(https://…)". */
const outsideUrl = /url\s*\(\s*['"]?\s*(?!#)/i;

let purify: Purify | undefined;
/** Whether the HTML cleaned now may keep `https:` addresses; the hook reads it. */
let networkAllowed = false;

function cleaner(): Purify {
  if (purify !== undefined) return purify;
  const made = createDOMPurify(window);
  // Without a page to clean in, DOMPurify would give back what it was given.
  if (!made.isSupported) throw new Error("HTML cannot be cleaned here.");
  made.addHook("uponSanitizeAttribute", (_node, data) => {
    const value = data.attrValue.trim();
    if (addressed.has(data.attrName) && !(networkAllowed ? withNetwork : local).test(value)) {
      data.keepAttr = false;
    } else if (outsideUrl.test(value)) {
      data.keepAttr = false;
    }
  });
  purify = made;
  return made;
}

export function cleanHtml(html: string, network: boolean): string {
  const made = cleaner();
  networkAllowed = network;
  try {
    return made.sanitize(html, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      FORBID_TAGS: ["style", "form", "iframe", "frame", "object", "embed", "link", "meta", "base"],
      FORBID_ATTR: ["style", "srcset", "action", "formaction", "ping"],
    });
  } finally {
    networkAllowed = false;
  }
}

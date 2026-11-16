// The plugins that come with the app (ADR 0055), which run in the page
// until the sandbox lets others run apart. Nether's own features move here
// as the plugin API grows to hold them. Each is a folder holding its
// manifest, read at startup, and its code, loaded when first used. A
// built-in plugin's version changes with what it does, not with the app's.
// Their order is the order of their panels and slash menu entries.
import assigned from "./assigned/manifest.json";
import backlinks from "./backlinks/manifest.json";
import canvas from "./canvas/manifest.json";
import graph from "./graph/manifest.json";
import layouts from "./layouts/manifest.json";
import type { BuiltinPlugin } from "./host.ts";
import mermaid from "./mermaid/manifest.json";
import outline from "./outline/manifest.json";
import query from "./query/manifest.json";
import tags from "./tags/manifest.json";

export const builtinPlugins: readonly BuiltinPlugin[] = [
  { manifest: mermaid, load: () => import("./mermaid/plugin.ts") },
  { manifest: query, load: () => import("./query/plugin.tsx") },
  { manifest: tags, load: () => import("./tags/plugin.tsx") },
  { manifest: assigned, load: () => import("./assigned/plugin.tsx") },
  { manifest: outline, load: () => import("./outline/plugin.tsx") },
  { manifest: backlinks, load: () => import("./backlinks/plugin.tsx") },
  { manifest: canvas, load: () => import("./canvas/plugin.tsx") },
  { manifest: graph, load: () => import("./graph/plugin.tsx") },
  // Its board, gallery, list, calendar and timeline keep their names in a database's schema.
  { manifest: layouts, load: () => import("./layouts/plugin.tsx"), appLayouts: true },
];

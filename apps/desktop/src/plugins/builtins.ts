// The plugins that come with the app (ADR 0055), which run in the page
// until the sandbox lets others run apart. Nether's own features move here
// as the plugin API grows to hold them. Each is a folder holding its
// manifest, read at startup, and its code, loaded when first used. A
// built-in plugin's version changes with what it does, not with the app's.
import type { BuiltinPlugin } from "./host.ts";
import mermaid from "./mermaid/manifest.json";
import query from "./query/manifest.json";

export const builtinPlugins: readonly BuiltinPlugin[] = [
  { manifest: mermaid, load: () => import("./mermaid/plugin.ts") },
  { manifest: query, load: () => import("./query/plugin.tsx") },
];

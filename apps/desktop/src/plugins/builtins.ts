// The plugins that come with the app (ADR 0055), which run in the page
// until the sandbox lets others run apart. Nether's own features move here
// as the plugin API grows to hold them.
import type { BuiltinPlugin } from "./host.ts";

export const builtinPlugins: readonly BuiltinPlugin[] = [];

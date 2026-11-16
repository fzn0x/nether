// Query blocks (ADR 0021): below a `base` code block's code, the notes its
// query finds, found again as the vault changes. The notes show in a live
// view, which only the host can give, so this is a built-in plugin's
// work; an exported page shows the block's code.
import { QueryView } from "../../QueryView.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.codeBlocks.view("base", ({ source, vault, media, graph, openNote }) => (
      <QueryView source={source} vault={vault} media={media} graph={graph} onOpen={openNote} />
    ));
  },
};

export default plugin;

// The Tags panel, among the sidebar's tabs: the vault's tags, each showing
// the notes with it. A built-in plugin, through the host's live view.
import { TagList } from "../../TagList.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.panels.view("tags", ({ graph, openTag }) => (
      <TagList graph={graph} onSelect={openTag} />
    ));
  },
};

export default plugin;

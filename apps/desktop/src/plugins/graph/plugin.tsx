// The graph, a view of its own in the pane: the vault's notes and the
// links between them, all of them or those around the note open. A
// built-in plugin, through the host's live view.
import GraphView from "../../GraphView.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.views.view("graph", ({ vault, graph, note, openNote, close }) => (
      <GraphView
        vault={vault}
        graph={graph}
        note={note}
        onOpenNote={(id) => {
          openNote(id);
        }}
        onClose={close}
      />
    ));
  },
};

export default plugin;

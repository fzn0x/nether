// The Assigned panel, among the sidebar's tabs: the rows and notes whose
// person properties name the name this device goes by. A built-in plugin,
// through the host's live view.
import { AssignedPanel } from "../../AssignedPanel.tsx";
import { useNotes } from "../../useVault.ts";
import type { BuiltinModule } from "../host.ts";
import type { PanelViewProps } from "../panels.ts";

function Assigned(props: PanelViewProps) {
  const { vault, graph, openNote, askMyName } = props;
  const notes = useNotes(vault);
  return (
    <AssignedPanel
      vault={vault}
      graph={graph}
      notes={notes}
      onOpen={(id) => {
        openNote(id);
      }}
      onSetName={() => {
        askMyName?.();
      }}
    />
  );
}

const plugin: BuiltinModule = {
  activate(context) {
    context.host.panels.view("assigned", Assigned);
  },
};

export default plugin;

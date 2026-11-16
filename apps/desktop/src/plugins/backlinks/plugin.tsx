// Backlinks, beside a note: the notes that link to it, with the text
// around each link, and, folded until opened, the notes that mention it
// without a link. A built-in plugin, through the host's live views.
import { BacklinksPanel } from "../../BacklinksPanel.tsx";
import { UnlinkedMentions } from "../../UnlinkedMentions.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.panels.view("linked", ({ vault, graph, note, openNote }) =>
      note === undefined ? null : (
        <BacklinksPanel
          vault={vault}
          graph={graph}
          id={note}
          onOpenNote={(id) => {
            openNote(id);
          }}
        />
      ),
    );
    context.host.panels.view("unlinked", ({ vault, graph, note, openNote }) =>
      note === undefined ? null : (
        <UnlinkedMentions
          vault={vault}
          graph={graph}
          id={note}
          onOpenNote={(id) => {
            openNote(id);
          }}
        />
      ),
    );
  },
};

export default plugin;

// Backlinks, beside a note: the notes that link to it, with the text
// around each link unless its settings say otherwise, and, folded until
// opened, the notes that mention it without a link. A built-in plugin,
// through the host's live views.
import type { JsonObject, Settings } from "@nether/plugin-api";
import { useSyncExternalStore } from "react";
import { BacklinksPanel } from "../../BacklinksPanel.tsx";
import { UnlinkedMentions } from "../../UnlinkedMentions.tsx";
import type { BuiltinModule } from "../host.ts";
import type { PanelViewProps } from "../panels.ts";

/** The plugin's settings, for React to follow. */
function settingsStore(settings: Settings) {
  return {
    subscribe: (listener: () => void) => {
      const watching = settings.onChange(listener);
      return () => {
        void watching.dispose();
      };
    },
    values: (): JsonObject => settings.values(),
  };
}

const plugin: BuiltinModule = {
  activate(context) {
    const store = settingsStore(context.settings);
    function Linked({ vault, graph, note, openNote }: PanelViewProps) {
      const values = useSyncExternalStore(store.subscribe, store.values);
      return note === undefined ? null : (
        <BacklinksPanel
          vault={vault}
          graph={graph}
          id={note}
          withContext={values.context !== false}
          onOpenNote={(id) => {
            openNote(id);
          }}
        />
      );
    }
    context.host.panels.view("linked", Linked);
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

// The Outline panel, beside a note: its headings, each opening the note
// there. A built-in plugin, through the host's live view.
import { OutlinePanel } from "../../OutlinePanel.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.panels.view("outline", ({ graph, note, openNote }) =>
      note === undefined ? null : <OutlinePanel graph={graph} id={note} onOpenNote={openNote} />,
    );
  },
};

export default plugin;

// The canvas (ADR 0051), the view of `.canvas` files: an infinite
// whiteboard of notes, text, images, links and arrows, in the open JSON
// Canvas format. A built-in plugin, through the host's live view.
import CanvasView from "../../CanvasView.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.views.view("canvas", ({ vault, graph, media, path, openNote }) =>
      path === undefined ? null : (
        <CanvasView
          key={path}
          vault={vault}
          graph={graph}
          media={media}
          path={path}
          // A note opened from a canvas opens beside it, keeping the canvas open.
          onOpenNote={(note) => {
            openNote(note, undefined, "tab");
          }}
        />
      ),
    );
  },
};

export default plugin;

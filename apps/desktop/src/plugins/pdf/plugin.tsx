// PDFs (ADR 0061), the view of `.pdf` files: their pages drawn by pdf.js,
// and their highlights, callouts in a note that link to their passage.
// A built-in plugin, through the host's live view; pdf.js loads with it,
// when a PDF first opens.
import PdfView from "../../PdfView.tsx";
import type { BuiltinModule } from "../host.ts";

const plugin: BuiltinModule = {
  activate(context) {
    context.host.views.view("pdf", ({ vault, graph, path, at, linksLoaded, openNote }) =>
      path === undefined ? null : (
        <PdfView
          key={path}
          vault={vault}
          graph={graph}
          path={path}
          at={at}
          linksLoaded={linksLoaded}
          // A note opened from a PDF opens beside it, keeping the PDF open.
          onOpenNote={(note, part) => {
            openNote(note, part, "tab");
          }}
        />
      ),
    );
  },
};

export default plugin;

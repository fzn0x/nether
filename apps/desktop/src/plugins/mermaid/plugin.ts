// Mermaid diagrams, drawn from a `mermaid` code block's text as SVG: below
// its code in a note, and in its place in an exported page. It uses only
// the SDK, as a plugin from a folder will. Mermaid loads with this plugin,
// when the first diagram is drawn.
import { definePlugin } from "@nether/plugin-api";
import mermaid from "mermaid";

let drawn = 0;

export default definePlugin({
  async activate(context) {
    await context.codeBlocks.register("mermaid", async (source, block) => {
      mermaid.initialize({
        startOnLoad: false,
        // Diagrams cannot run scripts, follow clicks or load content.
        securityLevel: "strict",
        suppressErrorRendering: true,
        // Mermaid's default is the ELK layout, which Nether does not
        // include (ADR 0009); dagre lays out the same diagrams.
        layout: "dagre",
        theme: block.theme === "dark" ? "dark" : "default",
      });
      const id = `mermaid-${String(++drawn)}`;
      try {
        await mermaid.parse(source);
        return { html: (await mermaid.render(id, source)).svg };
      } catch (error) {
        // What Mermaid leaves in the page when it cannot draw.
        document.getElementById(`d${id}`)?.remove();
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  },
});

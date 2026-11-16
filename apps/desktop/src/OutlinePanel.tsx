// A note's outline, beside it: its headings, each opening the note there,
// read from the link index, so it follows as the note changes.
import type { NoteId } from "@nether/core";
import type { LinkGraph } from "@nether/graph";
import { useMemo } from "react";
import { t } from "./messages.ts";
import type { NotePart } from "./noteLinks.ts";
import { useGraph } from "./useGraph.ts";

export function OutlinePanel(props: {
  readonly graph: LinkGraph;
  readonly id: NoteId;
  readonly onOpenNote: (id: NoteId, part?: NotePart) => void;
}) {
  const { graph, id, onOpenNote } = props;
  const version = useGraph(graph);
  const headings = useMemo(() => graph.note(id)?.index.headings ?? [], [graph, id, version]);
  if (headings.length === 0) return <p className="placeholder">{t("noHeadings")}</p>;
  return (
    <ul className="outline">
      {headings.map((heading, index) => (
        <li
          key={`${String(index)}-${heading.text}`}
          style={{ paddingInlineStart: `${String(heading.level - 1)}rem` }}
        >
          <button
            type="button"
            onClick={() => {
              onOpenNote(id, { heading: heading.text });
            }}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

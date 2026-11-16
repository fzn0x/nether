// A note's backlinks, beside it: the notes that link to it, each with the
// text around its links, read from the link index, so they follow as notes
// change.
import type { NoteId } from "@nether/core";
import type { Backlink, LinkGraph, NoteIndex } from "@nether/graph";
import type { Vault } from "@nether/storage";
import { useEffect, useMemo, useState } from "react";
import { readIndexRow } from "./indexer.ts";
import { t } from "./messages.ts";
import { useGraph } from "./useGraph.ts";

/** How many linking notes' text the backlinks panel reads, the rest shown by name. */
const contextLimit = 100;

/**
 * The text around the links from each note that links to one, read from
 * the vault's index, which keeps it while the graph does not.
 */
function useBacklinkContexts(
  vault: Vault,
  graph: LinkGraph,
  id: NoteId,
  backlinks: readonly Backlink[],
): ReadonlyMap<NoteId, readonly string[]> {
  const [contexts, setContexts] = useState<ReadonlyMap<NoteId, readonly string[]>>(new Map());
  useEffect(() => {
    let current = true;
    const sources = backlinks.slice(0, contextLimit).map((backlink) => backlink.source);
    void vault.indexes.noteIndexesOf(sources).then((rows) => {
      if (!current) return;
      const found = new Map<NoteId, readonly string[]>();
      for (const row of rows) {
        const path = graph.note(row.note)?.path;
        if (path === undefined) continue;
        let index: NoteIndex;
        try {
          index = readIndexRow(row);
        } catch {
          continue;
        }
        const texts = index.links
          .filter((link) => link.target !== "" && graph.resolve(link.target, path) === id)
          .map((link) => link.context)
          .filter((context) => context !== "");
        found.set(row.note, [...new Set(texts)]);
      }
      setContexts(found);
    });
    return () => {
      current = false;
    };
  }, [vault, graph, id, backlinks]);
  return contexts;
}

export function BacklinksPanel(props: {
  readonly vault: Vault;
  readonly graph: LinkGraph;
  readonly id: NoteId;
  readonly onOpenNote: (id: NoteId) => void;
}) {
  const { vault, graph, id, onOpenNote } = props;
  const version = useGraph(graph);
  const backlinks = useMemo(() => graph.backlinks(id), [graph, id, version]);
  const contextsOf = useBacklinkContexts(vault, graph, id, backlinks);
  if (backlinks.length === 0) return <p className="placeholder">{t("noBacklinks")}</p>;
  return (
    <ul className="backlinks">
      {backlinks.map((backlink) => {
        const source = graph.note(backlink.source);
        const contexts = contextsOf.get(backlink.source) ?? [];
        return (
          <li key={backlink.source}>
            <button
              type="button"
              onClick={() => {
                onOpenNote(backlink.source);
              }}
            >
              {source?.title ?? ""}
            </button>
            {contexts.map((context) => (
              <p key={context} className="backlink-context">
                {context}
              </p>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

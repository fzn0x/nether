// The vault's tags in the sidebar: nested ones under theirs, with how many
// notes have each; choosing one shows the notes with it.
import type { LinkGraph } from "@nether/graph";
import { useMemo } from "react";
import { t } from "./messages.ts";
import { useGraph } from "./useGraph.ts";

const numbers = new Intl.NumberFormat();

/** The vault's tags, nested ones under theirs, with how many notes have each. */
export function TagList(props: {
  readonly graph: LinkGraph;
  readonly onSelect: (tag: string) => void;
}) {
  const { graph, onSelect } = props;
  const version = useGraph(graph);
  const tags = useMemo(() => graph.tags(), [graph, version]);
  if (tags.length === 0) return <p className="placeholder">{t("noTags")}</p>;
  return (
    <ul className="tag-list" aria-label={t("tags")}>
      {tags.map(({ tag, count }) => {
        const depth = tag.split("/").length - 1;
        return (
          <li key={tag.toLowerCase()} style={{ paddingInlineStart: `${String(depth)}rem` }}>
            <button
              type="button"
              onClick={() => {
                onSelect(tag);
              }}
            >
              <span className="tag-name">
                #{depth === 0 ? tag : tag.slice(tag.lastIndexOf("/") + 1)}
              </span>
              <span className="tag-count">{numbers.format(count)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

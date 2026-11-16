// A plugin's block in a note open in the app (ADR 0055): its plugin's view,
// mounted in an element of its own, given what the block holds and told
// again as that changes. What the view changes the block to is an edit of
// the note. A plugin's code loads with the first of its blocks shown.
import type { BlockViewProps, JsonObject } from "@nether/plugin-api";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { shownDark } from "./CodeOutput.tsx";
import { t } from "./messages.ts";
import { PluginMount } from "./PluginMount.tsx";
import type { BlockProcessor, BlockRegistry } from "./plugins/blocks.ts";

interface Props {
  readonly blocks: BlockRegistry;
  /** As the note's file names it, `plugin-id/type`. */
  readonly type: string;
  readonly attrs: JsonObject;
  readonly editable: boolean;
  readonly onChange: (attrs: JsonObject) => void;
}

/** A plugin's block, as its plugin shows it; its type, when no plugin here does. */
export function PluginBlockOutput(props: Props) {
  const { blocks, type } = props;
  const processor = useSyncExternalStore(
    useCallback((listener: () => void) => blocks.subscribe(listener), [blocks]),
    () => blocks.get(type),
  );
  if (processor === undefined) {
    return (
      <p className="plugin-missing" contentEditable={false}>
        {t("pluginBlockMissing")} <code>{type}</code>
      </p>
    );
  }
  return <Mounted key={processor.plugin} {...props} processor={processor} />;
}

function Mounted(props: Props & { readonly processor: BlockProcessor }) {
  const { processor, attrs, editable, onChange } = props;
  // What the view shows: a new object only when what the block holds changes.
  const held = JSON.stringify(attrs);
  const viewProps = useMemo(
    (): BlockViewProps => ({
      attrs: JSON.parse(held) as JsonObject,
      editable,
      theme: shownDark() ? "dark" : "light",
    }),
    [held, editable],
  );
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  const start = useCallback(
    async (element: HTMLElement, first: BlockViewProps) => {
      const drawing = await processor.load();
      return drawing.mount(element, first, (next) => {
        changed.current(next);
      });
    },
    [processor],
  );
  return (
    <PluginMount
      start={start}
      viewProps={viewProps}
      className="plugin-view"
      plugin={processor.plugin}
    />
  );
}

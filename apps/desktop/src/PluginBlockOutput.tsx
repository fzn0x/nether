// A plugin's block in a note open in the app (ADR 0055): its plugin's view,
// mounted in an element of its own, given what the block holds and told
// again as that changes. What the view changes the block to is an edit of
// the note. A plugin's code loads with the first of its blocks shown.
import type { BlockViewProps, JsonObject } from "@nether/plugin-api";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Failed, errorText, shownDark } from "./CodeOutput.tsx";
import { t } from "./messages.ts";
import type { BlockProcessor, BlockRegistry, MountedBlock } from "./plugins/blocks.ts";

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
  const element = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedBlock | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>();
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
  // The latest, for a view that mounts after they change.
  const latest = useRef(viewProps);
  const changed = useRef(onChange);
  useEffect(() => {
    latest.current = viewProps;
    changed.current = onChange;
  }, [viewProps, onChange]);

  useEffect(() => {
    const into = element.current;
    if (into === null) return;
    let live = true;
    let handle: MountedBlock | undefined;
    const first = latest.current;
    processor
      .load()
      .then((drawing) =>
        drawing.mount(into, first, (next) => {
          changed.current(next);
        }),
      )
      .then(async (view) => {
        if (!live) {
          view.unmount();
          return;
        }
        handle = view;
        mounted.current = view;
        if (latest.current !== first) await view.update(latest.current);
      })
      .catch((error: unknown) => {
        if (live) setFailure(errorText(error));
      });
    return () => {
      live = false;
      handle?.unmount();
      mounted.current = undefined;
    };
  }, [processor]);

  useEffect(() => {
    mounted.current?.update(viewProps).catch((error: unknown) => {
      setFailure(errorText(error));
    });
  }, [viewProps]);

  return (
    <div className="plugin-view" data-plugin={processor.plugin} contentEditable={false}>
      {failure === undefined ? null : <Failed message={failure} />}
      <div ref={element} />
    </div>
  );
}

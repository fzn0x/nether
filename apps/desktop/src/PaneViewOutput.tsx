// A plugin's view filling a pane (ADR 0055): of a file opened in a tab, as
// the canvas is of `.canvas` files, or of its own, as the graph is. A
// built-in plugin's live view, or a view mounted in an element of its own.
import type { PaneViewProps } from "@nether/plugin-api";
import { type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Failed, errorText, shownDark } from "./CodeOutput.tsx";
import { PluginMount } from "./PluginMount.tsx";
import type { PaneViewDrawing, PaneViewHostProps, ViewProcessor } from "./plugins/views.ts";

export function PaneViewOutput(props: {
  readonly processor: ViewProcessor;
  readonly viewProps: PaneViewHostProps;
  /** Shown while the plugin's code loads. */
  readonly loading?: ReactNode;
}) {
  const { processor, viewProps, loading = null } = props;
  const [drawing, setDrawing] = useState<PaneViewDrawing | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  useEffect(() => {
    let current = true;
    processor.load().then(
      (loaded) => {
        if (current) setDrawing(loaded);
      },
      (error: unknown) => {
        if (current) setFailure(errorText(error));
      },
    );
    return () => {
      current = false;
    };
  }, [processor]);

  if (failure !== undefined) return <Failed message={failure} />;
  if (drawing === undefined) return loading;
  const View = drawing.view;
  if (View !== undefined) {
    return (
      <Suspense fallback={loading}>
        <View {...viewProps} />
      </Suspense>
    );
  }
  return drawing.mount === undefined ? null : (
    <MountedPaneView mount={drawing.mount} path={viewProps.path} plugin={processor.plugin} />
  );
}

function MountedPaneView(props: {
  readonly mount: NonNullable<PaneViewDrawing["mount"]>;
  readonly path: string | undefined;
  readonly plugin: string;
}) {
  const { mount, path, plugin } = props;
  const paneProps = useMemo(
    (): PaneViewProps => ({
      theme: shownDark() ? "dark" : "light",
      ...(path === undefined ? {} : { file: { path } }),
    }),
    [path],
  );
  const start = useCallback(
    (element: HTMLElement, first: PaneViewProps) => mount(element, first),
    [mount],
  );
  return <PluginMount start={start} viewProps={paneProps} className="pane-view" plugin={plugin} />;
}

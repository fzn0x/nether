// A database's view in a plugin's layout (ADR 0056): a built-in plugin's
// live view, as the board is, or a plugin's view mounted in an element of
// its own, given the rows as JSON and changing them through the app.
import type { LayoutProps } from "@nether/plugin-api";
import { rowTitle } from "@nether/database";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Failed, errorText, shownDark } from "./CodeOutput.tsx";
import { PluginMount } from "./PluginMount.tsx";
import type {
  LayoutActions,
  LayoutDrawing,
  LayoutHostProps,
  LayoutProcessor,
} from "./plugins/layouts.ts";

export function LayoutOutput(props: {
  readonly processor: LayoutProcessor;
  readonly hostProps: LayoutHostProps;
  readonly actions: LayoutActions;
}) {
  const { processor, hostProps, actions } = props;
  const [drawing, setDrawing] = useState<LayoutDrawing | undefined>();
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
  const View = drawing?.view;
  if (View !== undefined) {
    return (
      <Suspense fallback={null}>
        <View {...hostProps} />
      </Suspense>
    );
  }
  return drawing?.mount === undefined ? null : (
    <MountedLayoutView
      mount={drawing.mount}
      hostProps={hostProps}
      actions={actions}
      plugin={processor.plugin}
    />
  );
}

/** A plugin's view of the rows, given them as JSON, a new object only when they change. */
function MountedLayoutView(props: {
  readonly mount: NonNullable<LayoutDrawing["mount"]>;
  readonly hostProps: LayoutHostProps;
  readonly actions: LayoutActions;
  readonly plugin: string;
}) {
  const { mount, hostProps, plugin } = props;
  const { view, rows, groups, visible } = hostProps;
  const shown: LayoutProps = {
    view: { name: view.name, options: view.options ?? {} },
    rows: rows.map((row) => ({
      id: row.id,
      title: rowTitle(row),
      values: Object.fromEntries(
        row.properties
          .filter((entry) => visible.some((property) => property.key === entry.key))
          .map((entry) => [entry.key, entry.value]),
      ),
    })),
    ...(groups === undefined
      ? {}
      : {
          groups: groups.map((group) => ({
            value: group.value,
            rows: group.rows.map((row) => row.id),
          })),
        }),
    properties: visible.map((property) => ({
      key: property.key,
      name: property.key,
      type: property.type,
    })),
    editable: true,
    theme: shownDark() ? "dark" : "light",
  };
  const held = JSON.stringify(shown);
  const layoutProps = useMemo(() => JSON.parse(held) as LayoutProps, [held]);
  const latest = useRef(props.actions);
  useEffect(() => {
    latest.current = props.actions;
  }, [props.actions]);
  const start = useCallback(
    (element: HTMLElement, first: LayoutProps) =>
      mount(element, first, {
        openRow: (row) => {
          latest.current.openRow(row);
        },
        setValue: (row, key, value) => {
          latest.current.setValue(row, key, value);
        },
        setOptions: (options) => {
          latest.current.setOptions(options);
        },
      }),
    [mount],
  );
  return (
    <PluginMount start={start} viewProps={layoutProps} className="layout-view" plugin={plugin} />
  );
}

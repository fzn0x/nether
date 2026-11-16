// A plugin's panel (ADR 0055): among the sidebar's tabs, or beside the note
// open. The app gives it its name and its landmark, and a heading beside a
// note, which opens a folded panel; the plugin's view fills it, a built-in
// plugin's live view or a view mounted in an element of its own.
import type { PanelProps } from "@nether/plugin-api";
import { Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Failed, errorText, shownDark } from "./CodeOutput.tsx";
import { PluginMount } from "./PluginMount.tsx";
import type { PanelDrawing, PanelProcessor, PanelViewProps } from "./plugins/panels.ts";

interface Props {
  readonly processor: PanelProcessor;
  readonly viewProps: PanelViewProps;
}

/** What fills a panel, once its plugin's code has loaded. */
function PanelOutput(props: Props) {
  const { processor, viewProps } = props;
  const [drawing, setDrawing] = useState<PanelDrawing | undefined>();
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
        <View {...viewProps} />
      </Suspense>
    );
  }
  const mount = drawing?.mount;
  return mount === undefined ? null : (
    <MountedPanel mount={mount} viewProps={viewProps} plugin={processor.plugin} />
  );
}

/** A plugin's view mounted in a panel, told of the note it is beside. */
function MountedPanel(props: {
  readonly mount: NonNullable<PanelDrawing["mount"]>;
  readonly viewProps: PanelViewProps;
  readonly plugin: string;
}) {
  const { mount, viewProps, plugin } = props;
  const note = viewProps.note === undefined ? undefined : viewProps.vault.note(viewProps.note);
  const { id, title, path } = note ?? {};
  const panelProps = useMemo(
    (): PanelProps => ({
      theme: shownDark() ? "dark" : "light",
      ...(id === undefined || title === undefined || path === undefined
        ? {}
        : { note: { id, title, path } }),
    }),
    [id, title, path],
  );
  const start = useCallback(
    (element: HTMLElement, first: PanelProps) => mount(element, first),
    [mount],
  );
  return (
    <PluginMount start={start} viewProps={panelProps} className="panel-view" plugin={plugin} />
  );
}

/** A plugin's panel as one of the sidebar's tabs shows it. */
export function SidebarPanel(props: Props) {
  const { processor } = props;
  return (
    <section className="plugin-panel" aria-label={processor.name()}>
      <PanelOutput {...props} />
    </section>
  );
}

/** A plugin's panel beside the note, under its heading; a folded one fills only once opened. */
export function NotePanelSection(props: Props) {
  const { processor } = props;
  const heading = useId();
  const [open, setOpen] = useState(!processor.folded);
  const name = processor.name();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>
        {processor.folded ? (
          <button
            type="button"
            className="panel-disclosure"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {name}
          </button>
        ) : (
          name
        )}
      </h2>
      {open ? <PanelOutput {...props} /> : null}
    </section>
  );
}

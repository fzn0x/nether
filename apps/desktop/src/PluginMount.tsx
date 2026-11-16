// A plugin's view, mounted in an element of its own (ADR 0055): given its
// props when it mounts, told again as they change, and unmounted when it
// leaves the page. A view that mounts after its props changed is given
// the latest; one that fails shows why.
import { useEffect, useRef, useState } from "react";
import { Failed, errorText } from "./CodeOutput.tsx";

/** A view mounted, which the app updates and unmounts. */
export interface MountedHandle<P> {
  update(props: P): Promise<void>;
  unmount(): void;
}

/**
 * Mounts a view with `start`, which loads its plugin; a new `start` mounts
 * it afresh. `viewProps` is a new object only when the view should hear of
 * a change.
 */
export function PluginMount<P>(props: {
  readonly start: (element: HTMLElement, props: P) => Promise<MountedHandle<P>>;
  readonly viewProps: P;
  readonly className: string;
  readonly plugin: string;
}) {
  const { start, viewProps, className, plugin } = props;
  const element = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedHandle<P> | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>();
  // The latest, for a view that mounts after they change.
  const latest = useRef(viewProps);
  useEffect(() => {
    latest.current = viewProps;
  }, [viewProps]);

  useEffect(() => {
    const into = element.current;
    if (into === null) return;
    let live = true;
    let handle: MountedHandle<P> | undefined;
    const first = latest.current;
    start(into, first)
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
  }, [start]);

  useEffect(() => {
    mounted.current?.update(viewProps).catch((error: unknown) => {
      setFailure(errorText(error));
    });
  }, [viewProps]);

  return (
    <div className={className} data-plugin={plugin} contentEditable={false}>
      {failure === undefined ? null : <Failed message={failure} />}
      <div ref={element} />
    </div>
  );
}

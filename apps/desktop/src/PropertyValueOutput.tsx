// A property's value in its plugin's view (ADR 0057), in a note's
// properties or a database's cell: given the value, and told again as it
// changes. What the view sets is checked as the app's type the plugin's
// type stores as before it is written.
import { type JsonValue, checkPropertyValue } from "@nether/core";
import type { PropertyViewProps } from "@nether/plugin-api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, shownDark } from "./CodeOutput.tsx";
import { PluginMount } from "./PluginMount.tsx";
import type { PropertyTypeProcessor } from "./plugins/propertyTypes.ts";

export function PropertyValueOutput(props: {
  readonly processor: PropertyTypeProcessor;
  readonly propertyKey: string;
  readonly value: JsonValue;
  readonly editable: boolean;
  readonly onChange: (value: JsonValue) => void;
}) {
  const { processor, propertyKey, value, editable, onChange } = props;
  const [refused, setRefused] = useState<string | undefined>();
  const held = JSON.stringify(value);
  const viewProps = useMemo(
    (): PropertyViewProps => ({
      key: propertyKey,
      value: JSON.parse(held) as JsonValue,
      editable,
      theme: shownDark() ? "dark" : "light",
    }),
    [propertyKey, held, editable],
  );
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  const start = useCallback(
    async (element: HTMLElement, first: PropertyViewProps) => {
      const drawing = await processor.load();
      return drawing.mount(element, first, (next) => {
        try {
          checkPropertyValue(processor.stores, next, propertyKey);
        } catch (problem) {
          setRefused(errorText(problem));
          return;
        }
        setRefused(undefined);
        changed.current(next);
      });
    },
    [processor, propertyKey],
  );
  return (
    <>
      <PluginMount
        start={start}
        viewProps={viewProps}
        className="property-view"
        plugin={processor.plugin}
      />
      {refused === undefined ? null : (
        <span className="database-error" role="alert">
          {refused}
        </span>
      )}
    </>
  );
}

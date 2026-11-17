// A database's triggers in its settings (ADR 0072): each rule as a
// sentence, "When status becomes Done, set completed to {{date}}", which
// can be removed, and a form that adds one. A rule with the same property
// and value as one there sets its property beside the others. Values are
// read by the property's type: a checkbox's as true or false, a number's
// as a number, and nothing as none.
import type { JsonValue, PropertyDefinition, PropertyType, Trigger } from "@nether/core";
import { useId, useState } from "react";
import { t } from "./messages.ts";

/** The types a trigger cannot watch or set: worked out from others, never written. */
const workedOut: readonly PropertyType[] = ["formula", "rollup"];

/** What a value typed for a property of `type` is: none when empty. */
export function typedValue(type: PropertyType | undefined, text: string): JsonValue {
  const value = text.trim();
  if (value === "") return null;
  if (type === "checkbox" && (value === "true" || value === "false")) return value === "true";
  if (type === "number" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/** A value as a trigger's sentence writes it. */
export function valueText(value: JsonValue): string {
  if (value === null) return t("triggerEmpty");
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A trigger as a sentence. */
export function triggerText(trigger: Trigger): string {
  const set = Object.entries(trigger.set)
    .map(([key, value]) => t("triggerSets", { key, value: valueText(value) }))
    .join(", ");
  return t("triggerText", { when: trigger.when, is: valueText(trigger.is), set });
}

/** The triggers with a new rule: beside one of the same property and value, or last. */
export function withTrigger(
  triggers: readonly Trigger[],
  when: string,
  is: JsonValue,
  key: string,
  value: JsonValue,
): Trigger[] {
  const same = (trigger: Trigger) =>
    trigger.when === when && JSON.stringify(trigger.is) === JSON.stringify(is);
  if (!triggers.some(same)) return [...triggers, { when, is, set: { [key]: value } }];
  return triggers.map((trigger) =>
    same(trigger) ? { ...trigger, set: { ...trigger.set, [key]: value } } : trigger,
  );
}

export function DatabaseTriggers(props: {
  readonly properties: readonly PropertyDefinition[];
  readonly triggers: readonly Trigger[];
  /** Whether a plugin runs them: the Buttons and triggers plugin is on. */
  readonly running: boolean;
  readonly onChange: (triggers: readonly Trigger[]) => void;
}) {
  const { properties, triggers, running, onChange } = props;
  const written = properties.filter((property) => !workedOut.includes(property.type));
  const [chosenWhen, setWhen] = useState<string | undefined>();
  const [is, setIs] = useState("");
  const [chosenSet, setSet] = useState<string | undefined>();
  // Untouched, a date is set to the day the rule fires, and anything else to none.
  const [typed, setTyped] = useState<string | undefined>();
  const options = useId();
  // The first there is until one is chosen: the properties change as the schema does.
  const when = written.find((property) => property.key === chosenWhen) ?? written[0];
  const sets = written.find((property) => property.key === chosenSet) ?? written[1] ?? when;
  const choices = when?.options?.map((option) => option.name) ?? [];
  const value = typed ?? (sets?.type === "date" ? "{{date}}" : "");

  return (
    <div className="database-triggers" role="group" aria-label={t("triggers")}>
      {running ? null : <p className="hint">{t("triggersOff")}</p>}
      {triggers.length === 0 ? (
        <p className="hint">{t("triggersNone")}</p>
      ) : (
        <ul>
          {triggers.map((trigger, index) => {
            const text = triggerText(trigger);
            return (
              <li key={`${String(index)} ${text}`}>
                <span>{text}</span>
                <button
                  type="button"
                  className="quiet"
                  aria-label={t("triggerRemove", { trigger: text })}
                  onClick={() => {
                    onChange(triggers.filter((_, at) => at !== index));
                  }}
                >
                  {t("triggerRemoveButton")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {when === undefined || sets === undefined ? (
        <p className="hint">{t("triggerNeedsProperty")}</p>
      ) : (
        <form
          className="database-add-trigger"
          aria-label={t("triggerNew")}
          onSubmit={(event) => {
            event.preventDefault();
            onChange(
              withTrigger(
                triggers,
                when.key,
                typedValue(when.type, is),
                sets.key,
                typedValue(sets.type, value),
              ),
            );
            setIs("");
            setTyped(undefined);
          }}
        >
          <label>
            {t("triggerWhen")}
            <select
              value={when.key}
              onChange={(event) => {
                setWhen(event.target.value);
              }}
            >
              {written.map((property) => (
                <option key={property.key} value={property.key}>
                  {property.key}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("triggerBecomes")}
            <input
              value={is}
              list={choices.length === 0 ? undefined : options}
              placeholder={t("triggerEmpty")}
              onChange={(event) => {
                setIs(event.target.value);
              }}
            />
          </label>
          {choices.length === 0 ? null : (
            <datalist id={options}>
              {choices.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          <label>
            {t("triggerSet")}
            <select
              value={sets.key}
              onChange={(event) => {
                setSet(event.target.value);
                setTyped(undefined);
              }}
            >
              {written.map((property) => (
                <option key={property.key} value={property.key}>
                  {property.key}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("triggerTo")}
            <input
              value={value}
              placeholder={t("triggerEmpty")}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </label>
          <button type="submit" className="quiet">
            {t("triggerAdd")}
          </button>
        </form>
      )}
    </div>
  );
}

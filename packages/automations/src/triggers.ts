// Triggers (ADR 0072): a database's rules, which set a row's properties
// when one of them becomes a value. What a change fires, and the values it
// sets, their template variables filled; the app writes them, and runs no
// triggers for what they set.
import { type JsonObject, type JsonValue, type Trigger, fillTemplate } from "@nether/core";

/** A change of one property of a row, as the app made it. */
export interface PropertyChange {
  readonly key: string;
  /** Its value before; undefined when the row had none. */
  readonly before: JsonValue | undefined;
  /** Its value after; undefined when the row has none now. */
  readonly after: JsonValue | undefined;
}

function same(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function empty(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Whether a property's value is a trigger's: the same, one of a list's, or none for null. */
export function holds(value: JsonValue | undefined, is: JsonValue): boolean {
  if (is === null) return empty(value);
  if (value === undefined) return false;
  if (same(value, is)) return true;
  if (!Array.isArray(value) || Array.isArray(is)) return false;
  const items: readonly JsonValue[] = value;
  return items.some((item) => same(item, is));
}

/** Whether a change fires a trigger: its property became the trigger's value, from another. */
export function fires(trigger: Trigger, change: PropertyChange): boolean {
  return (
    trigger.when === change.key &&
    holds(change.after, trigger.is) &&
    !holds(change.before, trigger.is)
  );
}

/** What fills a value's template variables: the row's name, and when the change was made. */
export interface TriggerValues {
  readonly title: string;
  readonly now: Date;
}

/**
 * A value with its template variables filled, as a template's are: with no
 * format, `{{date}}` as a date property stores one, `YYYY-MM-DD`, and
 * `{{time}}` as `HH:mm`.
 */
function filled(value: JsonValue, values: TriggerValues): JsonValue {
  if (typeof value === "string") {
    return fillTemplate(value, { title: values.title, date: values.now, now: values.now });
  }
  if (!Array.isArray(value)) return value;
  const items: readonly JsonValue[] = value;
  return items.map((item) => filled(item, values));
}

/**
 * What a change sets: the values of each trigger it fires, in order, a
 * later one's winning for a property two set; none when none fires.
 */
export function firedValues(
  triggers: readonly Trigger[],
  change: PropertyChange,
  values: TriggerValues,
): JsonObject {
  const set: Record<string, JsonValue> = {};
  for (const trigger of triggers) {
    if (!fires(trigger, change)) continue;
    for (const [key, value] of Object.entries(trigger.set)) set[key] = filled(value, values);
  }
  return set;
}

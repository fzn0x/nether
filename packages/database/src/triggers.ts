// A database's rules as its properties change (ADR 0072): a property
// renamed is renamed in every rule that names it, and a property deleted is
// dropped from what each rule sets, with a rule on it, or left setting
// nothing. Rules kept and not run follow too, as far as they can be read.
import type { DatabaseSchema, JsonObject, JsonValue, SkippedTrigger, Trigger } from "@nether/core";

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A rule's `when` and `set` changed by `change`, or the rule as it is when it has neither. */
function changedRule(
  rule: JsonValue,
  change: (when: string, set: JsonObject) => { when: string; set: JsonObject } | undefined,
): JsonValue | undefined {
  if (!isObject(rule) || typeof rule.when !== "string") return rule;
  const set = rule.set;
  if (set === undefined || !isObject(set)) return rule;
  const changed = change(rule.when, set);
  return changed === undefined ? undefined : { ...rule, when: changed.when, set: changed.set };
}

function withRules(
  schema: DatabaseSchema,
  change: (when: string, set: JsonObject) => { when: string; set: JsonObject } | undefined,
): DatabaseSchema {
  const triggers = (schema.triggers ?? []).flatMap((trigger): Trigger[] => {
    const changed = change(trigger.when, trigger.set);
    return changed === undefined ? [] : [{ ...trigger, ...changed }];
  });
  const skipped = (schema.skippedTriggers ?? []).flatMap((rule): SkippedTrigger[] => {
    const value = changedRule(rule.value, change);
    return value === undefined ? [] : [{ ...rule, value }];
  });
  return {
    properties: schema.properties,
    views: schema.views,
    ...(triggers.length === 0 ? {} : { triggers }),
    ...(skipped.length === 0 ? {} : { skippedTriggers: skipped }),
  };
}

/** A schema's rules with a property renamed in every rule that names it. */
export function renameInTriggers(schema: DatabaseSchema, from: string, to: string): DatabaseSchema {
  return withRules(schema, (when, set) => ({
    when: when === from ? to : when,
    set: Object.fromEntries(
      Object.entries(set).map(([key, value]) => [key === from ? to : key, value]),
    ),
  }));
}

/**
 * A schema's rules without a deleted property: it is dropped from what
 * each sets, and a rule on it, or left setting nothing, is dropped.
 */
export function deleteFromTriggers(schema: DatabaseSchema, key: string): DatabaseSchema {
  return withRules(schema, (when, set) => {
    const kept = Object.fromEntries(Object.entries(set).filter(([name]) => name !== key));
    return when === key || Object.keys(kept).length === 0 ? undefined : { when, set: kept };
  });
}

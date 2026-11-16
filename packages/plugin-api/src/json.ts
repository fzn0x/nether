/** A value that crosses between a plugin and the app unchanged: what JSON can write. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A JSON object, as a block's attributes are. */
export type JsonObject = Readonly<Record<string, Json>>;

/** Whether a value is JSON: what `JSON.stringify` writes and reads back the same. */
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJson);
}

/** Whether a value is a JSON object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJson(value);
}

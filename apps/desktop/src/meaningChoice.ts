// Whether search by meaning is on for a vault, on this device (ADR 0074):
// the provider and model chosen, and what the kept passages were embedded
// with. Kept in the vault's index outside its folder, so neither syncs. The
// app reads this as a vault opens; the indexer and the search load only
// while search by meaning is on.
import type { Vault } from "@nether/storage";

/** The provider and model a vault's notes are embedded with, when search by meaning is on. */
export interface MeaningChoice {
  /** The ID of one of this device's providers. */
  readonly provider: string;
  /** The embedding model, as the provider names it. */
  readonly model: string;
}

/** What the vault's kept passages were embedded with, and their vectors' length once known. */
export interface MeaningRecord extends MeaningChoice {
  readonly dimensions: number | undefined;
}

const choiceKey = "ai.meaning";
const recordKey = "ai.meaning.index";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function choiceOf(value: unknown): MeaningChoice | undefined {
  const kept = value as Partial<MeaningChoice> | undefined;
  return typeof kept?.provider === "string" &&
    kept.provider !== "" &&
    typeof kept.model === "string" &&
    kept.model !== ""
    ? { provider: kept.provider, model: kept.model }
    : undefined;
}

/** The vault's search by meaning, on this device: its provider and model, or none while it is off. */
export async function meaningChoice(vault: Vault): Promise<MeaningChoice | undefined> {
  return choiceOf(readJson(await vault.settings.setting(choiceKey)));
}

/**
 * Turns search by meaning on with a provider and model, or off. Another
 * provider or model than the kept passages came from forgets them, so the
 * vault is embedded again; turning it off keeps them, for turning it on again.
 */
export async function setMeaningChoice(
  vault: Vault,
  choice: MeaningChoice | undefined,
): Promise<void> {
  await vault.settings.setSetting(
    choiceKey,
    choice === undefined ? undefined : encoder.encode(JSON.stringify(choice)),
  );
  if (choice === undefined) return;
  const record = await meaningRecord(vault);
  if (record?.provider === choice.provider && record.model === choice.model) return;
  await vault.meaning.clearPassages();
  await keepRecord(vault, { ...choice, dimensions: undefined });
}

/** What the vault's kept passages were embedded with; none before the first. */
export async function meaningRecord(vault: Vault): Promise<MeaningRecord | undefined> {
  const value = readJson(await vault.settings.setting(recordKey));
  const choice = choiceOf(value);
  if (choice === undefined) return undefined;
  const dimensions = (value as { dimensions?: unknown }).dimensions;
  return {
    ...choice,
    dimensions: typeof dimensions === "number" && dimensions > 0 ? dimensions : undefined,
  };
}

/** Records what the vault's passages are embedded with. */
export async function keepRecord(vault: Vault, record: MeaningRecord): Promise<void> {
  await vault.settings.setSetting(recordKey, encoder.encode(JSON.stringify(record)));
}

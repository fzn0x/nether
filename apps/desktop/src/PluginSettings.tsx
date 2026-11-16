// A plugin's tab in the vault's settings (ADR 0055): the fields its
// manifest declares, drawn as the app draws its own, text, number, toggle
// and choice, each with what it says it does.
import { type Manifest, localize, settingValues } from "@nether/plugin-api";
import { type SyntheticEvent, useId, useState } from "react";
import { language, t } from "./messages.ts";

export function PluginSettings(props: {
  readonly manifest: Manifest;
  /** What the vault keeps of its settings. */
  readonly stored: unknown;
  /** Keeps its settings; a rejection shows in the tab, which stays open. */
  readonly onSave: (values: Readonly<Record<string, string | number | boolean>>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { manifest, stored, onSave, onClose } = props;
  const fields = manifest.contributes.settings;
  const prefix = useId();
  // Numbers as typed, read once saved.
  const [draft, setDraft] = useState<Readonly<Record<string, string | number | boolean>>>(() => {
    const values = settingValues(fields, stored);
    return Object.fromEntries(
      fields.map((field) => {
        const value = values[field.id] ?? field.default;
        return [field.id, field.type === "number" ? String(value) : value];
      }),
    );
  });
  const [error, setError] = useState<string | undefined>();
  const set = (id: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [id]: value }));
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const values: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value = draft[field.id] ?? field.default;
      if (field.type === "number") {
        const number = Number(String(value).trim());
        if (String(value).trim() === "" || !Number.isFinite(number)) {
          setError(t("notANumber", { name: localize(field.name, language) }));
          return;
        }
        values[field.id] = number;
      } else {
        values[field.id] = value;
      }
    }
    onSave(values).then(onClose, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <h3>{localize(manifest.name, language)}</h3>
      <div className="dialog-body">
        {fields.map((field) => {
          const name = localize(field.name, language);
          const hintId = `${prefix}-${field.id}`;
          const hint =
            field.description === undefined ? null : (
              <span className="hint" id={hintId}>
                {localize(field.description, language)}
              </span>
            );
          const described = field.description === undefined ? {} : { "aria-describedby": hintId };
          const value = draft[field.id] ?? field.default;
          switch (field.type) {
            case "toggle":
              return (
                <div key={field.id}>
                  <label className="field-check">
                    <input
                      type="checkbox"
                      checked={value === true}
                      {...described}
                      onChange={(event) => {
                        set(field.id, event.target.checked);
                      }}
                    />
                    {name}
                  </label>
                  {hint}
                </div>
              );
            case "choice":
              return (
                <label key={field.id} className="field">
                  {name}
                  <select
                    value={String(value)}
                    {...described}
                    onChange={(event) => {
                      set(field.id, event.target.value);
                    }}
                  >
                    {(field.choices ?? []).map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {localize(choice.name, language)}
                      </option>
                    ))}
                  </select>
                  {hint}
                </label>
              );
            case "number":
            case "text":
              return (
                <label key={field.id} className="field">
                  {name}
                  <input
                    type={field.type === "number" ? "number" : "text"}
                    value={String(value)}
                    spellCheck={false}
                    {...described}
                    onChange={(event) => {
                      set(field.id, event.target.value);
                    }}
                  />
                  {hint}
                </label>
              );
          }
        })}
      </div>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="quiet" onClick={onClose}>
          {t("cancel")}
        </button>
        <button type="submit" className="primary">
          {t("save")}
        </button>
      </div>
    </form>
  );
}

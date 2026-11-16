// The vault's appearance, a tab of its settings: light, dark or as the
// system, its theme, and its
// CSS snippets, each change shown and kept at once. Themes and snippets are
// the CSS files of the vault's `.nether/themes` and `.nether/snippets`
// folders, read again with Reload after they change. The directory installs
// themes into that folder (ADR 0065).
import type { Vault } from "@nether/storage";
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { DirectoryList } from "./DirectoryList.tsx";
import { type DirectoryEntry, installTheme, themeState } from "./directory.ts";
import {
  type Appearance,
  type Mode,
  availableStyles,
  builtInTheme,
  builtInThemes,
} from "./appearance.ts";
import { t } from "./messages.ts";
import type { AppearanceState } from "./useAppearance.ts";

const modes: readonly {
  readonly value: Mode;
  readonly label: "modeSystem" | "modeLight" | "modeDark";
}[] = [
  { value: "system", label: "modeSystem" },
  { value: "light", label: "modeLight" },
  { value: "dark", label: "modeDark" },
];

export function AppearanceSettings(props: {
  readonly vault: Vault;
  readonly state: AppearanceState;
  readonly onClose: () => void;
}) {
  const { vault, state, onClose } = props;
  const { appearance, missing } = state;
  const [styles, setStyles] = useState<{
    readonly themes: readonly string[];
    readonly snippets: readonly string[];
  }>({ themes: [], snippets: [] });
  const [error, setError] = useState<string | undefined>();
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    void availableStyles(vault).then((found) => {
      if (current) setStyles(found);
    });
    return () => {
      current = false;
    };
  }, [vault, round]);

  const installedOf = useCallback((entry: DirectoryEntry) => themeState(vault, entry), [vault]);

  const change = (next: Appearance) => {
    setError(undefined);
    state.change(next).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  // A theme or snippet named but gone is still listed, as missing.
  const themes = [
    ...new Set([
      ...styles.themes,
      ...(appearance.theme === undefined || builtInTheme(appearance.theme) !== undefined
        ? []
        : [appearance.theme]),
    ]),
  ];
  const snippets = [...new Set([...styles.snippets, ...appearance.snippets])];
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <h3>{t("appearance")}</h3>
      <div className="dialog-body">
        <fieldset>
          <legend>{t("appearanceMode")}</legend>
          {modes.map((mode) => (
            <label key={mode.value} className="field-check">
              <input
                type="radio"
                name="appearance-mode"
                checked={appearance.mode === mode.value}
                onChange={() => {
                  change({ ...appearance, mode: mode.value });
                }}
              />
              {t(mode.label)}
            </label>
          ))}
        </fieldset>
        <label className="field">
          {t("theme")}
          <select
            value={appearance.theme ?? ""}
            onChange={(event) => {
              const rest: Appearance = { mode: appearance.mode, snippets: appearance.snippets };
              change(event.target.value === "" ? rest : { ...rest, theme: event.target.value });
            }}
          >
            <option value="">{t("themeNether")}</option>
            <optgroup label={t("themesBuiltIn")}>
              {builtInThemes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {t(theme.label)}
                </option>
              ))}
            </optgroup>
            {themes.length === 0 ? null : (
              <optgroup label={t("themesOfVault")}>
                {themes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <fieldset>
          <legend>{t("cssSnippets")}</legend>
          {snippets.length === 0 ? (
            <p className="hint">{t("noSnippets")}</p>
          ) : (
            snippets.map((name) => (
              <label key={name} className="field-check">
                <input
                  type="checkbox"
                  checked={appearance.snippets.includes(name)}
                  onChange={(event) => {
                    change({
                      ...appearance,
                      snippets: event.target.checked
                        ? [...appearance.snippets, name]
                        : appearance.snippets.filter((item) => item !== name),
                    });
                  }}
                />
                {name}
              </label>
            ))
          )}
        </fieldset>
        <p className="hint">{t("stylesWhere")}</p>
        <DirectoryList
          kind="themes"
          installedOf={installedOf}
          install={(entry) => installTheme(vault, entry)}
          onInstalled={() => {
            setRound((count) => count + 1);
          }}
        />
      </div>
      {missing.length === 0 ? null : (
        <p role="alert">{t("stylesMissing", { names: missing.join(", ") })}</p>
      )}
      {error === undefined ? null : <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setRound((count) => count + 1);
            state.reload().catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        >
          {t("reloadStyles")}
        </button>
        <button type="submit" className="primary">
          {t("done")}
        </button>
      </div>
    </form>
  );
}

// The Plugins tab of the vault's settings (ADR 0055): the plugins that come
// with Nether, each with what it does and a switch. One turned off takes
// away what it adds, in this vault, until it is turned on again.
import { type Manifest, localize } from "@nether/plugin-api";
import { type SyntheticEvent, useState } from "react";
import { language, t } from "./messages.ts";

export function PluginsSettings(props: {
  readonly plugins: readonly Manifest[];
  /** Whether each plugin is on now. */
  readonly on: (id: string) => boolean;
  /** Keeps which are on; a rejection shows in the tab, which stays open. */
  readonly onSave: (on: Readonly<Record<string, boolean>>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { plugins, onSave, onClose } = props;
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(plugins.map((plugin) => [plugin.id, props.on(plugin.id)])),
  );
  const [error, setError] = useState<string | undefined>();

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    onSave(draft).then(onClose, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <h3>{t("pluginsTab")}</h3>
      <div className="dialog-body">
        <p className="hint">{t("pluginsIntro")}</p>
        <ul className="plugin-list">
          {plugins.map((plugin) => {
            const name = localize(plugin.name, language);
            return (
              <li key={plugin.id}>
                <label className="field-check">
                  <input
                    type="checkbox"
                    checked={draft[plugin.id] ?? true}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, [plugin.id]: event.target.checked }));
                    }}
                  />
                  {name}
                </label>
                <p className="hint">
                  {plugin.description === undefined ? null : (
                    <>{localize(plugin.description, language)} </>
                  )}
                  {t("pluginVersion", { version: plugin.version })}
                </p>
              </li>
            );
          })}
        </ul>
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

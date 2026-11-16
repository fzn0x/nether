// The Plugins tab of the vault's settings (ADR 0055): the plugins that come
// with Nether, each with what it does and a switch, and those in the
// vault's .nether/plugins folder (ADR 0058), each with what it asks for.
// One turned off takes away what it adds, in this vault, until it is
// turned on again. Turning on a plugin from a folder approves its code, as
// it is now, on this device.
import { type Manifest, type Permission, localize } from "@nether/plugin-api";
import { type SyntheticEvent, useState } from "react";
import { type MessageKey, language, t } from "./messages.ts";
import { type Approval, type FolderEntry, approvalOf } from "./plugins/folders.ts";
import { type PluginState, isFolderOn, isOn } from "./plugins/state.ts";

const askedFor: Readonly<Record<Permission, MessageKey>> = {
  network: "pluginAsksNetwork",
  "vault:read": "pluginAsksVaultRead",
  "vault:write": "pluginAsksVaultWrite",
};

/** What a plugin asks for, as a sentence. */
function asks(manifest: Manifest): string {
  if (manifest.permissions.length === 0) return t("pluginAsksNothing");
  const list = new Intl.ListFormat(language, { type: "conjunction" });
  return t("pluginAsks", {
    permissions: list.format(manifest.permissions.map((each) => t(askedFor[each]))),
  });
}

export function PluginsSettings(props: {
  /** The plugins that come with the app. */
  readonly plugins: readonly Manifest[];
  readonly state: PluginState;
  /**
   * Keeps which are on, and what this device approved; a rejection shows
   * in the tab, which stays open.
   */
  readonly onSave: (
    on: Readonly<Record<string, boolean>>,
    approvals: Readonly<Record<string, Approval>>,
  ) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { plugins, state, onSave, onClose } = props;
  const { folders } = state;
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>(() => ({
    ...Object.fromEntries(plugins.map((plugin) => [plugin.id, isOn(state, plugin.id)])),
    ...Object.fromEntries(folders.map((entry) => [entry.folder, isFolderOn(state, entry)])),
  }));
  const [error, setError] = useState<string | undefined>();

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const on: Record<string, boolean> = { ...state.on };
    const approvals = new Map(Object.entries(state.approvals));
    for (const plugin of plugins) on[plugin.id] = draft[plugin.id] ?? true;
    for (const entry of folders) {
      const approval = approvalOf(entry);
      // One that cannot run keeps what the vault and this device had.
      if (approval === undefined) continue;
      const chosen = draft[entry.folder] === true;
      on[entry.folder] = chosen;
      if (chosen) approvals.set(entry.folder, approval);
      else approvals.delete(entry.folder);
    }
    onSave(on, Object.fromEntries(approvals)).then(onClose, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const toggle = (id: string, checked: boolean) => {
    setDraft((current) => ({ ...current, [id]: checked }));
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <h3>{t("pluginsTab")}</h3>
      <div className="dialog-body">
        <h4>{t("pluginsBuiltIn")}</h4>
        <p className="hint">{t("pluginsIntro")}</p>
        <ul className="plugin-list">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <label className="field-check">
                <input
                  type="checkbox"
                  checked={draft[plugin.id] ?? true}
                  onChange={(event) => {
                    toggle(plugin.id, event.target.checked);
                  }}
                />
                {localize(plugin.name, language)}
              </label>
              <p className="hint">
                {plugin.description === undefined ? null : (
                  <>{localize(plugin.description, language)} </>
                )}
                {t("pluginVersion", { version: plugin.version })}
              </p>
            </li>
          ))}
        </ul>
        <h4>{t("pluginsFromVault")}</h4>
        <p className="hint">{t("pluginsFromVaultIntro")}</p>
        {folders.length === 0 ? (
          <p className="hint">{t("pluginsNoneFromVault")}</p>
        ) : (
          <ul className="plugin-list">
            {folders.map((entry) => (
              <FolderItem
                key={entry.folder}
                entry={entry}
                checked={draft[entry.folder] === true}
                waiting={
                  entry.problems.length === 0 &&
                  state.on[entry.folder] === true &&
                  !isFolderOn(state, entry)
                }
                onChange={(checked) => {
                  toggle(entry.folder, checked);
                }}
              />
            ))}
          </ul>
        )}
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

function FolderItem(props: {
  readonly entry: FolderEntry;
  readonly checked: boolean;
  /** Whether the vault has it on, and this device has not approved it as it is. */
  readonly waiting: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const { entry, checked, waiting, onChange } = props;
  const { manifest, problems } = entry;
  return (
    <li>
      <label className="field-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={problems.length > 0}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {manifest === undefined ? entry.folder : localize(manifest.name, language)}
      </label>
      {manifest === undefined ? null : (
        <p className="hint">
          {manifest.description === undefined ? null : (
            <>{localize(manifest.description, language)} </>
          )}
          {t("pluginVersion", { version: manifest.version })} {asks(manifest)}
        </p>
      )}
      {waiting ? <p className="hint">{t("pluginNotApproved")}</p> : null}
      {problems.length === 0 ? null : (
        <p className="hint" role="status">
          {t("pluginCannotRun", { problems: problems.join(" ") })}
        </p>
      )}
    </li>
  );
}

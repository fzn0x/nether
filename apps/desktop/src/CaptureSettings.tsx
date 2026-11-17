// The vault's quick capture settings, a tab of its settings in the mobile
// apps (ADR 0087): the folder captures go in, from the app icon's shortcuts
// and the share sheet, `Inbox` when none is named. They are kept in the
// vault's `.nether/capture.json`, which a capture reads before the vault's
// index is open.
import type { Vault } from "@nether/storage";
import { type SyntheticEvent, useEffect, useState } from "react";
import {
  captureFolder,
  captureSettingsName,
  cleanCaptureFolder,
  defaultCaptureFolder,
} from "./capture.ts";
import { t } from "./messages.ts";

export function CaptureSettings(props: { readonly vault: Vault; readonly onClose: () => void }) {
  const { vault, onClose } = props;
  const [folder, setFolder] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    void vault.readData(captureSettingsName).then((settings) => {
      if (current) setFolder(captureFolder(settings));
    });
    return () => {
      current = false;
    };
  }, [vault]);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (folder === undefined) return;
    const clean = cleanCaptureFolder(folder);
    try {
      const settings = (await vault.readData(captureSettingsName)) ?? {};
      await vault.writeData(captureSettingsName, {
        ...(typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
        folder: clean === "" ? defaultCaptureFolder : clean,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        {t("captureFolder")}
        <input
          value={folder ?? ""}
          disabled={folder === undefined}
          spellCheck={false}
          onChange={(event) => {
            setFolder(event.target.value);
            setError(undefined);
          }}
        />
        <span className="hint">{t("captureFolderHint")}</span>
      </label>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="quiet" onClick={onClose}>
          {t("cancel")}
        </button>
        <button type="submit" className="primary" disabled={folder === undefined}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}

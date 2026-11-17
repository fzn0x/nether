// The capture sheet (ADR 0087): what a capture says, typed or shared, and
// the vault it goes to, the one opened last unless another is chosen, or a
// new one named when the phone has none. Save files it as a note in the
// vault's capture folder. It is ready before any vault opens: the Capture
// shortcut shows it at once, and a share from another app on Android shows
// it with what was shared.
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { backend } from "./backend.ts";
import { type CaptureContent, type Shared, splitLink } from "./capture.ts";
import { t } from "./messages.ts";
import type { VaultInfo } from "./mygo.ts";
import { useModal } from "./useModal.ts";

/** Where the sheet's capture goes: a vault on the phone, or a new one by its name. */
export type CaptureVault = { readonly vault: VaultInfo } | { readonly name: string };

export function CaptureSheet(props: {
  /** What another app shared; absent for the Capture shortcut. */
  readonly shared?: Shared;
  /** The vaults on the phone, the one opened last first; undefined while they load. */
  readonly vaults: readonly VaultInfo[] | undefined;
  /** Files the capture; a rejection shows in the sheet, which stays open. */
  readonly onSave: (content: CaptureContent, where: CaptureVault) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { shared, vaults, onSave, onClose } = props;
  const split = shared === undefined ? { text: "" } : splitLink(shared);
  const [text, setText] = useState(split.text);
  const [chosen, setChosen] = useState<string | undefined>();
  const [name, setName] = useState(() => t("mobileVaultDefault"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const sheet = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useModal(sheet);

  // The sheet is ready once its text takes the focus: the cold start's target.
  useEffect(() => {
    field.current?.focus();
    backend.mark("capture-ready");
  }, []);

  const vault = vaults?.find((each) => each.id === chosen) ?? vaults?.[0];
  const files = shared?.files ?? [];
  const empty = text.trim() === "" && split.url === undefined && files.length === 0;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || vaults === undefined) return;
    if (empty) {
      setError(t("captureEmpty"));
      return;
    }
    const where: CaptureVault | undefined =
      vault === undefined ? (name.trim() === "" ? undefined : { name: name.trim() }) : { vault };
    if (where === undefined) {
      setError(t("captureNoVault"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSave(
        {
          text,
          files,
          ...(shared?.title === undefined ? {} : { title: shared.title }),
          ...(split.url === undefined ? {} : { url: split.url }),
        },
        where,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        // A press beside the sheet closes it, as on every sheet.
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="switcher dialog capture-sheet"
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-sheet-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="capture-sheet-title">
          {shared === undefined ? t("captureTitle") : t("captureSharedTitle")}
        </h2>
        <label className="field">
          {t("captureText")}
          <textarea
            ref={field}
            value={text}
            rows={5}
            aria-invalid={error === t("captureEmpty") ? true : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
            }}
          />
        </label>
        {shared?.title === undefined ? null : (
          <p className="capture-shared">{t("captureLinkTitle", { title: shared.title })}</p>
        )}
        {split.url === undefined ? null : (
          <p className="capture-shared">{t("captureLink", { url: split.url })}</p>
        )}
        {files.length === 0 ? null : (
          <div className="capture-shared">
            <p id="capture-files">{t("captureFiles", { count: files.length })}</p>
            <ul aria-labelledby="capture-files">
              {files.map((file) => (
                <li key={file.path}>{file.name}</li>
              ))}
            </ul>
          </div>
        )}
        {vaults === undefined ? null : vaults.length === 0 ? (
          <label className="field">
            {t("captureNewVault")}
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <span className="hint">{t("captureNewVaultHint")}</span>
          </label>
        ) : (
          <label className="field">
            {t("captureVault")}
            <select
              value={vault?.id ?? ""}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            >
              {vaults.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy || vaults === undefined}>
            {t("save")}
          </button>
        </div>
      </form>
    </div>
  );
}

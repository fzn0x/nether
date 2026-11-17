// What the phone hands the app (ADR 0087), over whatever shows: the
// Capture shortcut opens the capture sheet at once, before any vault's
// index; New note, Today's note and Search open the vault opened last at
// those commands; a share from another app opens the sheet with what was
// shared on Android, and on iOS, whose share extension has asked already,
// is filed as the app opens or comes back. Each capture is written into
// the vault's folder, which its index reads as the vault opens.
import { useCallback, useEffect, useRef, useState } from "react";
import { type CaptureVault, CaptureSheet } from "./CaptureSheet.tsx";
import { type Captures, backend } from "./backend.ts";
import {
  type Capture,
  type CaptureContent,
  type Shared,
  type VaultShortcut,
  captureFolder,
  captureSettingsName,
  fileCapture,
  localStamp,
} from "./capture.ts";
import { t } from "./messages.ts";
import type { VaultInfo } from "./mygo.ts";

/** The sheet open now: for the Capture shortcut, or for what was shared. */
type Sheet = { readonly kind: "capture" } | { readonly kind: "shared"; readonly shared: Shared };

/** How long a capture's confirmation shows. */
const statusMillis = 4_000;

/** The name a capture with neither a title nor text takes: the time. */
function untitled(at: Date): string {
  return t("captureUntitled", { time: localStamp(at).replace("T", " ").replace(":", ".") });
}

/** Files a capture into a vault, and gives what to tell the user. */
async function file(
  captures: Captures,
  vault: VaultInfo,
  content: CaptureContent,
  at: Date,
): Promise<string> {
  const target = await captures.target(vault);
  await fileCapture(target, content, at, untitled(at));
  captures.filed(vault.id);
  const folder = captureFolder(await target.readData(captureSettingsName));
  return t("captureSaved", { folder, vault: vault.name });
}

export function CaptureShortcuts(props: {
  readonly captures: Captures;
  /** The vault open now, if any. */
  readonly vault: VaultInfo | null;
  /** Opens a vault, as the welcome screen does. */
  readonly onOpen: (vault: VaultInfo) => void;
  /** Runs a vault's command once it is open. */
  readonly onCommand: (shortcut: VaultShortcut) => void;
}) {
  const { captures, vault, onOpen, onCommand } = props;
  const [queue, setQueue] = useState<readonly Sheet[]>([]);
  const [vaults, setVaults] = useState<readonly VaultInfo[] | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const sheet = queue[0];

  // The app's icon gets its shortcuts in the page's language, once the page has settled.
  useEffect(() => {
    const labels = (
      [
        ["capture", "shortcutCapture", "shortcutCaptureLong"],
        ["newNote", "shortcutNewNote", "shortcutNewNoteLong"],
        ["dayNote", "shortcutDayNote", "shortcutDayNoteLong"],
        ["search", "shortcutSearch", "shortcutSearchLong"],
      ] as const
    ).map(([id, title, description]) => ({ id, title: t(title), description: t(description) }));
    const timer = setTimeout(() => {
      void captures.setShortcuts(labels).catch(() => undefined);
    }, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [captures]);

  // The vaults the sheet offers load as it opens.
  useEffect(() => {
    if (sheet === undefined) return;
    let current = true;
    void backend.recent().then(
      (list) => {
        if (current) setVaults(list);
      },
      () => {
        if (current) setVaults([]);
      },
    );
    return () => {
      current = false;
    };
  }, [sheet]);

  useEffect(() => {
    if (status === undefined) return;
    const timer = setTimeout(() => {
      setStatus(undefined);
    }, statusMillis);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  /** Opens the vault opened last, when none is open, for a shortcut's command. */
  const openLast = useCallback(async () => {
    if (vault !== null) return true;
    const startup = await backend.startup().catch(() => null);
    if (startup === null) return false;
    onOpen(startup.vault);
    return true;
  }, [vault, onOpen]);

  /** The shares being filed now, each filed once however often it is handed in. */
  const filing = useRef(new Set<string>());

  /** A share whose own sheet chose its vault, as iOS's does: filed at once. */
  const fileChosen = useCallback(
    async (shared: Shared) => {
      if (filing.current.has(shared.id)) return;
      filing.current.add(shared.id);
      try {
        const list = await backend.recent();
        let chosen = list.find((each) => each.id === shared.vault);
        if (chosen === undefined && shared.newVault !== undefined) {
          chosen = await backend.open(shared.newVault);
        }
        chosen ??= list[0] ?? (await backend.open(t("mobileVaultDefault")));
        setStatus(await file(captures, chosen, shared, new Date(shared.at)));
        await captures.done(shared.id);
      } catch (reason) {
        setStatus(
          t("captureFailed", { reason: reason instanceof Error ? reason.message : String(reason) }),
        );
      } finally {
        filing.current.delete(shared.id);
      }
    },
    [captures],
  );

  const take = useCallback(
    (capture: Capture) => {
      if (capture.kind === "shared") {
        if (capture.shared.vault !== undefined || capture.shared.newVault !== undefined) {
          void fileChosen(capture.shared);
          return;
        }
        // The same share handed in again, as the app looks again, is shown once.
        setQueue((list) =>
          list.some((each) => each.kind === "shared" && each.shared.id === capture.shared.id)
            ? list
            : [...list, { kind: "shared", shared: capture.shared }],
        );
        return;
      }
      if (capture.shortcut === "capture") {
        setQueue((list) =>
          list.some((each) => each.kind === "capture") ? list : [...list, { kind: "capture" }],
        );
        return;
      }
      const shortcut = capture.shortcut;
      void openLast().then((opened) => {
        if (opened) onCommand(shortcut);
      });
    },
    [fileChosen, openLast, onCommand],
  );

  useEffect(() => captures.listen(take), [captures, take]);

  const close = useCallback(
    async (done: Sheet) => {
      setQueue((list) => list.slice(1));
      setVaults(undefined);
      if (done.kind === "shared") {
        await captures.done(done.shared.id).catch(() => undefined);
        // Back to the app that shared, as a share's sheet ends.
        captures.leave?.();
      }
    },
    [captures],
  );

  const save = async (content: CaptureContent, where: CaptureVault) => {
    if (sheet === undefined) return;
    const chosen = "vault" in where ? where.vault : await backend.open(where.name);
    const at = sheet.kind === "shared" ? new Date(sheet.shared.at) : new Date();
    const saved = await file(captures, chosen, content, at);
    setStatus(saved);
    // With no vault open, as on the phone's first capture, the vault opens.
    if (vault === null && sheet.kind === "capture") onOpen(chosen);
    await close(sheet);
  };

  return (
    <>
      {sheet === undefined ? null : (
        <CaptureSheet
          key={sheet.kind === "shared" ? sheet.shared.id : "capture"}
          {...(sheet.kind === "shared" ? { shared: sheet.shared } : {})}
          vaults={vaults}
          onSave={save}
          onClose={() => void close(sheet)}
        />
      )}
      {status === undefined ? null : (
        <p className="capture-status" role="status">
          {status}
        </p>
      )}
    </>
  );
}

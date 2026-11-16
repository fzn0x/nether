// The vault's keyboard shortcuts: the defaults, the app's commands' and its
// plugins', with the choices it keeps in `.nether/hotkeys.json` over them.
// Saving writes the choices.
import type { Vault } from "@nether/storage";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Hotkeys, readHotkeys, resolveHotkeys } from "./shortcuts.ts";

const hotkeysName = "hotkeys";

export function useHotkeys(
  vault: Vault | undefined,
  defaults: Hotkeys,
): {
  /** Each command's shortcuts, as they work now. */
  readonly hotkeys: Hotkeys;
  /** The vault's own choices. */
  readonly chosen: Hotkeys;
  readonly save: (chosen: Hotkeys) => Promise<void>;
} {
  const [chosen, setChosen] = useState<Hotkeys>({});

  useEffect(() => {
    if (vault === undefined) return;
    let current = true;
    void vault.readData(hotkeysName).then((data) => {
      if (current) setChosen(readHotkeys(data));
    });
    return () => {
      current = false;
    };
  }, [vault]);

  const save = useCallback(
    async (next: Hotkeys) => {
      if (vault === undefined) return;
      await vault.writeData(hotkeysName, next);
      setChosen(next);
    },
    [vault],
  );

  const hotkeys = useMemo(() => resolveHotkeys(defaults, chosen), [defaults, chosen]);
  return { hotkeys, chosen, save };
}

// What the page knows of a phone (ADR 0087): a page narrower than 40rem,
// as style.css lays it out, shows one note at a time with the sidebar as a
// drawer; a coarse pointer, a finger, gets controls 48 pixels square. The
// layout follows the page's width, not the device, so a tablet keeps the
// desktop's.
import { useSyncExternalStore } from "react";
import type { CommandId } from "./commands.ts";

/** The width below which the page is laid out for a phone, as style.css has it. */
export const phoneQuery = "(max-width: 40rem)";

/** A pointer as coarse as a finger, which gets targets 48 pixels square. */
export const coarseQuery = "(pointer: coarse)";

/** What a phone leaves out of its menus and the palette: tabs and the second pane, which it never shows. */
export const notOnPhones: ReadonlySet<string> = new Set<CommandId>([
  "splitRight",
  "nextTab",
  "previousTab",
  "closeTab",
]);

/** Whether a media query matches now; never in a page without `matchMedia`, as in tests. */
export function matches(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

/** Whether a media query matches, following it as it changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      if (typeof matchMedia !== "function") return () => undefined;
      const list = matchMedia(query);
      list.addEventListener("change", changed);
      return () => {
        list.removeEventListener("change", changed);
      };
    },
    () => matches(query),
  );
}

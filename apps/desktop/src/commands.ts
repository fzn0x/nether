// The app's commands: every action, by its ID, in the order the palette and
// the shortcuts list show them, and the shortcuts each has unless the
// vault chooses others. Their names are in the messages, as `command_ID`.
import type { MenuName } from "@nether/plugin-api";
import { type Hotkeys, isMac } from "./shortcuts.ts";

export const commandIds = [
  "palette",
  "switcher",
  "search",
  "newNote",
  "newFolder",
  "newDatabase",
  "newCanvas",
  "dayNote",
  "weekNote",
  "monthNote",
  "toggleSource",
  "rename",
  "bookmark",
  "history",
  "comment",
  "export",
  "splitRight",
  "nextTab",
  "previousTab",
  "closeTab",
  "import",
  "trashNote",
  "showNotes",
  "showTags",
  "showTrash",
  "showAssigned",
  "openGraph",
  "templateSettings",
  "myName",
  "appearance",
  "servers",
  "sync",
  "members",
  "spaces",
  "share",
  "notifications",
  "shortcuts",
  "plugins",
  "checkUpdates",
  "updateChecks",
  "closeVault",
] as const;

export type CommandId = (typeof commandIds)[number];

/** The shortcuts commands have unless the vault chooses others; the rest have none. */
export const defaultHotkeys: Hotkeys = {
  palette: ["Mod+P"],
  switcher: ["Mod+O"],
  search: ["Mod+Shift+F"],
  newNote: ["Mod+N"],
  dayNote: ["Mod+Shift+D"],
  toggleSource: ["Mod+/"],
  rename: ["F2"],
  comment: ["Mod+Alt+M"],
  export: ["Mod+Shift+E"],
  // Ctrl and Tab, as browsers have it: on a Mac, Cmd and Tab is the system's.
  nextTab: [isMac() ? "Ctrl+Tab" : "Mod+Tab"],
  previousTab: [isMac() ? "Ctrl+Shift+Tab" : "Mod+Shift+Tab"],
  closeTab: ["Mod+W"],
  openGraph: ["Mod+G"],
  templateSettings: ["Mod+,"],
};

/** A menu of the menu bar: the app's commands in it, in order, with lines between groups. */
export interface CoreMenu {
  readonly name: MenuName;
  readonly entries: readonly (CommandId | "separator")[];
}

/**
 * The menu bar, where every command sits (ADR 0047). Plugins' commands
 * come after a menu's own, and in a Plugins menu at the end unless they
 * name another.
 */
export const coreMenus: readonly CoreMenu[] = [
  {
    name: "file",
    entries: [
      "newNote",
      "newFolder",
      "newDatabase",
      "newCanvas",
      "dayNote",
      "weekNote",
      "monthNote",
      "separator",
      "import",
      "export",
      "separator",
      "closeVault",
    ],
  },
  {
    name: "note",
    entries: [
      "rename",
      "bookmark",
      "toggleSource",
      "history",
      "comment",
      "splitRight",
      "separator",
      "trashNote",
    ],
  },
  {
    name: "view",
    entries: [
      "palette",
      "switcher",
      "search",
      "openGraph",
      "separator",
      "showNotes",
      "showTags",
      "showTrash",
      "showAssigned",
      "separator",
      "nextTab",
      "previousTab",
      "closeTab",
    ],
  },
  { name: "sync", entries: ["servers", "sync", "members", "spaces", "share", "notifications"] },
  {
    name: "settings",
    entries: [
      "templateSettings",
      "myName",
      "appearance",
      "shortcuts",
      "plugins",
      "separator",
      "checkUpdates",
      "updateChecks",
    ],
  },
];

/** The menu each of the app's commands sits in. */
export const menuOfCommand: Readonly<Record<CommandId, MenuName>> = Object.fromEntries(
  coreMenus.flatMap(({ name, entries }) =>
    entries.flatMap((entry) => (entry === "separator" ? [] : [[entry, name]])),
  ),
) as Record<CommandId, MenuName>;

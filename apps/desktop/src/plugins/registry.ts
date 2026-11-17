// Every command of the app, its own and its plugins', which the palette,
// the menus and the shortcuts list (ADR 0055). The app's own are its
// names, as `newNote`; a plugin's are `plugin-id:command`.
import type { MenuName } from "@nether/plugin-api";
import type { Icon } from "../icons.ts";
import type { Hotkeys } from "../shortcuts.ts";

export interface Command {
  readonly id: string;
  /** Its name, as the shortcuts list shows it. */
  readonly name: () => string;
  /** Its name as it reads now, in menus and the palette, if that changes: a bookmarked note's is to remove it. */
  readonly nameNow?: () => string;
  /** The menu it sits in, after the menu's own commands if it is a plugin's. */
  readonly menu: MenuName;
  /** Its shortcuts unless the vault chooses others. */
  readonly keys: readonly string[];
  readonly icon?: Icon;
  /** Whether its menu item shows it as one that deletes. */
  readonly danger?: boolean;
  /** The plugin that adds it; none for the app's own. */
  readonly plugin?: string;
  /** Whether a plugin from the vault's folder adds it, whose code can change (ADR 0072). */
  readonly fromVault?: boolean;
  /** Whether it can run now: one that cannot shows in its menu, greyed, and not in the palette. */
  readonly enabled: () => boolean;
  readonly run: () => void;
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #listeners = new Set<() => void>();
  #all: readonly Command[] = [];
  #defaults: Hotkeys = {};

  /** Adds a command; returns a function that takes it away. */
  add(command: Command): () => void {
    if (this.#commands.has(command.id)) {
      throw new Error(`A command ${command.id} is there already.`);
    }
    this.#commands.set(command.id, command);
    this.#changed();
    return () => {
      if (this.#commands.get(command.id) !== command) return;
      this.#commands.delete(command.id);
      this.#changed();
    };
  }

  get(id: string): Command | undefined {
    return this.#commands.get(id);
  }

  /** Every command, in the order they came; the same list until one comes or goes. */
  all(): readonly Command[] {
    return this.#all;
  }

  /**
   * Each command's shortcuts unless the vault chooses others. Keys another
   * command had first stay that command's, so a plugin cannot take the
   * app's.
   */
  defaults(): Hotkeys {
    return this.#defaults;
  }

  /** Calls `listener` when a command comes or goes; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    this.#all = [...this.#commands.values()];
    const taken = new Set<string>();
    const defaults: Record<string, readonly string[]> = {};
    for (const command of this.#all) {
      const keys = command.keys.filter((keys) => !taken.has(keys));
      for (const key of keys) taken.add(key);
      if (keys.length > 0) defaults[command.id] = keys;
    }
    this.#defaults = defaults;
    for (const listener of this.#listeners) listener();
  }
}

// The few extension calls the clipper makes, typed here rather than through
// a package: Firefox's `browser`, or Chrome's `chrome`, both of which give
// promises in Manifest V3.

/** What the popup keeps in the browser's local storage, which neither browser syncs. */
export interface Kept {
  readonly server?: string;
  readonly token?: string;
  readonly name?: string;
  readonly workspace?: string;
  readonly destination?: string;
  readonly folder?: string;
}

export interface Tab {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
}

interface InjectionResult {
  readonly result?: unknown;
}

export interface Extension {
  readonly storage: {
    readonly local: {
      get(keys: readonly string[]): Promise<Record<string, unknown>>;
      set(items: Readonly<Record<string, unknown>>): Promise<void>;
      remove(keys: readonly string[]): Promise<void>;
    };
  };
  readonly permissions: {
    request(permissions: { readonly origins: readonly string[] }): Promise<boolean>;
    remove(permissions: { readonly origins: readonly string[] }): Promise<boolean>;
  };
  readonly tabs: {
    query(query: { readonly active: boolean; readonly currentWindow: boolean }): Promise<Tab[]>;
    get(id: number): Promise<Tab>;
    create(properties: { readonly url: string }): Promise<Tab>;
  };
  readonly scripting: {
    executeScript(injection: {
      readonly target: { readonly tabId: number };
      readonly files?: readonly string[];
      readonly func?: (...args: never[]) => unknown;
      readonly args?: readonly unknown[];
    }): Promise<InjectionResult[]>;
  };
}

/** The browser's extension calls: Firefox's `browser`, else Chrome's `chrome`. */
export function extension(): Extension {
  const scope = globalThis as { browser?: Extension; chrome?: Extension };
  const found = scope.browser ?? scope.chrome;
  if (found === undefined) throw new Error("This page is not the extension's.");
  return found;
}

/** What the popup kept, read back with each value's type checked. */
export async function kept(api: Extension): Promise<Kept> {
  const items = await api.storage.local.get([
    "server",
    "token",
    "name",
    "workspace",
    "destination",
    "folder",
  ]);
  const text = (key: string) => (typeof items[key] === "string" ? items[key] : undefined);
  const entries = ["server", "token", "name", "workspace", "destination", "folder"].flatMap(
    (key) => {
      const value = text(key);
      return value === undefined ? [] : [[key, value] as const];
    },
  );
  return Object.fromEntries(entries);
}

// The servers a phone is signed in to (ADR 0087): their accounts on a list
// beside the vaults', which the app's plugin keeps, and each session's
// token and the account's private key in the system's secure storage, as
// the desktop keeps them in its keychain: on iOS the Keychain, readable
// after the first unlock, on this device only and never in iCloud; on
// Android sealed with a key from the Keystore, which the app's backup rules
// leave out, so a restored app signs in again.
import type { Backend } from "./backend.ts";
import type { NetherVaultsPlugin } from "./mobile.ts";
import { fromBase64, toBase64 } from "./mobileFiles.ts";

/** Values kept secret on the phone, by name. */
export interface Secrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The secrets, in the Keychain or sealed under the Keystore's key, through the plugin for them. */
export function secureSecrets(): Secrets {
  const ready = (async () => {
    const module = await import("@aparajita/capacitor-secure-storage");
    // Under Nether's own names, apart from any other plugin's.
    await module.SecureStorage.setKeyPrefix("nether_");
    return module;
  })();
  return {
    async get(name) {
      const { SecureStorage } = await ready;
      const value = await SecureStorage.get(name, false, false);
      return typeof value === "string" ? value : undefined;
    },
    async set(name, value) {
      const { SecureStorage, KeychainAccess } = await ready;
      await SecureStorage.set(
        name,
        value,
        false,
        false,
        KeychainAccess.afterFirstUnlockThisDeviceOnly,
      );
    },
    async remove(name) {
      const { SecureStorage } = await ready;
      await SecureStorage.remove(name, false);
    },
  };
}

const tokenOf = (url: string) => `token ${url}`;
const keyOf = (url: string) => `key ${url}`;

/** What the backend does with servers, over the plugin's list and the secrets. */
export function phoneServers(
  plugin: Pick<NetherVaultsPlugin, "servers" | "saveServer" | "forgetServer">,
  secrets: Secrets,
): Pick<
  Backend,
  "servers" | "saveServer" | "serverToken" | "forgetServer" | "serverKey" | "saveServerKey"
> {
  return {
    async servers() {
      return [...(await plugin.servers()).servers];
    },
    // The token first: a server on the list has a session to read.
    async saveServer(account, token) {
      await secrets.set(tokenOf(account.url), token);
      await plugin.saveServer({ account });
    },
    serverToken: (url) => secrets.get(tokenOf(url)),
    async forgetServer(url) {
      await plugin.forgetServer({ url });
      await secrets.remove(tokenOf(url));
      await secrets.remove(keyOf(url));
    },
    async serverKey(url) {
      const key = await secrets.get(keyOf(url));
      return key === undefined ? undefined : fromBase64(key);
    },
    saveServerKey: (url, key) => secrets.set(keyOf(url), toBase64(key)),
  };
}

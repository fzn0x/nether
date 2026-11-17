// Provisioning (ADR 0085), the `scim` enterprise feature: directories an
// instance admin adds on the console's Directories page, each a SCIM
// client, as Okta or Entra ID, that makes, changes, deactivates and removes
// the accounts at its domains through its own address and token. Core
// enforces deactivation whether the feature is on or off; its routes
// answer only while it is on, and its tables are in every schema, as the
// module is in every image (ADR 0079).
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { registerConsole } from "./console.ts";
import { listDirectories } from "./directories.ts";
import { registerScim } from "./scim.ts";

/** How often the server looks for tokens that end soon. */
const checkEvery = 86_400_000;

/** Days before a token ends that the server's log warns of it, each day. */
const warnDays = 7;

export const scimModule: EnterpriseModule = {
  feature: "scim",
  plugin: (
    app,
    { db, config, isOn, whenOn, events, disconnect, dataPolicies, security, every, permissions },
  ) => {
    registerConsole(app, { db, config, events, security, disconnect, whenOn, permissions });
    registerScim(app, { db, config, events, disconnect, dataPolicies, whenOn });

    // Each day, on one node, the last week of a token is in the server's
    // log, so provisioning does not stop by surprise.
    every("scim.tokens", checkEvery, async () => {
      if (!(await isOn())) return;
      for (const directory of await listDirectories(db)) {
        const ends = directory.token?.expiresAt;
        if (ends === undefined) continue;
        const left = ends.getTime() - Date.now();
        if (left > warnDays * 86_400_000) continue;
        app.log.warn(
          { directory: directory.id, expiresAt: ends.toISOString() },
          left <= 0
            ? "A SCIM directory's token has ended: make a new one on the console's Directories page"
            : "A SCIM directory's token ends within a week: make a new one on the console's Directories page",
        );
      }
    });
    return Promise.resolve();
  },
};

export { tokenPrefix } from "./directories.ts";

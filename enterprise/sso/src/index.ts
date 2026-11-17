// Single sign-on (ADR 0080), the `sso` enterprise feature: SAML 2.0 and
// OpenID Connect providers bound to email domains, set on the console's
// Single sign-on page, which the apps offer beside the server's own ways
// in, and may require: then the server refuses other ways in to the
// accounts it covers, and ends their other sessions. Its routes answer
// only while the feature is on; its tables are in every schema, as the
// module is in every image (ADR 0079).
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { refreshMetadata, registerConsole } from "./console.ts";
import { Enforcement } from "./enforcement.ts";
import { listProviders } from "./providers.ts";
import { registerSignIn } from "./signIn.ts";

/** How often a provider's metadata is read again from its address. */
const readEvery = 86_400_000;

export const ssoModule: EnterpriseModule = {
  feature: "sso",
  plugin: (app, { db, config, isOn, whenOn, events, guards, disconnect, security, every }) => {
    const enforcement = new Enforcement(db, isOn, config.ssoEnforce);
    const removeGuard = guards.add(enforcement);
    const context = { db, config, whenOn, events, guards, enforcement };
    registerSignIn(app, context);
    registerConsole(app, { ...context, disconnect, security });

    // Each day, on one node of the server's (ADR 0082), each SAML
    // provider's metadata is read again from its address, so a certificate
    // it rolls over is taken; a copy that does not read leaves the last one
    // that did.
    every("sso.metadata", readEvery, async () => {
      if (!(await isOn())) return;
      for (const provider of await listProviders(db)) {
        const { settings } = provider;
        if (settings.kind !== "saml" || settings.metadataUrl === null) continue;
        await refreshMetadata(db, config, provider, settings).catch((error: unknown) => {
          app.log.warn(
            { err: error, provider: provider.id },
            "Could not read a provider's metadata again; the last copy stays",
          );
        });
      }
    });
    app.addHook("onClose", (_instance, done) => {
      removeGuard();
      done();
    });
    return Promise.resolve();
  },
};

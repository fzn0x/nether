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

/** How often the module looks for metadata due to be read again. */
const checkEvery = 3_600_000;
/** How old a provider's metadata may be before it is read again from its address. */
const readEvery = 86_400_000;

export const ssoModule: EnterpriseModule = {
  feature: "sso",
  plugin: (app, { db, config, isOn, whenOn, guards, disconnect, security }) => {
    const enforcement = new Enforcement(db, isOn, config.ssoEnforce);
    const removeGuard = guards.add(enforcement);
    const context = { db, config, whenOn, guards, enforcement };
    registerSignIn(app, context);
    registerConsole(app, { ...context, disconnect, security });

    // Each day, a SAML provider's metadata is read again from its address,
    // so a certificate it rolls over is taken; a copy that does not read
    // leaves the last one that did.
    const refresh = async () => {
      if (!(await isOn())) return;
      for (const provider of await listProviders(db)) {
        const { settings } = provider;
        if (settings.kind !== "saml" || settings.metadataUrl === null) continue;
        if (Date.now() - new Date(settings.readAt).getTime() < readEvery) continue;
        await refreshMetadata(db, config, provider, settings).catch((error: unknown) => {
          app.log.warn(
            { err: error, provider: provider.id },
            "Could not read a provider's metadata again; the last copy stays",
          );
        });
      }
    };
    const timer = setInterval(() => {
      refresh().catch((error: unknown) => {
        app.log.error({ err: error }, "Could not look for providers' metadata to read again");
      });
    }, checkEvery);
    timer.unref();
    app.addHook("onClose", (_instance, done) => {
      clearInterval(timer);
      removeGuard();
      done();
    });
    return Promise.resolve();
  },
};

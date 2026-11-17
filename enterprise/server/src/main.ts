// The server as the image runs it (ADR 0079): with every enterprise
// feature's module, each off until an admin switches it on in the console,
// or the environment pins it. The server never imports these; this entry
// gives them to it.
import { adminModule } from "@nether/enterprise-admin";
import { auditModule } from "@nether/enterprise-audit";
import { policiesModule } from "@nether/enterprise-policies";
import { scimModule } from "@nether/enterprise-scim";
import { ssoModule } from "@nether/enterprise-sso";
import { runServer } from "@nether/server/src/start.ts";

runServer({
  enterpriseModules: [adminModule, policiesModule, ssoModule, scimModule, auditModule],
});

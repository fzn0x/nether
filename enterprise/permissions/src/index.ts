// The `permissions` enterprise feature (ADR 0089): custom roles, groups'
// access to teamspaces and pages, and sharing within a workspace's domains.
// Core reads what each role may do wherever the server decides, through
// `placeOf`, and enforces it; this module gives the workspaces their routes
// to manage what the feature adds: so far, their custom roles.
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { registerRoles } from "./roles.ts";

export const permissionsModule: EnterpriseModule = {
  feature: "permissions",
  plugin: (app, context) => {
    registerRoles(app, context);
    return Promise.resolve();
  },
};

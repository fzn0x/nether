// The `permissions` enterprise feature (ADR 0089): custom roles, groups'
// access to teamspaces and pages, and sharing within a workspace's domains.
// Core reads what each role may do wherever the server decides, through
// `placeOf`, and enforces it; this module will give the workspaces and the
// console their routes to manage what the feature adds. It has none yet:
// while it is on, each built-in role gives what it always has.
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";

export const permissionsModule: EnterpriseModule = {
  feature: "permissions",
  plugin: () => Promise.resolve(),
};

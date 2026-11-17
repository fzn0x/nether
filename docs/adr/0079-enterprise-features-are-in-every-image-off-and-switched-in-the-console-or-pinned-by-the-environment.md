# 0079. Enterprise features are in every image, off, and switched in the console or pinned by the environment

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for an enterprise switch: "Admins turn each enterprise feature on or
off in the admin console or by environment variable; no license key, seat
limit or phone-home", and for an admin console: "Usage analytics,
workspace management, security settings in one place".
[ADR 0001](0001-license-agpl-and-dco.md) keeps every feature under one
license, and [Section 3](../requirements.md#editions) has the code of
enterprise features in `enterprise/` only to keep it organized: code
outside it never depends on it.

Phase 0 left the extension point in `apps/server/src/enterprise.ts`: a
module is a Fastify plugin for one feature, the server registers the
module of each feature switched on, and `NETHER_ENTERPRISE_<FEATURE>`
switches it, off when unset. A feature switched on with no module in the
build stops the server at startup. No module exists yet, nothing gives a
build its modules, and nothing but the environment switches them.

## Decision

**Every image has every module, each off until switched on.** A package,
`enterprise/server` (`@nether/enterprise-server`), is the server's entry
in the image: it starts the server with the modules of `enterprise/`.
`apps/server` exports what starting it takes, its `startServer`, which its
own entry calls with no module, and never imports `enterprise/`; the
modules import the server's extension API. One image serves everyone: a
self-hosted install, an air-gapped one and a hosted one run the same code.

**A switch is the console's, unless the environment pins it.**
`NETHER_ENTERPRISE_<FEATURE>` set to `on` or `off` pins that feature, and
the console shows it as set by its variable, with no control. Unset, the
console decides, and a feature is off until an instance admin turns it
on. The console's choice is kept in the database, in `instance_settings`,
and each server reads it again at most every five seconds, so every node
sees a change within that.

**A module registers once and asks for its switch on each request.** The
server registers every module its build has, and gives each a way to ask
whether its feature is on. A feature off answers 404 at its routes and
does nothing at its hooks, from the next request, with no restart. A
feature pinned on with no module in the build still stops the server at
startup, saying so.

**The console's Features page is in every build; the rest of it is the
`admin` feature.** An instance admin, as the first account made at setup
is, opens the console in the web app at `/admin`, its own entry as a share
link's page is. Its Features page lists each feature, its switch and why
it is set as it is; without it, a feature off could only be turned on by
the environment. The `admin` feature adds the rest:

1. **This part**: the switches, the entry in the image, and the console's
   Features page, with its Usage page as the `admin` module's first route:
   accounts, those signed in during the last 30 days, workspaces, notes,
   and attachments' bytes, counted from the database as asked.
2. **Next**: the Workspaces page, each workspace with its owners, members
   and size, and the Security page, the sign-in methods, the sessions'
   length and the rate limits, set in one place, those the environment sets
   shown as set by it.

**Nothing leaves the server.** No license key, no seat count, no report to
anyone: the switches and the counts are the server's own, and every
feature works air-gapped.

## Alternatives

- **Switches only in the environment**, as Phase 0 had them. The
  requirements ask for the console too, and a restart to try a feature is
  a step back from a switch.
- **Registering only the features on, and restarting to change them.**
  Simpler for each module, but every node would need a restart, and the
  console's switch would not take effect when it is pressed.
- **An image for each edition.** There are no editions: one license, every
  feature free. Two images would be two things to test, sign and document.
- **The server loading modules from paths named by an environment
  variable.** Code chosen at runtime by a path is a door; a build that
  names its modules in code is checked by its types and its tests.
- **The whole console as the `admin` feature.** Its switches would then
  need the environment to turn the console on, and every other feature
  through it.

## Consequences

- Each module checks its switch on each route and hook; a helper does it,
  so a module cannot forget.
- The image's entry moves to `enterprise/server`; `apps/server`'s own
  entry stays, for tests and for a build without `enterprise/`.
- The health check still says which features are on, now as the switches
  decide; CI's check that the server runs with every feature off holds,
  as that is the default.
- An admin who pins a switch by the environment changes it by the
  environment only.
- High availability, `ha`, is the exception: it describes the deployment,
  so the environment alone sets it, read at startup
  ([ADR 0082](0082-several-nodes-share-sync-through-valkey-take-their-order-from-postgresql-and-roll-out-one-at-a-time.md)).

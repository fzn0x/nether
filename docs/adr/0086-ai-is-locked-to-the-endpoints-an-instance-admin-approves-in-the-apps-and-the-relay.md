# 0086. AI is locked to the endpoints an instance admin approves, in the apps and the relay

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for "Private AI endpoint enforcement | Admin locks AI to an approved
internal model endpoint for the whole organization". It is part of the
`policies` enterprise feature: free, open source, and off until an
instance admin turns it on
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).

Where AI runs today:

- **The desktop app** sends a vault's text from the device to a provider
  set up there: any OpenAI-compatible endpoint, or Anthropic
  ([ADR 0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)).
  For a vault linked to a workspace, it asks the server for the
  workspace's AI switch as the vault opens and again before each
  request, and keeps the last answer in the vault's index for when the
  server cannot be reached.
- **The web app** sends through its server's relay, to the account's own
  providers or the instance's, by `NETHER_AI` (`on`, `admin` or `off`)
  ([ADR 0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md)).
- A provider is a kind, an address, a model and a key. Search by meaning
  embeds through one too.

`NETHER_AI=admin` already keeps the web app to the admin's providers. It
does nothing for the desktop app, where most writing happens, and it
cannot name which addresses are approved.

## Decision

**An instance admin approves a list of AI endpoints. While the `policies`
feature is on and the list has one, AI for every workspace on the server
goes only to them, in every Nether app.**

### The list

- Up to 20 addresses, as `https://llm.corp.example/v1`, set on the
  console's **AI endpoints** section, or pinned by `NETHER_AI_ENDPOINTS`,
  a comma-separated list. Pinned, the console shows it and no control. An
  address that is not one stops the server at startup, naming the
  variable.
- Kept in `instance_settings`, and read again at most every five seconds,
  as the switches are.
- An empty list locks nothing. Turning the feature off unlocks, as any
  feature off does nothing.

### What matches

A provider's address matches an approved one when:

- the scheme, the host and the port are the same, compared in lower case
  with default ports left out;
- and its path is the approved path, or under it at a `/`.

So `https://llm.corp.example/v1` approves
`https://llm.corp.example/v1/` and `https://llm.corp.example/v1/team`,
not `https://llm.corp.example/v10` or `https://llm.corp.example`. The
kind and the model are the provider's own: one endpoint may serve
several models.

### Where it holds

- **The server** gives the list in `/api/me`, as `aiEndpoints`, or `null`
  when nothing is locked.
- **The relay** refuses, with 403, a request to a provider whose address
  does not match: the account's own or the instance's. Making or changing
  an account's provider at such an address is refused too, saying which
  addresses are approved.
- **The desktop app**, for a vault linked to a workspace on that server,
  uses only a provider that matches, for writing assist, asking the
  notes, building with AI and search by meaning:
  - it checks the list as it checks the workspace's switch: as the vault
    opens, and again before each request, with the last answer kept for
    when the server cannot be reached;
  - the AI tab marks a provider that does not match as not allowed by
    that server, and a vault does not use it;
  - a vault that is not linked to a server is the person's own, and no
    server locks it.
- **The web app** shows the approved addresses on its AI tab, and offers
  only the providers that match.

### What it cannot do

It keeps Nether's own apps to the approved endpoints. It cannot stop a
changed app, another program reading the vault's files, or a plugin given
network access on its device
([ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md))
from sending text elsewhere. Organizations that need that too add network
rules on their devices; the guide says so.

### Where it lives

- **Core** keeps the list, its variable and the matching, and enforces it
  in the relay and `/api/me`, asking the `policies` switch.
- **`enterprise/policies`**, a new module, adds the console's routes:
  `GET` and `PUT /api/admin/ai-endpoints`, for instance admins, while the
  feature is on. Data policies, the roadmap item before this one, will
  join it.
- **Audit logs** (ADR 0081) record a change of the list as
  `policy.ai_endpoints_changed`, with the addresses before and after.

## Alternatives

- **Per workspace lists.** The requirement says "for the whole
  organization", and a workspace's owners already have the off switch.
  One list on the server is one thing to get right.
- **Matching by host alone.** One host may serve an approved model and a
  forwarder to a public one at another path; the path keeps them apart.
- **Approving models too.** An approved internal endpoint is the
  organization's own, and decides its models.
- **Relaying the desktop app's AI through the server.** The device would
  then send through the server even where the approved endpoint is on the
  device's own network, and an encrypted workspace's text would pass
  through a server that must never read it.
- **A setting of the `admin` feature.** It is a data policy, and belongs
  with the other policies an organization sets.

## Consequences

- An instance admin locks every workspace on the server to its approved
  endpoints in one place, or in the environment for an air-gapped
  install.
- People whose providers do not match see why, and which addresses are
  approved, before anything is sent.
- `/api/me` gains `aiEndpoints`; older apps ignore it, and are not locked.
- The `policies` module starts with this; its pages grow with data
  policies.

# 0070. The web app's AI goes through its server, which seals the keys and reaches only what it may

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)
brought AI to the desktop app, its providers kept on the device and their
keys in the system's keychain. It set the web app's course: its providers
kept on the user's own Nether server, per account and for the whole
instance, its requests relayed by that server, the workspace's switch
enforced there, and no AI in the web app for an end-to-end encrypted
workspace. This record settles how.

What the design must live with:

- **The web app's page cannot keep a secret from itself**, and its content
  security policy lets it reach its own origin alone
  ([ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)).
- **A relay is a request the server sends where someone said.** The server
  sits inside a network: its database, Valkey, a cloud's metadata at
  169.254.169.254 and the admin's other services are all a request away.
  Webhooks met this first
  ([ADR 0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md)):
  `outbound.ts` resolves a host when it sends, refuses every address that
  is not public unless the admin allows it with `NETHER_WEBHOOK_PRIVATE`,
  and connects to the address it checked. A webhook's answer is never
  read; a provider's answer must be, and goes back to whoever asked.
- **A local model is a legitimate target** when it runs beside the server,
  as Ollama in the same Compose project, but only an admin can say so.
- **The server has no secret of its own yet.** Its database and its backups
  hold everything it keeps.
- **An encrypted workspace's text never reaches the server**
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).

## Decision

### Providers on the server

The server keeps AI providers in `ai_providers`: a name, a kind (`openai`
or `anthropic`), an address and a model, as the desktop app does, and the
key sealed. Each is an account's own, or with no account the instance's,
which its admins set for everyone. An account's default is kept in
`ai_defaults`; without one, the instance's first provider is the default,
then the account's first.

- `GET /api/ai` gives the providers an account may use, the instance's
  first, never a key; whether the server keeps keys; and whether the
  account may add its own and the instance's.
- `POST /api/ai/providers` adds one, the account's own or, for an admin,
  with `"scope": "instance"`, everyone's. `PATCH` changes one, its key
  kept unless the change gives another or `null`. `DELETE` removes it.
  An account changes its own; only an admin changes the instance's.
- `PUT /api/ai/default` chooses the account's default.
- An account, and the instance, keep 20 providers at most.

### Keys sealed with the admin's key

`NETHER_SECRET_KEY` is 32 random bytes in base64, as `openssl rand
-base64 32` makes them. The server seals each key with it, AES-256-GCM
with a random nonce, bound to the provider's ID so a box moved to another
row does not open, and opens it only to send a request. No key is ever
given back. Without `NETHER_SECRET_KEY`, the server keeps no keys, and a
provider that needs none, as a local model, still works. A backup holds the
sealed keys and never the key that opens them: a server restored with
another `NETHER_SECRET_KEY` asks for the providers' keys again.

### The relay

The web app's adapter, `@nether/ai`, sends its calls to
`POST /api/workspaces/:workspace/ai/:provider/...` as it would to the
provider, on the page's own origin. The server:

- takes a signed-in account, with the session cookie and its CSRF value, at
  60 requests a minute;
- refuses an account outside the workspace, an end-to-end encrypted
  workspace, and a workspace whose owners or admins turned AI off;
- sends only the API's own calls, each kind's chat and embeddings paths,
  as `@nether/ai` names them: `/chat/completions` and `/embeddings`, or
  Anthropic's `/v1/messages`;
- sends the page's JSON with the provider's model in place of whatever the
  page asked for, and the key in the API's own header with Anthropic's
  version, and nothing else of the page's: not its cookie nor its session;
- resolves the provider's host when it sends, checks every address it
  resolves to, and connects to the one it checked, through `outbound.ts`,
  following no redirect;
- streams the provider's answer back as it comes, with its status and its
  type, `no-store`, up to 8 MB, for at most ten minutes, and two minutes
  for the answer to begin; the page going away ends the provider's request;
- logs nothing of what is sent or answered.

### What a provider may reach

- **An account's own provider is reached at public addresses alone, over
  https.** An address that is an IP is checked as the provider is kept, and
  every address a name resolves to is checked as each request is sent.
- **The instance's providers may also reach what `NETHER_AI_PRIVATE`
  allows**, with the same syntax as `NETHER_WEBHOOK_PRIVATE`: `on` for any,
  or addresses, ranges and `loopback`, `linklocal`, `uniquelocal`. Those
  may use `http://`, as a model beside the server does.
- `NETHER_AI_PRIVATE` is its own setting, not `NETHER_WEBHOOK_PRIVATE`: a
  webhook posts blind, while the relay reads the answer back to the person
  who asked, so allowing one does not allow the other.

### The admin's switch

`NETHER_AI` is `on` by default: accounts' own providers and the
instance's. `admin` leaves the instance's alone, as a server whose admin
chooses every provider. `off` turns AI through this server off: the web
app shows none, and the relay refuses. A hosted service, if one ever runs,
sets `admin` or `off`.

### The web app

- The settings' AI tab shows the server's providers, marking everyone's,
  with Edit and Remove where the account may change them, and to admins a
  choice of whose a new one is. Its hints say keys are kept on the server,
  sealed, and never shown again, or that the server keeps none.
- Writing assist says where the text goes first: "Sends the text through
  nether.example.org to Ollama, llama3.2 at ollama:11434."
- In an end-to-end encrypted workspace, the web app offers no AI, and the
  tab says why: its requests would go through the server. The desktop app
  still offers it there, with a provider chosen for it.
- The page's content security policy is unchanged.

## Alternatives

- **Sharing `NETHER_WEBHOOK_PRIVATE`.** One setting would open two kinds of
  request to the admin's network, and the relay reads what it reaches.
- **Letting an account's own provider reach `NETHER_AI_PRIVATE`'s
  addresses.** Any member could read what answers there, the admin's
  internal services among them. The admin's own providers are the admin's
  to point there.
- **Forwarding any path, or the page's headers.** A provider's other calls,
  and whatever the page's cookie carries, are not the relay's to send.
- **The page's model.** For the instance's providers, the admin chooses the
  model, and the bill.
- **A key generated by the server and kept in its database or volume.**
  Kept beside what it seals, it would seal nothing a stolen database or
  backup does not open. A key in the environment is where the admin keeps
  the server's other secrets.
- **Requests from the browser straight to providers**, which ADR 0068
  weighed: the policy would list each provider, each provider would have to
  allow the page's origin, and a key in the page is a key a script can read.

## Consequences

- The web app has AI on a server whose admin set `NETHER_SECRET_KEY`, or
  with providers that need no key; `docker compose up` alone gives it with
  none.
- A member's request costs the server one connection for as long as the
  answer streams; the rate limit and the time limits bound it.
- Changing `NETHER_SECRET_KEY` leaves the kept keys sealed with the old
  one: each provider's key is set again.
- The desktop app keeps its own providers on the device; offering it the
  server's too is left for later, through the same relay.
- The remaining parts of the item, asking your notes, building with AI and
  semantic search, use these providers in the web app through this relay.

# 0068. AI comes from the user's own provider, reached from their device, and shows nothing until there is one

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#ai-bring-your-own) ask, in Phase 4,
for AI the user brings:

- **Provider settings**: "User or admin configures an OpenAI-compatible
  endpoint, Anthropic, or a local model (Ollama, vLLM); keys are stored
  encrypted and never sent to Nether's servers".
- **Writing assist**: "Rewrite, summarize, translate, continue, fix grammar
  on a selection".
- **Ask your notes**: "Q&A over notes the user can access, citing source
  notes and blocks".
- **Build with AI**: "Generate a database schema, template or project plan
  from a description; the user previews before anything is created".
- **Off switch**: "AI features are hidden entirely when no provider is
  configured; admins can disable AI per workspace".
- **Semantic search**: "Optional; uses the configured AI embedding
  provider; off by default".

Principle 8 says Nether never ships a hard dependency on one AI vendor, and
principle 7 that nothing is sent anywhere unless the user opts in.

What the design must live with:

- **The desktop app's page reaches servers through Go**
  ([ADR 0036](0036-the-desktop-app-reaches-servers-through-go-and-keeps-tokens-in-the-keychain.md)):
  MyGO's fetch plugin makes requests outside the page's CORS, and streams
  each answer's body as Go reads it. Server tokens are kept in the system's
  keychain, and the page holds one in memory only while it uses it.
- **An encrypted workspace's text never reaches the server**
  ([ADR 0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md)).
- **The web app is the desktop page in the browser**
  ([ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)),
  served by the user's server with a policy whose `connect-src` is its own
  origin. A browser cannot keep a secret from its own page, and a local
  model at `http://localhost:11434` is on the machine that runs it, not on
  the machine of every browser that opens the web app.
- **Plugins reach the app only by messages**
  ([ADRs 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)
  and [0064](0064-a-plugin-reads-and-writes-notes-through-the-app-as-far-as-it-asked.md)),
  so AI could later be offered to them as calls the app answers.
- **The desktop app idles near its 300 MB budget**, so nothing of AI may
  load before it is set up and used.

The two APIs are documented by their providers. An OpenAI-compatible
endpoint takes `POST <base>/chat/completions` with `stream: true` and an
`Authorization: Bearer` key, and streams server-sent events, each a
`chat.completion.chunk` whose first choice's `delta.content` is the next
text, ending with `data: [DONE]`; `POST <base>/embeddings` gives vectors.
Ollama, vLLM, LM Studio and llama.cpp's server answer the same way, at
`http://localhost:11434/v1` for Ollama. Anthropic's Messages API takes
`POST /v1/messages` with the key in `x-api-key` and the API's version in
`anthropic-version`, and streams named events: `message_start`, each
block's `content_block_start`, `content_block_delta`s and
`content_block_stop`, `message_delta` with the stop reason, and
`message_stop`, with `ping`s and an `error` event possible anywhere.
Anthropic offers no embeddings; its documentation points to other
providers for them.

## Decision

### One interface, two adapters, over fetch

`@nether/ai` gives one interface, `Provider`: `chat(request)`, the reply's
text piece by piece as it streams, and `embed(request)`, one vector a text.
`createProvider(config, access)` makes one from its settings (a kind, an
address and a model) and its access (the `fetch` to send with, and the
key, if any).

- **`openai`**, for any OpenAI-compatible endpoint, at the address the
  user gives with its version, as `https://api.openai.com/v1`. A key goes
  as `Authorization: Bearer`, and none goes for a local model without one.
- **`anthropic`**, for the Messages API, at `https://api.anthropic.com`,
  with `anthropic-version: 2026-10-21`, the version Anthropic documents
  now. Text is taken from `text_delta`s; thinking blocks and event types
  the reader does not know are passed over, as Anthropic's guide asks.
  `embed` fails with an error that says to choose an OpenAI-compatible
  provider for embeddings.
- **Both read server-sent events** with one reader of the HTML standard's
  format, which takes LF, CRLF and CR and any chunk boundary. Both take a
  whole JSON answer too, from a server that does not stream, and both turn
  an error, sent as a status or in the stream, into an `AiError` with the
  provider's own message and a kind the app words itself: `network`,
  `http`, `stream`, `refused`, `response` or `unsupported`.
- **No vendor's SDK.** Each adapter is a request and a reader of its
  stream, about a hundred lines, tested against streams written as each
  provider's documentation shows them.
- **No model names are built in.** The user types the model, as the
  provider names it; the fields' hints give examples. Requests carry no
  sampling settings, which models differ on and Anthropic's current API
  version refuses. Anthropic needs a reply's limit, and gets 16,000 tokens,
  room for a model that thinks first; an OpenAI-compatible endpoint gets
  none, so its default holds.

### The desktop app keeps providers on the device, their keys in the keychain

A Go service, `AI`, keeps the providers set up on this device in `ai.json`
beside `servers.json`: each one's ID, name, kind, address, model, and
whether it has a key. Its key is kept in the system's keychain under
`ai <id>`, through `mygo.Secrets`, as server tokens are: encrypted for the
user by the Keychain, the Credential Manager or the Secret Service, never
in a file or a vault. The first provider set up is the default.

The page reads a key from the keychain when it sends a request, and does
not keep it. Go's fetch, already in the app for servers, sends the
request, so any address works, `http://localhost` included, with no CORS
and no change to any policy.

### The web app keeps keys on its server, in part two

The web app comes in part two, and the record settles its course now. Its
providers are kept on the user's own Nether server, and its requests go
through that server, which adds the key and streams the reply back:

- the user's own server is the user's; "Nether's servers" are a service
  the project would run, and a hosted service, if one ever exists, turns
  the server-kept providers off;
- the server keeps each key encrypted with a key from its environment, and
  never gives it back to a page;
- the page's policy stays its own origin, and no provider needs to allow
  the browser's origin, or a page to send Anthropic's header for direct
  browser access;
- a local model beside the server, as Ollama in the same Compose project,
  serves every browser;
- an instance admin can set providers for everyone, and part two's server
  can lock AI to them, which Phase 5 asks of enterprise installs;
- an end-to-end encrypted workspace gets no AI in the web app, since every
  request there goes through the server that must never read its text.

### Which provider a vault uses

A vault uses this device's default provider, one chosen for it, or none,
in Settings, AI. That choice is kept in the vault's index on this device,
outside its folder, so it does not sync.

A vault of an end-to-end encrypted workspace uses none until the user
chooses one for it: the default is not enough. The tab says why, and that
a provider on this computer keeps its text here. Providers on this
computer are named so ("llama3.2 on this computer"); the others by their
host ("claude-sonnet-5-5 at api.anthropic.com").

### The off switch

- **Nothing of AI shows until the vault has a provider.** Writing assist's
  command is added to the menus, the palette and the shortcuts only then,
  and goes when the vault has none again. The AI tab of the settings is the
  one place AI shows before, as that is where it is set up.
- **A workspace's owners and admins turn AI off for it.** The server keeps
  `ai` for each workspace, on until changed; `PATCH /api/workspaces/:id`
  with `{"ai": false}` changes it, for owners and admins only, and
  `/api/me` gives it with each workspace. The AI tab shows the switch to
  owners and admins, and to others that it is off.
- **Every app honors it.** The desktop app asks the server when the vault
  opens, once a provider is set up, and again before each request, so a
  switch turned off is heard before anything more is sent. It keeps the
  last answer in the vault's index for when the server cannot be reached.
  The switch keeps Nether's apps from sending a workspace's text; it cannot
  stop a member's device from sending its synced files by other means. In
  part two, the server also refuses to relay AI for a workspace that has it
  off.

### Privacy

- Nothing is sent until the user asks for a result. Writing assist names
  the provider, its model and where it runs before any action is chosen.
- Only what the user selected goes, with an instruction; nothing else of
  the note or the vault.
- No telemetry: Nether records nothing of what is sent or received.

### Loading

Reading the providers is one call to the Go service as a vault opens, and
the workspace's server is asked only once a provider is set up. The
adapters, the AI tab and writing assist load the first time they are used,
in chunks of their own.

### The parts

The item is delivered in five parts, each from `main` after the one
before it merges, except the fifth, which needs only the first and is made
beside the others
([ADR 0074](0074-search-by-meaning-keeps-passages-vectors-on-the-device-and-loads-them-only-to-search.md)):

1. **This part**: `@nether/ai`, providers on the desktop, the off switch for
   vaults and workspaces, and writing assist
   ([ADR 0069](0069-writing-assist-streams-into-a-preview-and-goes-in-as-one-edit.md)).
2. **The web app**: providers kept on the user's server, per account and
   for the whole instance, requests relayed by it, the switch enforced
   there, and the AI tab and writing assist in the web app.
3. **Ask your notes**: questions answered from the notes found by the
   vault's own search, which holds only what the user can open, each
   answer citing its notes and blocks as links that open them.
4. **Build with AI**: a database's schema, a template or a project plan
   from a description, made as an import plan
   ([ADR 0027](0027-imports-are-plans-made-from-sources-read-only.md)) that
   the user previews before anything is made.
5. **Semantic search**: embeddings of each note's passages in the vault's
   index, from a provider's embedding model the user chooses, off by
   default, and a search by meaning beside the search by words.

AI for plugins, as `context.ai` with a permission of its own, can follow:
the app would send for a plugin, naming it, and a plugin would never get a
key.

## Alternatives

- **A vendor's SDK for each API.** Each would be a dependency on that
  vendor, a size in the bundle, and a second way to stream; a request and
  a reader of its events is all either API needs.
- **Only an OpenAI-compatible adapter, with Anthropic through a gateway.**
  The requirements name Anthropic, and a gateway is another server the user
  would have to run.
- **Requests from Go, with the key added there, never in the page.** The
  page already holds server tokens while it uses them, and nothing that runs
  in the page and could read one could not also read the vault itself;
  plugins from a vault run in a sandboxed frame without the bridge
  ([ADR 0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md)).
  It would need a streaming Go service of its own.
- **Keys in the browser for the web app, sent straight to providers**,
  encrypted with a key the server never sees. The page that decrypts them
  is the page a script would read them from; every provider would have to
  allow the browser's origin, Anthropic only with a header for direct
  browser access; the admin would have to add each provider's origin to the
  policy; and a local model would work only on the machine that runs it.
  It would keep an encrypted workspace's text from the server, which part
  two may reconsider for encrypted workspaces, with origins an admin lists.
- **The default provider for encrypted workspaces too.** Their text would
  go to a provider no one chose for them, as the server that relays their
  updates never reads it.
- **A command that shows, greyed, until a provider is set up.** The
  requirement asks that AI be hidden entirely.

## Consequences

- A provider set up on one computer is not on another; each device keeps
  its own, as it keeps its servers' sessions.
- On a Linux desktop without a Secret Service, as with servers, a provider
  that needs a key cannot be kept; a local model without a key works.
- A user who has turned AI on sees every request named before it goes, and
  can turn it off for a vault in one choice.
- The workspace's switch is an instruction to Nether's apps, which every
  app honors; it is no barrier to a member who copies notes elsewhere.
- The server's schema gains a column, `workspaces.ai`, on by default; a
  server from before it is taken as having AI on.
- If Anthropic's current API version is refused by a gateway that speaks
  its API, the version can become a provider's setting.

# @nether/integrations

The services the person's connections reach, and the rules every request
through the app keeps for a plugin
([ADR 0090](../../docs/adr/0090-integrations-are-built-in-plugins-that-run-apart-and-reach-each-service-through-a-connection-the-app-keeps.md)).
The desktop page sends its plugins' requests with them through Go's
fetch; the server's relay will keep the same rules.

- `readAddress(text, http)` reads an address the person typed: `webcal:`
  as `https:`, `http:` only where the device allows it, a host, and no
  user or password in it.
- `feedConnection(input)` makes an ICS feed's connection, shown by its
  host alone, its whole address kept as its secret, and
  `checkConnection(...)` checks one before the app keeps it.
- `readPluginRequest(value)` checks a request as a plugin sent it: a
  method of the API's, no header only the app sets, a body of 1 MB at
  most. `sendRequest(options)` sends it with the connection's credential,
  only to the connection's origins, follows at most five redirects it
  allows, and gives back the status, the headers a plugin needs and up to
  20 MB of the answer, in a minute at most. Its errors name an origin,
  never a feed's secret address.

A plugin never sees a credential: `KeptConnection` is what the app keeps
in the open, `ConnectionSecret` what it keeps in the keychain, and
`shownConnection` what a plugin is given.

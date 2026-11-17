# 0074. Search by meaning keeps each passage's vector on the device, and loads them only to search

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#search) ask for semantic search:
"optional; uses the configured AI embedding provider; off by default".
[ADR 0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)
brought AI from the user's own provider, reached from their device, with
`embed(request)` giving one vector a text from an OpenAI-compatible
endpoint; Anthropic has no embeddings. Its fifth part is this one:
embeddings in the vault's index, from an embedding model the user
chooses, off by default, and a search by meaning beside the search by
words.

What it must live with:

- **Memory.** The desktop app idles under 300 MB on 50,000 notes, at about
  288 MB now. An embedding is 384 to 3,072 numbers. At 1,536 numbers of 4
  bytes, one vector is 6 KB, and 150,000 of them, three to a note, would
  be 900 MB.
- **Speed.** A search by words answers in under 300 ms on 50,000 notes.
- **Who reads the text.** A vault's text goes only to a provider the user
  chose for it, and to none while AI is off for the vault or its
  workspace, or while the workspace is end-to-end encrypted and no
  provider was chosen for it.
- **Cost.** Each text embedded is a request the provider may charge for.

## Decision

**Search by meaning is off until it is turned on, for one vault, on this
device.** The AI tab of the settings turns it on: an OpenAI-compatible
provider of this device, and the embedding model to ask, as the provider
names it (`text-embedding-3-small`, `nomic-embed-text`). The choice is
kept in the vault's index on this device, outside its folder, as the
vault's AI choice is, so it does not sync. Choosing a provider here gives
it the vault's text, as choosing one for an encrypted vault does. While
AI is off for the vault, or its workspace's owners turned it off, search
by meaning is off too, and sends nothing.

**A note is embedded as passages.** A passage is the text under one of
the note's headings, as the outline shows them, or before the first, cut
at the end of a paragraph once it passes about 1,000 characters, and
within a paragraph of more than 2,000 at the end of a sentence. The text
embedded starts with the note's title and the passage's headings, as
`Title > Heading > Subheading`, so a passage keeps what it is about. A
passage is found again by its note and its place in it, and shown with
its heading, which opens the note there.

**The vault's index keeps each passage's vector small.** A vector is made
unit length, then kept as one byte a number, scaled by its largest, with
its signs as one bit a number beside it: 1,728 bytes a passage at 1,536
numbers. Each passage keeps a hash of its text, so a note that changes
sends only its changed passages again. The model and its number of
dimensions are kept with them; choosing another model drops them all.

**Nothing of it is in memory until a search by meaning runs.** A search
embeds what was typed, one request, then reads every passage's signs from
the index and ranks them by how many signs differ from the query's, then
reads the vectors of the closest 200 and ranks those by their cosine with
the query. On 150,000 passages the signs are 29 MB, held while searches
follow each other and let go two minutes after the last; a vault of 2,000
notes holds about 1 MB. Each note is listed once, with its closest
passage, at most 50.

**A search by meaning runs when Enter is pressed**, not as each letter is
typed, since each one asks the provider. The search panel shows **By
words** and **By meaning** while search by meaning is on for the vault.
Filters by tag, path and property apply to both.

**The vault is embedded in the background.** While search by meaning is
on and the vault is open, the app compares each note's file with the one
its passages were made from, as the link index does, reads the notes that
changed, and embeds their changed passages, 64 to a request, one request
at a time. A note deleted drops its passages. It stops when the vault
closes or the switch goes off, and goes on from where it was. The AI tab
shows how far it is, and a provider's error, after which it tries again a
minute later.

**Asking your notes can use it.** The passages closest to a question come
from one function, with their notes and headings, for the item's third
part to cite.

**The desktop app has it first.** The web app's index lives in the
browser, and its AI goes through the user's server from the item's second
part; it gets search by meaning on the same index methods after that
part.

## Alternatives

- **A vector for each block**, as ADR 0068 first said. Most blocks are a
  line, too short to carry a meaning of their own, and a vault has many
  times as many blocks as passages: 50,000 notes of twenty blocks would be
  a million requests' worth of text cut into pieces.
- **Vectors as 4-byte numbers, all in memory.** 900 MB on 50,000 notes.
- **A vector index, such as HNSW.** It is built and held in memory, and is
  for millions of vectors. Signs first, then 200 vectors, rank 150,000
  passages in tens of milliseconds.
- **SQLite's vector extensions.** MyGO's SQLite plugin loads none, and the
  web app's index is not SQLite.
- **Embeddings on the server.** An encrypted workspace's server cannot
  read its text, and a vault with no server would have none.
- **One ranking of words and meaning together.** Each is clear on its
  own; mixing them can come once both are used.

## Consequences

- Turning it on sends the whole vault's text to the provider once, and
  each changed passage after. The AI tab says so before it is turned on.
- The index grows by about 1.7 KB a passage at 1,536 numbers.
- Idle memory does not change: the signs load for a search, and go after.
- ADR 0068's parts are made in its order except this one, which needs only
  its first part, and is made beside the others.

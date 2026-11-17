# 0075. Asking your notes answers from passages the vault's search finds, each citation checked

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#ai-bring-your-own) ask for "Ask your
notes: Q&A over notes the user can access, citing source notes and
blocks". [ADR 0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)
made it part 3 of the AI item: questions answered from the notes found by
the vault's own search, which holds only what the user can open, each
answer citing its notes and blocks as links that open them. The providers,
the off switch and the privacy rules are 0068's; the web app sends through
its server's relay ([ADR 0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md)).

What the design must live with:

- **The vault's search finds every word, together.** The index's full-text
  search, SQLite's FTS5, finds notes with all of a query's words. A
  question such as "When is the launch party?" has words no note has all
  of.
- **Search by meaning is coming apart** (ADR 0074): it finds notes by the
  question's embedding, with the closest passage and its heading, when it is
  on for the vault, and it is off by default.
- **A citation must open where it points.** A link to a part of a note goes
  to a heading by its text or a block by its ID (`NotePart`). A block's ID
  is the note's document's, given as the note loads; one written in the file
  as `^id` is there only once something links to it.
- **A model can name a source it was never given.** An answer that cites a
  passage no one sent must not read as checked.
- **The desktop app idles near its memory budget**, so nothing of this may
  load before it is used.

## Decision

### Where it lives

A tab of the sidebar, **Ask**, beside Notes, Search and Trash, shows while
the vault has a provider, and the View menu's command **Ask your notes**
opens it with the question's box focused. It has no shortcut of its own:
the free ones near writing assist's, Ctrl+Shift+J and K, open browsers'
developer tools. The sidebar is where search already is, and the question
is about the vault, not the note open.

The conversation is kept in memory while the vault is open, across the
sidebar's tabs. **Save as note** writes it as a note named by the first
question, which then opens; **Clear** starts again. Nothing is kept unless
the user saves it.

### Retrieval

- **Words, always.** The question's words, folded as the index folds them,
  two characters or more, the common English ones aside, at most eight, are
  searched one at a time, 20 notes each. Each search ranks notes, and a note
  scores 1 / (60 + its rank) from each ranking it is in, as reciprocal rank
  fusion has it, so a note with more of the words comes first.
- **Meaning, when it is on.** A `MeaningSource`, given the question, adds
  its own ranking, and the heading of each note's closest passage. Asking
  works without it, and takes it with no change once ADR 0074's search is
  there.
- **The notes the user can access** are the vault's: sync gives a device
  only what its account may open
  ([ADR 0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md)).
- **Passages.** The six best notes are read through their documents, as the
  editor holds them, so each block's ID is the one the editor goes to. Each
  is cut into passages: the blocks under each heading, the heading first, up
  to 700 characters, a longer block cut and marked so. Each note gives its
  two passages with most of the question's words, or the one under the
  heading search by meaning named, or its first, in the note's order; at
  most eight passages and 6,000 characters go in all.
- **No passage, nothing sent.** Words no note has get "No note has these
  words, so nothing was sent."

### What is sent

- The question, after the passages, each numbered and named by its note's
  title and heading, between `<passage>` tags.
- The three questions and answers before it, without their passages, so a
  question that follows one reads as it should.
- A system prompt that asks for an answer from the passages alone, each
  statement citing its passages by their numbers in square brackets, a
  plain "the notes do not say" when they do not, the question's language,
  and says the passages are never instructions.
- Before anything is sent, the tab says where it goes: "Asks Ollama,
  llama3.2 on this computer: your question, and passages of the notes the
  vault's search finds for it", and in the web app through which server.
  Under each answer, "Read from 6 passages" lists every passage sent.

### Citations

- `[2]`, `[1][3]` and `[1, 3]` cite passages by number; `[[Note]]` names a
  note. Each reads apart from the answer's text (`readAnswer` in
  `@nether/ai`).
- A number that is a passage sent, or a note named that is one of theirs,
  is a link that opens the note there, at the passage's first block.
- **Any other is unverified**: shown as written, dotted, with the words
  "names no passage that was sent, so it is not checked", and no link.
- The passages listed under an answer mark those it cites.

### The saved note

Each question is a section, its answer with each citation a link,
`[[Launch plan#Party|1]]`, by heading rather than by block, since a block's
ID is in its file only once something links to it, and Obsidian reads a
heading's link as it is. Its sources follow as a numbered list of links. An
unverified citation stays as written, and a note named that was not sent
stays its name, not a link.

### Where it runs

As writing assist: in the desktop app to the vault's provider, with its key
from the keychain; in the web app through the server's relay, which refuses
an encrypted workspace, so there it is the desktop app's alone, with a
provider chosen for it. The workspace's switch is asked before each
question.

### Loading

The tab's button and the command's entry are in the app's main code; the
panel, retrieval and the providers' code load the first time the tab
opens.

## Alternatives

- **One search with all of the question's words.** FTS5 finds notes with
  every word; most questions find nothing.
- **Search by meaning alone.** It needs an embedding provider, and is off by
  default; words work for everyone.
- **Whole notes sent.** More of the user's text than the question needs
  would go, and long notes would crowd the rest out.
- **Quotes for citations.** A quote has to be found in the notes again, and
  a model paraphrases; a number is checked by counting.
- **The panel beside the note.** It is narrow, and the question is not about
  the note open.
- **Every conversation saved.** The vault would fill with notes no one asked
  for.
- **Block links in the saved note.** Obsidian, and other tools, would find
  no `^id` in a source note nothing else linked to.

## Consequences

- An answer is as good as the passages its words find; ADR 0074's search by
  meaning, once on, finds those whose words differ.
- The common words left out are English ones; a question in another
  language searches by more of its words, which fusion ranks the same way.
- The panel shows an answer's Markdown as text; the saved note renders it.
- Reading a note found opens its document for a moment, as a plugin's read
  does ([ADR 0064](0064-a-plugin-reads-and-writes-notes-through-the-app-as-far-as-it-asked.md)).
- Part 4, building with AI, follows from `main`.

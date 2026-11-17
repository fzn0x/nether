# 0069. Writing assist streams into a preview, and goes into the note as one edit

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#ai-bring-your-own) ask for writing
assist: "Rewrite, summarize, translate, continue, fix grammar on a
selection". [ADR 0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)
says where its requests go, and that nothing of it shows until the vault
has a provider.

A note open in the editor is bound to its Yjs document
([ADR 0043](0043-a-note-open-in-the-editor-syncs-live-with-awareness-for-carets.md)):
others' edits arrive while a reply streams in, and the editor's undo
history is the Yjs one, which merges edits made within half a second.
Comments already hold a range of a note as Yjs relative positions, which
follow its text through everyone's edits
([ADR 0044](0044-a-notes-comments-are-a-document-of-their-own-beside-it.md)),
and show a new thread's draft beside the note with its text highlighted.

A model's reply is text the user has not read. It may be wrong, it may be
long, and it may carry formatting the note should keep.

## Decision

**The command.** Writing assist, Ctrl or Cmd and J, is
in the Note menu and the palette while the vault has a provider, for a
note shown as blocks that this person may edit. It works on the
selection, or with nothing selected the block the caret is in, as
comments do.

**Beside the note.** The assist opens at the top of the panel beside the
note, where a new comment's draft opens, and the text it works on stays
highlighted in the note while it shows. It says where the text goes,
"Sends the text to Ollama, llama3.2 on this computer.", before anything is
sent, and quotes the text. Its actions:

| Action | What the model is asked | Where the reply goes |
| --- | --- | --- |
| Rewrite | Rewrite it, keeping its meaning and language, in a way the user may describe | In its place |
| Fix grammar | Fix spelling, grammar and punctuation, nothing else | In its place |
| Summarize | A few sentences, in its language | After it |
| Translate | Into a language the user names, the app's by default | In its place |
| Continue writing | A paragraph or two more, in its voice | After it |

**What is sent.** The text, as the note's Markdown writes it, after the
instruction and between `<text>` tags, with a system prompt that asks for
Markdown only, keeps links, tags and math, and says the text is never
instructions. Nothing else of the note or the vault goes.

**The preview.** The reply streams into the panel as it comes. Stop ends
it; then Replace, Insert below, Try again or Discard, the button for where
the action's reply goes shown as the main one. Escape discards. A
provider's error shows in the provider's words, named; a refusal says the
provider declined. Before each request the app asks the workspace's server whether
AI may run, and reads the key from the keychain.

**Into the note as one edit.** The editor gives the app the text's anchor,
Yjs relative positions as a comment's, and a function that puts blocks
there:

- the reply's Markdown is parsed as the note's own, so its links, tags and
  formatting are the note's;
- one paragraph or heading for text inside one block takes the text's
  place in that block, so a heading worked on stays a heading;
- other replies replace the text with their blocks, or go after the block
  the text ends in;
- it is one transaction of the editor, with the undo history's capture
  stopped before and after it, so one undo takes it out, and typing just
  before it stays;
- it reaches the note's document as typing does: an editor open elsewhere
  shows it, sync sends it, and the note's history keeps what was there;
- where the text is gone, as when someone deleted it while the reply
  streamed, nothing is put in, and the panel says so.

## Alternatives

- **A menu over the selection.** The editor has none to build on; the
  panel beside the note is where comments already draft, and a reply needs
  room to be read before it goes in.
- **Putting the reply in as it streams, to undo if unwanted.** Others would
  see text no one had read, and sync would send each piece.
- **Replacing the selection by its offsets at the time of the request.**
  Edits made while the reply streams would move the text, and the reply
  would land in the wrong place.
- **Plain text in and out.** A selection's lists, links and emphasis would
  be lost on the way back.
- **The whole note as context.** More of the user's text would go to the
  provider than they selected; a later part may offer it, said so first.

## Consequences

- A long reply is read in a narrow panel; it scrolls.
- Source mode has no writing assist yet; it works on blocks.
- A model that ignores the instructions and talks about the text instead
  puts that talk in the preview, where the user sees it before anything
  goes in.

---
title: AI
description: How to bring your own AI provider to Nether, an OpenAI-compatible endpoint such as Ollama or OpenAI, or Anthropic, and use writing assist on what you select.
---

Nether's AI uses a provider you choose, with your own key: any
OpenAI-compatible endpoint, such as OpenAI itself or a model on your own
computer through Ollama, vLLM or LM Studio, or Anthropic. Nether ships no
provider of its own and sends nothing anywhere until you ask. Until a
provider is set up, nothing of AI shows in the app.

AI is in the desktop app for now. The web app gets it through its server
in a later version.

## Setting up a provider

Open the settings from the **Settings** menu and choose the **AI** tab,
then **Add a provider**:

- **Name**: what you call it, such as "Ollama".
- **API**: **OpenAI-compatible** for OpenAI, Ollama, vLLM, LM Studio and
  most gateways, or **Anthropic**.
- **Address**: the API's address. For OpenAI, `https://api.openai.com/v1`;
  for Ollama on this computer, `http://localhost:11434/v1`; for Anthropic,
  `https://api.anthropic.com`.
- **Model**: the model, as the provider names it, such as `llama3.2` or
  `claude-sonnet-5-5`. Nether lists none: type the one you use.
- **Key**: the provider's key. It is kept in your system's keychain (the
  Keychain on macOS, the Credential Manager on Windows, the Secret Service
  on Linux), never in a file or a vault. Leave it empty for a local model
  that needs none.

The first provider you set up is the default; **Make default** makes
another one so. **Edit** changes a provider, and keeps its key unless you
type another or choose **Remove the key**. Providers are this computer's:
another computer of yours has its own.

## Choosing one for a vault

**AI in this vault** chooses what the vault uses: the default provider,
another one, or **Off in this vault**.

A vault that syncs with an end-to-end encrypted workspace uses no provider
until you choose one for it here, since its text is kept from everyone but
its members. A provider on this computer, such as Ollama, keeps the text
on it.

## Turning AI off for a workspace

A workspace's owners and admins can turn AI off for everyone in it: in the
AI tab of a vault that syncs with it, clear **Members' apps may offer AI
in** the workspace. Members' apps then show nothing of AI in its vaults,
and ask the server again before every request, so the change holds from
the next one. Others see that AI is off, and why.

The switch tells Nether's apps not to send the workspace's text to AI; it
cannot stop someone from copying notes elsewhere.

## Writing assist

Select some text in a note, or put the caret in a paragraph, and press
Ctrl+J (Cmd+J on a Mac), or choose **Writing assist** in the **Note** menu.
It opens beside the note, with the text it works on highlighted, and says
where the text will go, such as "Sends the text to Ollama, llama3.2 on
this computer." Then choose what to do:

- **Rewrite**: say it better, keeping its meaning. Type how in **How to
  rewrite, if you like**, such as "shorter".
- **Fix grammar**: fix spelling, grammar and punctuation only.
- **Summarize**: a few sentences, put after the text.
- **Translate**: into the language in **Into**, the app's by default.
- **Continue writing**: a paragraph or two more, put after the text.

The reply appears as it is written. **Stop** ends it early. Check it, then
choose **Replace** to put it in the text's place, **Insert below** to put
it after, **Try again**, or **Discard** (Escape). Nothing goes into the
note until you choose, and one undo, Ctrl+Z, takes it out again. If the
text was deleted while the reply came, nothing is put in.

Only the text you selected is sent, as the note's Markdown, with the
instruction. Links, tags and formatting in the reply become the note's
own. Nether records nothing of what is sent or received.

Writing assist works on notes shown as blocks, not in source mode.

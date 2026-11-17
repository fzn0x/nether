---
title: What Nether is
description: The workspace Nether is building, the principles it follows, and what is free.
---

Nether is an open-source workspace that combines Obsidian's local-first,
linked notes with Notion's databases and collaboration. Notes are plain
Markdown files you own; the same notes can become databases, wikis and
shared projects, without depending on anyone's cloud.

## Principles

When two of these conflict, the higher one wins.

1. **You own your data.** Every note exports as standard Markdown with YAML
   frontmatter, with its attachments, at any time and with no loss of text.
   Databases export to CSV and Markdown.
2. **Local first, server optional.** The desktop app works fully offline
   with no account. A server adds sync, collaboration, sharing and
   publishing, and is never needed for writing.
3. **Self-hosting comes first.** One `docker compose up` starts a working
   server, and any hosted service runs the same code.
4. **Fast on large workspaces.** Opening the app, switching notes and
   searching stay fast at 50,000 notes.
5. **Structure is optional.** A note starts as plain writing; properties,
   database views and templates come when you want them.
6. **Extensible.** Nether's own features use the same plugin API as
   everyone else's, wherever practical.
7. **Private by default.** No telemetry unless you opt in, and end-to-end
   encryption for sync.
8. **Bring your own AI.** Any OpenAI-compatible endpoint, Anthropic, or a
   local model, configured by you; Nether depends on no AI vendor.

## Everything is free

Nether is licensed under the
[AGPL-3.0-or-later](https://github.com/fzn0x/nether/blob/main/LICENSE). The
desktop app, the self-hosted server and every feature, enterprise features
such as single sign-on and audit logs included, are free. There are no paid
editions, no license keys and no seat limits, and nothing phones home.

## Where it stands

Four of Nether's six phases are done. The desktop app keeps a vault of
Markdown notes with the block editor, links and backlinks, tags, search,
templates and export, and turns notes into databases with six views,
relations, rollups and formulas, with the graph, the canvas, themes, and
importers from Obsidian, Notion, Logseq, HTML and CSV. A server you
[start with one `docker compose up`](../self-hosting/) syncs it, with
end-to-end encryption, spaces and sharing, co-editing, comments and
mentions, history and backups, and serves the web app.

Version 0.1.0, the first public release, with sync and the server, is
ready to [install](../install/). The fifth phase, the platform,
is under way: the [plugin API](../plugins/) is done, and Nether's own
diagrams, panels, canvas, graph and database layouts are built-in plugins
on it. Plugins from a vault run in a sandbox, with only what each device
approved for them, and plugins and themes install from Nether's
directory. The server's [REST API](../api/) reads and writes notes,
databases and search for scripts, with personal access tokens, and its
webhooks tell other services when notes change; the app makes both. The
[web clipper](../clipper/) saves pages and selections from Chrome and
Firefox as Markdown.
[PDFs](../pdfs/) open in a view of their own and in the notes that embed
them, their words or areas highlighted and commented on, each highlight
Markdown that Obsidian reads. [Writing assist](../ai/) rewrites, fixes,
summarizes, translates or continues what you select, with an AI provider
you bring. [Share links](../servers/#share-links) open a page to anyone
with one, with no account, to read, to comment on or to edit. A page or a
folder [publishes](../publishing/) as a site the server draws for anyone,
its links only between its own pages. The
[roadmap](../roadmap/) lists what each phase delivers.

The full requirements, the architecture and the decision records live in
the [repository](https://github.com/fzn0x/nether/tree/main/docs).

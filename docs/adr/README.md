# Architecture Decision Records

Each significant decision gets a record here: `NNNN-title.md`, numbered in
order, with its context, the decision, the alternatives considered and the
consequences. A record is never rewritten to change its decision; a newer
record supersedes it and says so. Start a new one from
[template.md](template.md).

| Record | Decision | Status |
| --- | --- | --- |
| [0001](0001-license-agpl-and-dco.md) | License the whole repository under the AGPL-3.0-or-later, with the DCO | Accepted |
| [0002](0002-editor-tiptap.md) | Edit notes with TipTap, and convert Markdown through our own syntax tree | Accepted |
| [0003](0003-sync-yjs-hocuspocus.md) | Sync notes as Yjs documents through Hocuspocus, and keep Markdown files in step | Accepted |
| [0004](0004-desktop-on-mygo.md) | Build the desktop app on MyGO, with the shared UI in a web page | Accepted |
| [0005](0005-server-on-fastify.md) | Run the server on Fastify | Accepted |
| [0006](0006-markdown-file-format.md) | Write notes as Obsidian-flavored Markdown, and mark Nether's own blocks with HTML | Accepted |
| [0007](0007-vault-folder-and-local-index.md) | Keep a vault's ID in its folder and its index with the app | Accepted |
| [0008](0008-allow-mit-0.md) | Allow MIT-0 among the permissive licenses | Accepted |
| [0009](0009-math-code-and-diagrams.md) | Render math with KaTeX, code with lowlight, and diagrams with Mermaid without ELK | Accepted |
| [0010](0010-vault-files-in-notes.md) | Serve a vault's media to the page from a loopback server, and find files as Obsidian does | Accepted |
| [0011](0011-templates-and-periodic-notes.md) | Fill templates with Obsidian's variables, and start from Obsidian's settings | Accepted |
| [0012](0012-export-from-the-page.md) | Export notes from the page's own HTML, and let the app write the files | Accepted |
| [0013](0013-pages-in-the-folder-beside-a-note.md) | Keep a page's pages in the folder beside it with its name | Accepted |
| [0014](0014-load-a-vaults-links-lean-and-after-its-note.md) | Load a vault's links lean, and after the note it opens to | Accepted, partly superseded by 0016 and 0017 |
| [0015](0015-check-accessibility-and-lay-out-by-direction.md) | Check every screen with axe, and lay out by direction, not by side | Accepted |
| [0016](0016-find-backlinks-by-the-names-links-write.md) | Find backlinks by the names links write | Accepted |
| [0017](0017-measure-performance-before-each-gate-not-in-ci.md) | Measure performance before each phase's gate, not in CI | Accepted |
| [0018](0018-a-database-is-a-note-with-an-obsidian-base-beside-it.md) | A database is a note, with an Obsidian base beside it | Accepted |
| [0019](0019-relations-are-links-both-ways-and-rollups-are-worked-out.md) | Relations are links, kept both ways, and rollups are worked out | Accepted |
| [0020](0020-formulas-in-a-language-nether-reads-and-runs-itself.md) | Formulas in a language Nether reads and runs itself | Accepted |
| [0021](0021-query-blocks-are-obsidian-bases-in-a-code-block.md) | Query blocks are Obsidian bases in a code block | Accepted |
| [0022](0022-a-database-exports-to-csv-as-its-view-shows-it.md) | A database exports to CSV as its view shows it | Accepted |
| [0023](0023-synced-blocks-are-block-embeds-edited-in-place.md) | Synced blocks are block embeds, edited in place | Accepted |
| [0024](0024-unlinked-mentions-found-by-the-index-and-linked-where-written.md) | Unlinked mentions are found by the index and linked where written | Accepted |
| [0025](0025-graph-view-with-sigma-and-forceatlas2-in-a-worker.md) | The graph view with Sigma, laid out by ForceAtlas2 in a worker | Accepted |
| [0026](0026-themes-and-snippets-are-css-files-of-the-vault.md) | Themes and snippets are CSS files of the vault | Accepted |
| [0027](0027-imports-are-plans-made-from-sources-read-only.md) | Imports are plans, made from sources only read | Accepted |
| [0028](0028-a-notion-export-becomes-pages-and-databases-without-ids.md) | A Notion export becomes pages and databases without their IDs | Accepted |
| [0029](0029-a-logseq-graph-keeps-its-folders-and-is-written-as-obsidian-writes.md) | A Logseq graph keeps its folders, and is written as Obsidian writes | Accepted |
| [0030](0030-web-pages-import-through-the-syntax-tree-tools.md) | Web pages import through the syntax-tree project's HTML tools | Accepted |
| [0031](0031-the-server-keeps-its-data-in-postgresql-and-is-set-up-with-a-code-from-its-log.md) | The server keeps its data in PostgreSQL, and is set up with a code from its log | Accepted |
| [0032](0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md) | Sessions are bearer tokens kept as hashes, and accounts come by invitation | Accepted |
| [0033](0033-sign-in-by-email-with-a-code-and-the-link-with-the-web-app.md) | Sign in by email with a code now, and with a link once the web app can open one | Accepted |
| [0034](0034-sign-in-with-openid-connect-through-the-server-and-back-to-the-app.md) | Sign in with OpenID Connect through the server, and hand the session back to the app | Accepted |
| [0035](0035-the-server-syncs-through-hocuspocus-beside-its-api-and-numbers-each-store.md) | The server syncs documents through Hocuspocus beside its API, and numbers each store | Accepted |
| [0036](0036-the-desktop-app-reaches-servers-through-go-and-keeps-tokens-in-the-keychain.md) | The desktop app reaches servers through Go, and keeps their tokens in the system's keychain | Accepted |
| [0037](0037-a-vault-syncs-through-a-document-of-its-paths-and-its-notes-documents.md) | A vault syncs through a document of its paths and its notes' documents, by what each device last agreed | Accepted |
| [0038](0038-encrypted-workspaces-seal-a-key-to-each-member-and-relay-updates-the-server-cannot-read.md) | Encrypted workspaces seal a key to each member, and the server relays updates it cannot read | Accepted |
| [0039](0039-attachments-are-kept-by-their-hash-on-disk-or-in-an-s3-bucket.md) | Attachments are kept by their hash, on disk or in an S3-compatible bucket | Accepted |
| [0040](0040-attachments-sync-by-path-and-hash-in-the-vault-document.md) | Attachments sync by path and hash in the vault document | Accepted |
| [0041](0041-a-notes-history-is-its-earlier-texts-kept-before-each-spell-of-editing.md) | A note's history is its earlier texts, kept before each spell of editing | Accepted |
| [0042](0042-spaces-and-shared-pages-are-sync-units-each-with-its-own-vault-document.md) | Spaces and shared pages are sync units, each with its own vault document | Accepted |
| [0043](0043-a-note-open-in-the-editor-syncs-live-with-awareness-for-carets.md) | A note open in the editor syncs live, with awareness for carets | Accepted |
| [0044](0044-a-notes-comments-are-a-document-of-their-own-beside-it.md) | A note's comments are a document of their own beside it | Accepted |
| [0045](0045-mentions-are-named-by-the-commenting-client-and-the-server-tells-those-who-may-open-the-note.md) | Mentions are named by the commenting client, and the server tells those who may open the note | Accepted |
| [0046](0046-notes-open-in-tabs-in-at-most-two-panes-each-with-its-own.md) | Notes open in tabs, in at most two panes, each with its own | Accepted |
| [0047](0047-every-command-is-in-a-menu-at-the-top-of-the-sidebar.md) | Every command is in a menu at the top of the sidebar | Accepted |
| [0048](0048-the-vault-knows-its-folders-empty-ones-too.md) | The vault knows its folders, empty ones too | Accepted |
| [0049](0049-built-in-themes-draw-an-effect-behind-the-app.md) | Built-in themes draw an effect behind the app | Accepted |
| [0050](0050-the-server-searches-what-it-can-read-indexed-as-notes-are-stored.md) | The server searches what it can read, indexed as notes are stored | Accepted |
| [0051](0051-canvases-are-json-canvas-files-drawn-with-the-page-s-own-elements.md) | Canvases are JSON Canvas files, drawn with the page's own elements | Accepted |
| [0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md) | The web app is the desktop page in the browser, signed in by a cookie | Accepted |
| [0052](0052-backups-are-the-server-s-own-files-restored-at-their-schema-then-migrated.md) | Backups are the server's own files, restored at their schema, then migrated | Accepted |
| [0054](0054-docker-compose-starts-the-server-with-postgresql-valkey-and-volumes.md) | Docker Compose starts the server with PostgreSQL, Valkey and volumes | Accepted |
| [0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md) | Plugins declare what they add, and reach the app only by messages | Accepted |
| [0056](0056-a-plugins-database-layout-is-named-for-it-and-a-base-shows-it-as-a-table.md) | A plugin's database layout is named for it, and a base shows it as a table | Accepted |
| [0057](0057-a-plugins-property-type-stores-as-one-of-the-apps-which-shows-without-it.md) | A plugin's property type stores as one of the app's, which shows without it | Accepted |
| [0058](0058-a-plugin-from-a-vault-runs-in-a-sandboxed-frame-with-what-this-device-approved.md) | A plugin from a vault runs in a sandboxed frame, with what this device approved | Accepted |
| [0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md) | The public API takes tokens that act as their account, and gives notes as Markdown | Accepted |
| [0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md) | Webhooks tell of notes made, changed and removed, signed, and sent to public addresses | Accepted |
| [0061](0061-pdfs-show-through-pdf-js-and-a-highlight-is-a-callout-that-links-to-its-passage.md) | PDFs show through pdf.js, and a highlight is a callout that links to its passage | Accepted |
| [0062](0062-every-link-to-a-passage-shows-on-the-pdf-in-pdf-plus-plus-colors.md) | Every link to a passage shows on the PDF, in PDF++'s colors | Accepted |
| [0063](0063-a-vault-plugins-views-draw-in-its-worker-and-the-page-shows-them-cleaned.md) | A vault plugin's views draw in its worker, and the page shows them cleaned | Accepted |
| [0064](0064-a-plugin-reads-and-writes-notes-through-the-app-as-far-as-it-asked.md) | A plugin reads and writes notes through the app, as far as it asked | Accepted |
| [0065](0065-the-directory-is-an-index-in-the-repository-of-files-pinned-by-commit-and-hash.md) | The directory is an index in the repository, of files pinned by commit and hash | Accepted |
| [0066](0066-the-web-clipper-is-a-manifest-v3-extension-that-sends-clips-to-the-users-own-server-alone.md) | The web clipper is a Manifest V3 extension that sends clips to the user's own server alone | Accepted |
| [0067](0067-pdf-embeds-draw-with-pdf-js-when-on-screen-and-an-area-is-pdf-plus-plus-rect.md) | PDF embeds draw with pdf.js when on screen, and a highlight of an area is PDF++'s rect | Accepted |
| [0068](0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md) | AI comes from the user's own provider, reached from their device, and shows nothing until there is one | Accepted |
| [0069](0069-writing-assist-streams-into-a-preview-and-goes-in-as-one-edit.md) | Writing assist streams into a preview, and goes into the note as one edit | Accepted |
| [0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md) | The web app's AI goes through its server, which seals the keys and reaches only what it may | Accepted |
| [0071](0071-a-share-link-opens-one-shared-page-to-anyone-with-it-through-the-web-app.md) | A share link opens one shared page to anyone with it, through the web app | Accepted |
| [0072](0072-buttons-are-meta-bind-button-blocks-and-triggers-are-schema-rules-run-where-the-change-is-made.md) | Buttons are Meta Bind's button blocks, and triggers are rules in a database's schema, run where the change is made | Accepted |
| [0074](0074-search-by-meaning-keeps-passages-vectors-on-the-device-and-loads-them-only-to-search.md) | Search by meaning keeps each passage's vector on the device, and loads them only to search | Accepted |
| [0075](0075-asking-your-notes-answers-from-passages-the-vaults-search-finds-each-citation-checked.md) | Asking your notes answers from passages the vault's search finds, each citation checked | Accepted |
| [0076](0076-a-published-site-is-a-note-or-a-folder-drawn-by-the-server-as-it-is-now-linking-only-to-its-own-pages.md) | A published site is a note or a folder, drawn by the server as it is now, linking only to its own pages | Accepted |
| [0077](0077-a-site-holds-a-custom-domain-its-dns-proves-and-tells-search-engines-what-each-page-is.md) | A site holds a custom domain its DNS proves, and tells search engines what each page is | Accepted |
| [0078](0078-building-with-ai-reads-a-checked-json-reply-into-an-import-plan-the-user-previews.md) | Building with AI reads a checked JSON reply into an import plan the user previews | Accepted |
| [0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md) | Enterprise features are in every image, off, and switched in the console or pinned by the environment | Accepted |
| [0080](0080-single-sign-on-binds-saml-and-oidc-providers-to-email-domains-and-enforcement-refuses-other-ways-in.md) | Single sign-on binds SAML and OIDC providers to email domains, and enforcement refuses other ways in | Accepted |
| [0081](0081-audit-events-come-from-a-hook-the-server-emits-kept-in-a-chained-append-only-log-and-sent-to-a-siem.md) | Audit events come from a hook the server emits, kept in a chained, append-only log, and sent to a SIEM | Accepted |
| [0082](0082-several-nodes-share-sync-through-valkey-take-their-order-from-postgresql-and-roll-out-one-at-a-time.md) | Several nodes share sync through Valkey, take their order from PostgreSQL, and roll out one at a time | Accepted |
| [0083](0083-the-console-lists-every-workspace-and-an-instance-admin-may-set-its-members-roles.md) | The console lists every workspace, and an instance admin may set its members' roles | Accepted |
| [0084](0084-the-consoles-security-page-sets-session-lengths-sign-in-limits-and-email-codes-unless-the-environment-does.md) | The console's Security page sets session lengths, sign-in limits and email codes, unless the environment does | Accepted |
| [0085](0085-a-directory-provisions-accounts-and-groups-by-scim-or-an-ldap-pull-and-deprovisioning-deactivates-before-it-removes.md) | A directory provisions accounts and groups by SCIM or an LDAP pull, and deprovisioning deactivates before it removes | Accepted |
| [0086](0086-ai-is-locked-to-the-endpoints-an-instance-admin-approves-in-the-apps-and-the-relay.md) | AI is locked to the endpoints an instance admin approves, in the apps and the relay | Accepted |
| [0087](0087-the-mobile-apps-run-the-shared-page-in-capacitor-with-each-vaults-files-and-index-on-the-phone.md) | The mobile apps run the shared page in Capacitor, with each vault's files and index on the phone | Accepted |
| [0088](0088-data-policies-set-a-workspaces-retention-legal-hold-public-sharing-and-export-over-its-owners.md) | Data policies set a workspace's retention, legal hold, public sharing and export, over its owners | Accepted |

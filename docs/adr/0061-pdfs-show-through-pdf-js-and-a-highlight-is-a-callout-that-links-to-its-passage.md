# 0061. PDFs show through pdf.js, and a highlight is a callout that links to its passage

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#editor-and-writing) ask, in Phase 4,
for PDF annotation: "Highlight and comment on PDFs; highlights become
linkable blocks". The first principle asks that what people write stays
plain Markdown that Obsidian and other tools read.

How PDFs work in Nether today:

- A note embeds a PDF, `![[paper.pdf]]`, in a frame of the webview's own
  viewer, loaded from the app's media server
  ([ADR 0010](0010-vault-files-in-notes.md)). WebKitGTK has no viewer, so
  on Linux a PDF shows as a card that opens it in the system's app.
- PDFs do not show in the sidebar, and following a link to one,
  `[[paper.pdf]]`, makes a note of that name.
- Views of files by their extension are a plugin's
  ([ADR 0055](0055-plugins-declare-what-they-add-and-reach-the-app-only-by-messages.md)):
  the canvas is a built-in plugin's view of `.canvas` files.

How Obsidian keeps what is read in a PDF, from its own help:

- Its viewer links to a page, `[[paper.pdf#page=3]]`.
- **Copy link to selection** links to a passage:
  `[[Gemmy.pdf#page=1&selection=32,0,32,14|Gemmy, page 1]]`. **Copy as
  quote** writes the words as a quote followed by that link.
- Obsidian does not add highlights or annotations to a PDF.

The four numbers of a selection are not in Obsidian's help. PDF++, the
most used Obsidian plugin for PDF annotation, reads them as the first
and last text item of the page, as pdf.js gives a page's text, and the
character offsets in them; it keeps every highlight as such a link in
Markdown, and shows each link to a passage as a highlight on the PDF.
pdf.js lays each item out as one element of the page's text layer, in
the same order, which is how a selection in the page becomes those
numbers.

What any design must live with:

- **Idle memory has a limit of 300 MB**, and the app is near it. Nothing
  may load before a PDF opens.
- **A comment needs no server.** A vault with no account must be able to
  annotate.
- **Every control is reached by keyboard and named for screen readers**
  ([ADR 0015](0015-check-accessibility-and-lay-out-by-direction.md)),
  highlighting included.
- **The web app is the desktop page in the browser**
  ([ADR 0053](0053-the-web-app-is-the-desktop-page-in-the-browser-signed-in-by-a-cookie.md)),
  under a content security policy, and keeps every file of its build for
  offline use.

## Decision

**A built-in plugin, `pdf`, opens `.pdf` files** in a view of its own, as
the canvas opens canvases. PDFs show in the sidebar's trees beside notes,
marked **pdf**, and open in tabs.

**pdf.js draws them.** `pdfjs-dist` 6.5.438, under the Apache-2.0 license,
loads with the plugin's code when a PDF first opens:

- Its worker is a module file of the build, started from the app's own
  origin, one for each PDF open and stopped when it closes. Pages draw on
  the page's own thread: pdf.js's second worker, which draws in an
  offscreen canvas, stays off.
- Only the pages near what shows are drawn, and those that scroll far
  away let their canvases go.
- pdf.js's text layer lays the page's words over it, unseen, for
  selecting and for screen readers.
- No scripts of the PDF run, no XFA forms, and no annotation layer.
  pdf.js 6 has no `eval` left: its `isEvalSupported` option is gone, and
  its build holds no `new Function`.
- The build copies what pdf.js fetches when a PDF needs it, under
  `pdfjs/`: the CMaps for Chinese, Japanese and Korean text (Adobe,
  BSD-3-Clause); the WebAssembly decoders of JBIG2 (PDFium, BSD-3-Clause),
  JPEG 2000 (OpenJPEG, BSD-2-Clause) and ICC colors (qcms, MIT); and the
  two standard fonts no system font stands in for, Symbol and Dingbats
  (Foxit, BSD-3-Clause). Not the Liberation fonts, which are under the
  OFL-1.1, a license ADR 0001 does not list: system fonts stand in for
  them, as pdf.js does by default in browsers.
- pdf.js's optional `@napi-rs/canvas`, which draws in Node, is not
  installed.

**The PDF's bytes come through the vault's files**, as notes' do: the Go
service in the desktop app, the browser's private file system in the web
app, memory in the preview. The media server's URL would need CORS on
another origin, and the web app's `blob:` URLs a `connect-src` the policy
does not have. The whole file stays in memory while it is open; the Go
service reads files up to 256 MB.

**No content security policy changes.** The web app's already allows
what pdf.js needs: scripts and WebAssembly (`'wasm-unsafe-eval'`) from
its own origin, workers from it, connections to it for the CMaps and
decoders, and fonts from `data:`. The desktop page has no policy. No
`frame-src` changes, and embeds keep the webview's viewer.

**A highlight is a callout that links to its passage**, in Obsidian's own
syntax:

```markdown
> [!quote] [[paper.pdf#page=3&selection=4,0,5,20|paper, page 3]]
> The words highlighted, as the PDF has them.
>
> A comment, in as many paragraphs as wanted.

^k3x9q2ab
```

- Its title is the link Obsidian's **Copy link to selection** writes, with
  its name, "paper, page 3". The page counts from 1. The selection is the
  first and last text item, among the page's items as pdf.js gives them
  without marked content and without normalizing, and the offset of the
  first character in the first and after the last character in the last.
- The callout is a `quote`, one of Obsidian's own kinds.
- The first paragraph of its body is the words highlighted, with each run
  of white space made one space.
- Everything after it is the comment, as Markdown.
- Its ID is written on a line of its own after it, as Obsidian asks for a
  callout's ([ADR 0006](0006-markdown-file-format.md)).

**A PDF's highlights are found by their links.** The PDF view shows every
such callout in the vault whose link finds that PDF, through the link
index. New highlights go at the end of the note that holds most of them.
A PDF with none gets a note beside it, named "paper highlights", or the
first free name after it. The note is found by what it holds, not by its
name, so it can be renamed, moved, or written in another language.

**A highlight finds its words by both its selection and its words.** When
the words at its selection, white space aside, are its words, it shows
there. Otherwise its words are looked for on its page, then on the other
pages, nearest first: another version of pdf.js may split a page's text
into other items, and the file may have changed. Found, it shows there,
and its link is left as it is. Not found, it is listed as not found in
the PDF, with its words, and shows on no page.

**A comment is text in the highlight's callout**, not a thread of
[ADR 0044](0044-a-notes-comments-are-a-document-of-their-own-beside-it.md).
It needs no server and no account, Obsidian shows it, it is exported and
searched with the note, and a link or an embed of the highlight carries
it. Threads on the highlights note still work, as on any note, for
discussions with others.

**A highlight is a block, linked and embedded as blocks are:**

- `[[paper highlights#^k3x9q2ab]]` links to it, and
  `![[paper highlights#^k3x9q2ab]]` embeds it, as a synced block
  ([ADR 0023](0023-synced-blocks-are-block-embeds-edited-in-place.md)).
- **Following a link to a highlight opens the PDF at it**, not its note:
  the passage is what it names. The highlights list shows it in its note.
- A link to a page or a passage of a PDF, written in Nether or pasted from
  Obsidian, opens the PDF there, and a link to any other file a view
  opens, as a canvas, opens that file. Such links no longer make a note.

**The keyboard reaches everything:**

- The view's toolbar has the page, the previous and next page, zoom,
  Find, Highlight, and the list of highlights, each a named control.
- With the pointer, select words and choose **Highlight**, or press
  Ctrl+Shift+H (Cmd+Shift+H on a Mac).
- Without it, **Find** (Ctrl+F or Cmd+F in the view) looks for words in the
  PDF, Enter goes to each place they are, and **Highlight** highlights the
  place shown.
- The highlights list, beside the pages, is a landmark. Each highlight
  names its page and its words, shows its place on Enter, and offers to
  comment, to copy a link to it, to show it in its note, and to remove it.
- Each page is named by its number. Its marks are hidden from screen
  readers, since the list says what they show, and the text layer reads
  as the page's words.

**It works in the web app as in the desktop app.** The web app's service
worker keeps pdf.js, its worker and what it fetches with the build's
other files, so PDFs open offline too.

## Alternatives

- **The webview's own viewer**, in a frame, as embeds use it. It shows the
  PDF, but the app cannot read its selection or draw on it, and WebKitGTK
  has none.
- **Highlights written into the PDF** as annotations. Other PDF readers
  would show them, but Nether would rewrite files people keep elsewhere,
  Obsidian would not show the comments, and a highlight could not be a
  block that links and embeds.
- **A sidecar file of JSON** beside the PDF. Readable by Nether only, which
  the first principle rules out.
- **A highlight as a list item or a paragraph** with the link at its end.
  A comment could not sit inside it, so a link or an embed of it would
  leave the comment behind.
- **The highlights note found by its name.** Renaming it, or changing the
  app's language, would start a second note.
- **Comments as threads of ADR 0044.** They need a workspace and an
  account, and leave the note's Markdown.
- **PDF++'s callout, `> [!PDF|yellow]`, with the words as a quote in it.**
  Its kind and color mean something only to PDF++, and Obsidian alone
  shows a callout kind it does not know as a plain note. Nether reads it
  as a quote. Highlights PDF++ writes show in a later part, with colors.
- **The page's text normalized**, as pdf.js does by default. Obsidian's
  viewer counts offsets in the text as the PDF has it.
- **PDF.js's whole viewer**, `pdf_viewer.mjs`. It brings its own controls,
  strings and styles, which are not the app's, and its own find bar and
  editor, which this does not need.

## Consequences

- A highlight made in Nether opens in Obsidian at its passage, and PDF++
  shows it as a highlight. A link to a passage copied in Obsidian opens in
  Nether at that passage.
- PDF files are never written. Their highlights show in Nether and in
  Obsidian, not in other PDF readers.
- An open PDF costs its bytes, a worker, and the pages near the screen.
  Nothing is loaded before a PDF opens. The app's files grow by pdf.js and
  the view, 0.46 MB, its worker, 1.2 MB, and what pdf.js fetches when a
  PDF needs it, 1.9 MB.
- A page's canvas holds at most 16 million pixels, 64 MB: zoomed past
  that, a page is drawn no finer.
- PDF annotation comes in parts, one pull request each:
  1. The view of PDFs, highlighting by selection and by Find, the list
     with comments, and links to pages, passages and highlights that open
     the PDF there.
  2. Highlights from any note: every block that links to a passage, as
     Obsidian's **Copy as quote** and PDF++ write them, with PDF++'s
     colors; and the PDF's own outline and links.
  3. PDFs embedded in a note drawn by pdf.js too, on Linux as well, and a
     highlight's embed showing its passage as the PDF draws it; and
     highlights of an area, for figures and scanned pages. Embeds are
     frames now, and the sandbox's next part decides the page's
     `frame-src`, so this part follows it.
- Selections counted by a later pdf.js may differ from Obsidian's for the
  same PDF. The words keep each highlight in its place, and the link
  keeps the page.

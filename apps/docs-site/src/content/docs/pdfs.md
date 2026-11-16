---
title: PDFs
description: How to read PDFs in Nether, highlight and comment on them, and link to a highlight, with every highlight kept as Markdown that Obsidian reads.
---

Nether opens the PDFs in your vault in a tab of their own, where you can
highlight words and comment on them. Every highlight is plain Markdown in
a note, a callout that links to its passage the way Obsidian links to
one, so it opens in Obsidian too, and the PDF itself is never changed.

## Opening a PDF

PDFs show in the sidebar's Folders and Pages views beside your notes,
marked **pdf**. Click one to open it in a tab, as a note opens; Ctrl or
Cmd and a click opens it in a new tab.

The toolbar moves between pages, by **Previous page**, **Next page** or a
page number, and zooms in and out. The PDF opens as wide as the pane.
**Highlights** shows or hides the list of highlights beside the pages.

## Highlighting

Select words on a page and choose **Highlight**, or press Ctrl+Shift+H
(Cmd+Shift+H on a Mac). A highlight stays on one page: a selection that
runs onto the next page ends where its first page does.

From the keyboard, choose **Find** or press Ctrl+F (Cmd+F) in the PDF,
type the words, and press Enter to go to the first place they are,
Enter again for the next, and Shift+Enter for the one before. Then press
Ctrl+Shift+H to highlight the words found.

The highlights list names each highlight's page and its words. Choose one
to show it on its page. Under each, you can:

- **Comment**: write a comment, in Markdown, and **Save** it, or press
  Ctrl+Enter. Escape leaves it as it was.
- **Copy link**: copy a link to the highlight, to paste in another note.
- **Show in note**: open the note that keeps it, at the highlight.
- **Remove**: take the highlight, and its comment, out of its note.

## Where highlights are kept

The first highlight of `paper.pdf` starts a note beside it, named
"paper highlights". Each highlight goes at its end, as a callout:

```markdown
> [!quote] [[paper.pdf#page=3&selection=4,0,5,20|paper, page 3]]
> The words highlighted, as the PDF has them.
>
> Your comment, in as many paragraphs as you like.

^k3x9q2ab
```

The link is the one Obsidian's **Copy link to selection** writes: opened
in Obsidian, it shows the PDF at that passage. The last line is the
highlight's block ID, which links to it use.

The note is yours to edit, rename or move. Nether finds a PDF's highlights
by their links, in whatever note holds them, and adds new ones to the
note that holds most. A highlight whose words have moved, because the PDF
changed, is found by its words; one whose words are gone is listed as not
found in the PDF.

## Linking to a PDF and to a highlight

A link to a page, `[[paper.pdf#page=3]]`, or to a passage, as Obsidian
copies one, opens the PDF there, with the passage marked. Copy one in
Obsidian and paste it into a note, and it opens the same place in Nether.

A highlight is a block, so a link to it, `[[paper highlights#^k3x9q2ab]]`,
opens the PDF at the highlight, chosen in the list. An embed of it,
`![[paper highlights#^k3x9q2ab]]`, shows its words and its comment in the
note, and edits them there, as any [synced block](../links/#synced-blocks)
does.

## In the web app

PDFs open and highlight in the web app as in the desktop app, offline too
once the app has been opened.

## Not yet

- Highlights written in other notes, as Obsidian's **Copy as quote** and
  the PDF++ plugin write them, do not show on the PDF yet, and neither do
  highlight colors.
- A PDF embedded in a note, `![[paper.pdf]]`, still shows in the web
  view's own viewer, and as a card on Linux.
- Highlights are of words only: not yet of an area, such as a figure or
  a scanned page.
- A PDF with a password does not open.

---
title: PDFs
description: How to read PDFs in Nether, highlight words or areas in colors and comment on them, link to and embed a highlight, embed a PDF in a note, and follow a PDF's outline and links, with every highlight kept as Markdown that Obsidian reads.
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
**Highlights** shows or hides the list of highlights beside the pages, and
**Outline** the PDF's own outline in its place.

## The outline and the PDF's links

**Outline** lists the PDF's bookmarks, nested as the PDF nests them. Choose
one to go to its place. A PDF without an outline says so.

Links in the PDF's pages work as in a PDF reader: one to another page goes
there, and one to a web address opens it in your browser. Each is a button
over its words, reached with Tab and named by where it goes. **Back**
returns to where you followed the last link or outline entry from.

## Highlighting

Select words on a page and choose **Highlight**, or press Ctrl+Shift+H
(Cmd+Shift+H on a Mac). A highlight stays on one page: a selection that
runs onto the next page ends where its first page does.

From the keyboard, choose **Find** or press Ctrl+F (Cmd+F) in the PDF,
type the words, and press Enter to go to the first place they are,
Enter again for the next, and Shift+Enter for the one before. Then press
Ctrl+Shift+H to highlight the words found.

New highlights take the color chosen beside **Highlight**: yellow, red,
blue or purple. These are the colors of the PDF++ plugin for Obsidian, so
a highlight shows in the same color in both.

## Highlighting an area

For a figure, a table or a scanned page, highlight an area instead of
words. Choose **Area**: a box appears in the middle of the page shown.
Drag on a page to draw another, or move the box with the arrow keys and
resize it with Shift and the arrow keys. Then choose **Highlight**, or
press Enter on the box. Escape leaves it.

An area is written as the PDF++ plugin writes a box of a page, its
corners in the PDF's own units:
`[[paper.pdf#page=3&rect=72,400,300,600|paper, page 3]]`. It has no words,
so everything in its callout is the comment. Obsidian alone opens it at
its page.

## The highlights list

The highlights list names each highlight's page, its color and its words.
Choose one to show it on its page. Under each, you can:

- **Comment**: write a comment, in Markdown, and **Save** it, or press
  Ctrl+Enter. Escape leaves it as it was.
- **Copy link**: copy a link to the highlight, to paste in another note.
- **Show in note**: open the note that keeps it, at the highlight.
- Choose another **color** for it.
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
in Obsidian, it shows the PDF at that passage. A color other than yellow
goes at the end of the link's place, as PDF++ writes it:
`[[paper.pdf#page=3&selection=4,0,5,20&color=red|paper, page 3]]`. The
last line is the highlight's block ID, which links to it use.

The note is yours to edit, rename or move. Nether finds a PDF's highlights
by their links, in whatever note holds them, and adds new ones to the
note that holds most. A highlight whose words have moved, because the PDF
changed, is found by its words; one whose words are gone is listed as not
found in the PDF.

## Passages linked from other notes

Every link to a passage of the PDF, in any note, shows on the PDF too, in
its color, and is listed under **Linked from notes** with its note's name
and the words around it. That includes the quotes Obsidian's **Copy as
quote** writes, and those of the PDF++ plugin, colors included:

```markdown
> Attention is all you need [[paper.pdf#page=1&selection=32,0,32,14|paper, page 1]]

> [!PDF|red] [[paper.pdf#page=3&selection=4,0,5,20&color=red|paper, page 3]]
> > The words, as PDF++ quotes them.
```

They are your notes' own text: choose one to show its place, or **Show in
note** to open its note. Nether does not change them from the list. As in
Obsidian and PDF++, each is found by the numbers in its link alone, and
one whose numbers no longer fit its page is listed as not found.

## Linking to a PDF and to a highlight

A link to a page, `[[paper.pdf#page=3]]`, or to a passage, as Obsidian
copies one, opens the PDF there, with the passage marked. Copy one in
Obsidian and paste it into a note, and it opens the same place in Nether.

A highlight is a block, so a link to it, `[[paper highlights#^k3x9q2ab]]`,
opens the PDF at the highlight, chosen in the list. An embed of it,
`![[paper highlights#^k3x9q2ab]]`, shows its words and its comment in the
note, and edits them there, as any [synced block](../links/#synced-blocks)
does.

## Embedding a PDF in a note

`![[paper.pdf]]` shows the PDF in the note, in a box 480 pixels tall, or
as tall as `#height=` says: `![[paper.pdf#page=3&height=300]]` opens at
page 3 in a box 300 pixels tall. **Open** opens the PDF in a tab at the
page the box shows.

An embed of a passage shows just that passage, marked in its color:
`![[paper.pdf#page=3&selection=4,0,5,20]]`, Obsidian's link with a `!`
before it. An embed of a box, `![[paper.pdf#page=3&rect=72,400,300,600]]`,
as PDF++ writes one, shows just that box, as wide as the note, or as wide
as `&width=` says.

An embed of a highlight, `![[paper highlights#^k3x9q2ab]]`, shows its
passage above its words and comment.

Nether draws a PDF in a note only once it comes near the screen, so a
note with PDFs far down opens as fast as one without.

## In the web app

PDFs open and highlight in the web app as in the desktop app, offline too
once the app has been opened.

## Not yet

- PDF++'s callouts, `> [!PDF|red]`, show in the editor as quotes, their
  first line as text.
- A PDF with a password does not open.

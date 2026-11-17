# 0067. PDF embeds draw with pdf.js when on screen, and a highlight of an area is PDF++'s rect

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0061](0061-pdfs-show-through-pdf-js-and-a-highlight-is-a-callout-that-links-to-its-passage.md)
and [ADR 0062](0062-every-link-to-a-passage-shows-on-the-pdf-in-pdf-plus-plus-colors.md)
left a third part of PDF annotation:

- PDFs embedded in a note drawn by pdf.js, on Linux too, in place of the
  webview's own viewer;
- a highlight's embed showing its passage;
- highlights of an area, for figures and scanned pages.

How these are written elsewhere:

- **Obsidian** embeds a PDF with `![[paper.pdf]]`, at a page with
  `#page=3`, and at a height in pixels with `#height=400`, or both,
  `#page=3&height=400`.
- **PDF++** embeds a rectangle of a page with `![[paper.pdf#page=1&rect=300,200,700,600]]`.
  Its docs say the four numbers are the lower-left and upper-right
  corners, `x1,y1,x2,y2`, "in the default user space units", and that an
  optional `width` gives the embed's width in pixels. It writes them
  rounded to whole numbers. Without PDF++, such a link "still" goes "to
  the correct PDF page".
- **PDF++'s callouts**, `> [!PDF|red]`, put a color after a pipe in the
  callout's type. Obsidian's help on callouts does not describe a pipe
  there; it says an unknown type shows as a note.

What any design must live with:

- **Embeds now show in a frame** of the webview's viewer, loaded from the
  app's media server, and as a card on Linux, whose webview has none.
- **pdf.js and its worker are 1.6 MB**, loaded only with the PDF view.
  Notes open at startup must not load them for an embed that is not on
  screen.
- [ADR 0063](0063-a-vault-plugins-views-draw-in-its-worker-and-the-page-shows-them-cleaned.md)
  draws views in the page, with no frame each, and no `frame-src` change
  is needed for what the page draws itself.

## Decision

**A PDF embed draws its pages with pdf.js, in the note.**

- `![[paper.pdf]]` and a file block, `![paper](paper.pdf)`, show a box as
  wide as the note, 480 pixels tall unless `#height=` says otherwise. It
  opens at `#page=`, or the first page.
- Above the pages, the box names the PDF and the page shown, and
  **Open** opens the PDF in a tab at that page.
- The pages draw as they do in the PDF view, only those near what the box
  shows, with their words over them.
- The embed no longer uses the webview's viewer, nor a frame, on any
  system, and on Linux a PDF shows instead of a card.

**Nothing loads until an embed is on screen.** Until then the embed is a
box of its size, with the PDF's name. The first time a box comes near
the screen, it loads the code that draws PDFs, pdf.js with it. A note
with embeds far down loads none of it while they stay there.

**An embed of a passage shows the passage alone.**

- `![[paper.pdf#page=3&selection=4,0,5,20]]`, Obsidian's link with `!`,
  shows the lines of its page that hold the passage, marked in its color.
- `![[paper.pdf#page=3&rect=72,400,300,600]]`, PDF++'s, shows its box of
  the page.
- PDF++'s `&width=` sets the width of either, in pixels.

**A highlight's embed shows its passage.** `![[paper highlights#^k3x9q2ab]]`
shows the passage as an embed of its link would, above the callout,
which stays a synced block ([ADR 0023](0023-synced-blocks-are-block-embeds-edited-in-place.md)).
The editor takes it as a figure the app gives with the embedded blocks;
the app gives one for a block that is a highlight.

**A highlight of an area is a callout with PDF++'s `&rect=`:**

```markdown
> [!quote] [[paper.pdf#page=3&rect=72,400,300,600|paper, page 3]]
> What the figure shows, as a comment.

^m4p8z2cd
```

- The four numbers are as PDF++ writes them: the lower-left and
  upper-right corners in the PDF's own units, rounded to whole numbers.
- An area has no words, so everything in the callout is the comment.
- Its color is PDF++'s `&color=`, after the box, as for words.
- Another note's link with `&rect=` shows as a linked area, as ADR 0062
  shows links to words.
- An area is found by its box alone. A box on a page the PDF no longer has
  is listed as not found.

**An area is drawn with the pointer or the keyboard.** **Area**, in the
PDF view's toolbar, turns on drawing:

- dragging on a page draws a box;
- from the keyboard, Area puts a box in the middle of the page shown, and
  focuses it. The arrow keys move it, Shift and the arrow keys resize it,
  Enter highlights it, and Escape leaves it;
- the box is named by where it is on its page, in hundredths of the page.

**PDF++'s callouts, `[!PDF|red]`, stay as Nether reads them now**, a quote
with the line as text. Reading a pipe in a callout's type would change how
every callout in every vault reads, for a syntax Obsidian's help does not
describe. Links inside those callouts already show on the PDF. It is a
question for the Markdown format, with a record of its own, not for PDF
annotation.

## Alternatives

- **The webview's viewer, kept for whole-PDF embeds.** It shows no
  highlights, no passage alone, and nothing on Linux.
- **pdf.js loaded with a note that has a PDF embed**, on screen or not.
  A note with an embed at its end would load 1.6 MB at startup for
  nothing.
- **A picture of the passage, saved beside the note**, as PDF++ can. A
  second file to keep in step with the PDF, and a picture of words that
  stay selectable when drawn.
- **Areas in fractions of the page, or in screen pixels.** PDF++'s units
  make the same link the same box in both apps, whatever the zoom.
- **A words paragraph for areas, left empty.** An empty paragraph is not
  kept in Markdown ([ADR 0006](0006-markdown-file-format.md)), so the
  first paragraph of the comment would read as words.

## Consequences

- Every PDF embed draws the same way on every system, and an embed of a
  passage or a highlight shows just that passage.
- The note's page loads a small component for PDF embeds; pdf.js loads
  only with a PDF embed on screen or the PDF view.
- A highlight of an area writes a parameter Obsidian's own syntax lacks,
  as PDF++ does. Obsidian alone opens it at its page.
- With this part, PDF annotation's three parts are done.

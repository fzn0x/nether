# 0062. Every link to a passage shows on the PDF, in PDF++'s colors

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0061](0061-pdfs-show-through-pdf-js-and-a-highlight-is-a-callout-that-links-to-its-passage.md)
opened PDFs in a view of pdf.js and made a highlight a callout whose title
links to its passage, as Obsidian's **Copy link to selection** writes. It
left a second part: highlights from any note, PDF++'s colors, and the
PDF's own outline and links.

How passages are written elsewhere:

- **Obsidian's Copy as quote** writes the words as a quote, followed by
  the link: `> Obsidian is awesome [[Gemmy.pdf#page=1&selection=32,0,32,14|Gemmy, page 1]]`.
- **PDF++**, the most used Obsidian plugin for PDF annotation, copies a
  passage in templates its user picks. Its defaults:
  - **Quote**: `> ([[link|display]])`, then `> words`;
  - **Callout**: `> [!PDF|yellow] [[link|display]]`, then `> words`;
  - **Quote in callout**: the same, with the words as a quote inside it,
    and a line left for a comment.
- **PDF++ shows every link to a passage as a highlight on the PDF**,
  wherever it is in the vault, colored by the link's `&color=`. The color
  is a name from its palette, whose defaults are Yellow `#ffd000`, Red
  `#ea5252`, Note `#086ddd` and Important `#bb61e5`, matched whatever
  their case and copied in lower case; or three numbers, `r,g,b`. PDF++
  counts `&color=` among the few optional parameters it adds to the links
  Obsidian itself opens.

A PDF also holds its own outline, the bookmarks a reader lists beside the
pages, and links in its pages, to its other pages or to the web. Part 1
shows neither.

## Decision

**Every link to a passage of the PDF shows on it.** A linked passage is a
wiki link that finds the PDF and names a selection, in any block of any
note, except a highlight's own callout title. The PDF view marks each on
its page, and lists them after the highlights, under **Linked from
notes**:

- each with its note's name, its page, and its block's words, without the
  link and without a callout's `[!PDF|yellow]`. Where that leaves no
  words, the next block's are shown, as PDF++'s Quote in callout puts
  them;
- choosing one shows its place. **Show in note** opens its note, at its
  block when the block has an ID;
- they are the notes' own text, not highlights Nether keeps: the list
  does not comment on them, recolor them or remove them.

**A linked passage is found by its selection alone**, as Obsidian and
PDF++ find it. Its block's words are not always the passage's, as in "as
[[paper.pdf#page=3&selection=4,0,5,20|the paper]] shows", so looking for
them could mark the wrong place. A selection not on its page is listed as
not found. Highlights keep ADR 0061's rule, by their selection and their
words.

**Colors are PDF++'s `&color=`, read and written as PDF++ does.**

- Read: a name, whatever its case: PDF++'s four default names show in
  their colors, any other CSS color name as itself, and anything else in
  the default yellow; or `r,g,b`.
- Written: Nether offers PDF++'s four default names, shown as Yellow, Red,
  Blue and Purple, when highlighting and for each highlight. The name goes
  in lower case after the selection:
  `[[paper.pdf#page=3&selection=4,0,5,20&color=red|paper, page 3]]`.
- Yellow, the default, writes no color, so a yellow highlight is written
  as part 1 wrote it.
- The callout stays a `quote`, as ADR 0061 says: the color is the link's,
  which PDF++ reads.
- The list names each highlight's color in words, so that color is never
  the only sign of it.

**The PDF's outline shows in a panel beside the pages**, in place of the
highlights: two buttons of the toolbar choose which. It is a nested list
of the outline's titles, each a button that goes to its place, the page
and the height on it. A PDF without an outline says so.

**The PDF's links are buttons over their words.** A link to a place in
the PDF goes there; one to an `http:` or `https:` address opens it in the
system's browser, or a new tab in the web app. Others, as to files,
scripts or the reader's own actions, do nothing. Each is named by where
it goes: "Go to page 3", or its address. **Back**, in the toolbar,
returns to where the last link or outline entry was followed from.

## Alternatives

- **Linked passages found by their block's words**, as highlights are.
  Prose around a link is not the passage, and a short phrase would mark
  the wrong place.
- **Linked passages that the list comments on and removes.** It would
  rewrite a note's prose, which is the user's, from a list that shows one
  line of it.
- **Colors in the callout**, as PDF++'s `[!PDF|red]`. Its kind and
  metadata mean something only to PDF++. Nether does not read callout
  metadata yet, and the link's color is what PDF++ draws highlights by.
- **Colors of Nether's own**, named for what they mean. PDF++'s names
  make the same link the same color in both apps.
- **pdf.js's annotation layer** for the PDF's links. It brings forms,
  popups and its own styles, and its link service is the viewer's.

## Consequences

- A vault annotated in Obsidian with PDF++ shows its highlights in
  Nether, in their colors, and Nether's colored highlights show in PDF++
  in theirs.
- A note that cites a passage in its prose marks it on the PDF, as in
  PDF++.
- A highlight with a color writes a parameter Obsidian's own syntax
  lacks, as PDF++ does.
- Nether reads PDF++'s callouts as quotes: `[!PDF|yellow]` shows as text
  in the editor. Reading callout metadata changes the Markdown format,
  and needs a record of its own.
- Part 3 stays as ADR 0061 plans it. [ADR 0063](0063-a-vault-plugins-views-draw-in-its-worker-and-the-page-shows-them-cleaned.md)
  draws plugin views in the page, with no frame each, so a PDF embedded
  in a note can be drawn by pdf.js in the page too, and no `frame-src`
  changes.

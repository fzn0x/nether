# @nether/pdf

PDF highlights as Markdown
([ADR 0061](../../docs/adr/0061-pdfs-show-through-pdf-js-and-a-highlight-is-a-callout-that-links-to-its-passage.md)):
Obsidian's links to a page or a passage of a PDF, highlights as callouts
that link to their passage, and the words of a page as pdf.js gives them.
It draws nothing and does not load pdf.js: the desktop app's PDF view does.

- `readPdfPlace(part)` reads what follows a link's `#`, `page=3` or
  `page=3&selection=4,0,5,20`, and `writePdfPlace(place)` writes it.
- `readHighlights(blocks)` finds the highlights in a note's blocks;
  `highlightCallout`, `withComment` and `withoutHighlight` make, comment
  and remove them.
- `passageWords`, `findOnPage` and `locatePassage` read a page's text
  items, find words on it, and find a highlight's passage again when the
  PDF's text moved.

// PDFs for the end-to-end tests, desktop and web (ADR 0061): made here, as
// plain text, so that no binary file is kept for them.

/** What a test PDF holds besides its text (ADR 0062): an outline, and links on its pages. */
export interface PdfExtras {
  /** Entries to the top of a page, in order. */
  readonly outline?: readonly { readonly title: string; readonly page: number }[];
  /** Links on a page, at a box in the PDF's units, to the top of a page or to a web address. */
  readonly links?: readonly {
    readonly page: number;
    readonly rect: readonly [number, number, number, number];
    readonly toPage?: number;
    readonly uri?: string;
  }[];
}

/** A PDF of pages of lines in Helvetica, its text uncompressed, all ASCII. */
export function pdfOf(pages: readonly (readonly string[])[], extras: PdfExtras = {}): string {
  const outline = extras.outline ?? [];
  const links = extras.links ?? [];
  const pageObject = (page: number) => String(1 + page * 2);
  const font = 3 + pages.length * 2;
  const outlines = font + 1;
  const entry = (index: number) => String(outlines + 1 + index);
  const link = (index: number) => String(outlines + 1 + outline.length + index);
  const top = (page: number) => `[${pageObject(page)} 0 R /XYZ 0 300 null]`;

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${outline.length === 0 ? "" : ` /Outlines ${String(outlines)} 0 R`} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObject(index + 1)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
  ];
  for (const [index, lines] of pages.entries()) {
    const annots = links.flatMap((each, at) =>
      each.page === index + 1 ? [`${link(at)} 0 R`] : [],
    );
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(4 + index * 2)} 0 R${annots.length === 0 ? "" : ` /Annots [${annots.join(" ")}]`} >>`,
    );
    const stream = `${["BT", "/F1 16 Tf", "40 250 Td", "20 TL", ...lines.flatMap((line) => [`(${line}) Tj`, "T*"]), "ET"].join("\n")}\n`;
    objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}endstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push(
    outline.length === 0
      ? "<< /Type /Outlines /Count 0 >>"
      : `<< /Type /Outlines /First ${entry(0)} 0 R /Last ${entry(outline.length - 1)} 0 R /Count ${String(outline.length)} >>`,
  );
  for (const [index, each] of outline.entries()) {
    const prev = index === 0 ? "" : ` /Prev ${entry(index - 1)} 0 R`;
    const next = index === outline.length - 1 ? "" : ` /Next ${entry(index + 1)} 0 R`;
    objects.push(
      `<< /Title (${each.title}) /Parent ${String(outlines)} 0 R${prev}${next} /Dest ${top(each.page)} >>`,
    );
  }
  for (const each of links) {
    const action =
      each.uri === undefined
        ? `/Dest ${top(each.toPage ?? 1)}`
        : `/A << /S /URI /URI (${each.uri}) >>`;
    objects.push(
      `<< /Type /Annot /Subtype /Link /Rect [${each.rect.join(" ")}] /Border [0 0 0] ${action} >>`,
    );
  }

  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(text.length);
    text += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, "0")} 00000 n \n`;
  text += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return text;
}

/** Two pages of a reading, the words the PDF tests highlight. */
export const reading = pdfOf([
  ["Reading notes", "Attention is all you need, they said.", "Highlights become linkable blocks."],
  ["The second page says something else.", "Find these words here too."],
]);

/** Two pages with an outline, a link to the second page, and one to the web. */
export const guide = pdfOf(
  [
    ["Contents", "Chapter two is on the next page.", "Read more on the web."],
    ["Chapter two", "The end."],
  ],
  {
    outline: [
      { title: "Chapter one", page: 1 },
      { title: "Chapter two", page: 2 },
    ],
    links: [
      { page: 1, rect: [40, 226, 330, 244], toPage: 2 },
      { page: 1, rect: [40, 206, 250, 224], uri: "https://example.com/more" },
    ],
  },
);

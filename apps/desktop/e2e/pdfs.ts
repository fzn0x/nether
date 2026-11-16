// PDFs for the end-to-end tests, desktop and web (ADR 0061): made here, as
// plain text, so that no binary file is kept for them.

/** A PDF of pages of lines in Helvetica, its text uncompressed, all ASCII. */
export function pdfOf(pages: readonly (readonly string[])[]): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${String(3 + index * 2)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
  ];
  const font = 3 + pages.length * 2;
  for (const [index, lines] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(4 + index * 2)} 0 R >>`,
    );
    const stream = `${["BT", "/F1 16 Tf", "40 250 Td", "20 TL", ...lines.flatMap((line) => [`(${line}) Tj`, "T*"]), "ET"].join("\n")}\n`;
    objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}endstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
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

// PDFs embedded in notes (ADR 0067): drawn by pdf.js in the note, once on
// screen and not before; the whole PDF at a page and a height, a passage
// or a box of a page alone, marked in its color; and a highlight's embed
// with its passage above it.
import { type Page, expect, test } from "@playwright/test";
import { errorsOf, openSampleTree, violations } from "./helpers.ts";
import { reading } from "./pdfs.ts";

/** Writes a file of the sample vault as another app would. */
async function edit(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ([file, next]) => {
      (
        globalThis as unknown as {
          netherPreview: { files: { edit(path: string, text: string): void } };
        }
      ).netherPreview.files.edit(file, next);
    },
    [path, text] as const,
  );
}

/** Whether the page has asked for pdf.js's worker, which loads with the code that draws PDFs. */
function watchPdfJs(page: Page): () => boolean {
  let asked = false;
  page.on("request", (request) => {
    if (request.url().includes("pdf.worker")) asked = true;
  });
  return () => asked;
}

test("PDFs embed in a note, drawn when on screen: whole, a passage, a box", async ({ page }) => {
  const errors = errorsOf(page);
  const pdfJs = watchPdfJs(page);
  const tree = await openSampleTree(page);
  await edit(page, "Papers/Reading.pdf", reading);
  // The embeds far down a note: nothing loads for them until they come near.
  const filler = Array.from({ length: 120 }, (_, index) => `Line ${String(index + 1)}.`).join(
    "\n\n",
  );
  await edit(
    page,
    "Embeds.md",
    [
      "# Embeds",
      "",
      filler,
      "",
      "![[Papers/Reading.pdf#page=2&height=300]]",
      "",
      "![[Papers/Reading.pdf#page=1&selection=1,13,1,25&color=red]]",
      "",
      "![[Papers/Reading.pdf#page=1&rect=40,226,330,244]]",
      "",
    ].join("\n"),
  );
  await tree.getByRole("treeitem", { name: "Embeds" }).click();
  const editor = page.getByRole("textbox", { name: "Embeds, note text" });
  await expect(editor).toContainText("Line 120.");
  const embeds = page.getByRole("figure", { name: "Reading, a PDF" });
  await expect(embeds).toHaveCount(3);
  await expect(page.locator(".pdf-embed-waiting").first()).toBeAttached();
  expect(pdfJs()).toBe(false);

  await embeds.first().scrollIntoViewIfNeeded();
  // The whole PDF, at its page, in a box of its height.
  const whole = embeds.first();
  await expect(whole).toContainText("Page 2 of 2");
  await expect
    .poll(() =>
      whole
        .locator('.pdf-page[data-page="2"] canvas')
        .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0);
  expect(pdfJs()).toBe(true);
  expect(
    await whole.locator(".pdf-embed-pages").evaluate((box) => box.getBoundingClientRect().height),
  ).toBe(300);

  // A passage alone, marked in PDF++'s red, cut to its line.
  const passage = embeds.nth(1);
  await passage.scrollIntoViewIfNeeded();
  const mark = passage.locator(".pdf-mark-highlight").first();
  await expect(mark).toBeVisible();
  expect(await mark.evaluate((element) => element.style.getPropertyValue("--mark-color"))).toBe(
    "#ea5252",
  );
  const cut = await passage.locator(".pdf-embed-cut").evaluate((box) => box.clientHeight);
  expect(cut).toBeLessThan(120);

  // PDF++'s box of a page: only the box, as wide as the embed.
  const box = embeds.nth(2);
  await box.scrollIntoViewIfNeeded();
  await expect(box.locator(".pdf-embed-cut .textLayer")).toContainText("Attention");
  expect(await violations(page)).toEqual([]);

  // Open goes to the PDF's tab, at the embed's page.
  await whole.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Reading" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("spinbutton", { name: /^Page/ })).toHaveValue("2");
  expect(errors).toEqual([]);
});

test("a highlight's embed shows its passage above it, as the PDF draws it", async ({ page }) => {
  const errors = errorsOf(page);
  const tree = await openSampleTree(page);
  await edit(page, "Papers/Reading.pdf", reading);
  await edit(
    page,
    "Papers/Reading highlights.md",
    "> [!quote] [[Reading.pdf#page=1&selection=1,13,1,25&color=note|Reading, page 1]]\n> all you need\n>\n> Why it matters.\n\n^hl000001\n",
  );
  await edit(page, "Cites.md", "# Cites\n\n![[Reading highlights#^hl000001]]\n");
  await tree.getByRole("treeitem", { name: "Cites" }).click();
  const embed = page.locator(".note-embed");
  await expect(embed).toContainText("Why it matters.");
  const figure = embed.getByRole("figure", { name: "Reading, a PDF" });
  await expect(figure).toContainText("Page 1");
  const mark = figure.locator(".pdf-mark-highlight").first();
  await expect(mark).toBeVisible();
  expect(await mark.evaluate((element) => element.style.getPropertyValue("--mark-color"))).toBe(
    "#086ddd",
  );
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

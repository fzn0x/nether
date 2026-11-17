// PDFs (ADR 0061): a PDF in the tree opens in a tab, drawn by pdf.js with
// its words over its pages; words selected, or found from the keyboard,
// become highlights in a note beside it, callouts linking to their passage
// as Obsidian links to one; a highlight is commented on and removed from
// the list; links to a passage or to a highlight open the PDF there; and
// it all runs under the web app's content security policy.
import { contentSecurityPolicy } from "@nether/server/src/web.ts";
import { type Page, expect, test } from "@playwright/test";
import { errorsOf, openSampleTree, violations } from "./helpers.ts";
import { guide, reading } from "./pdfs.ts";

interface PreviewFiles {
  edit(path: string, text: string | undefined): void;
  read(path: string): Promise<{ text: string; missing?: boolean }>;
}

/** Writes a file of the sample vault as another app would. */
async function edit(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ([file, next]) => {
      (
        globalThis as unknown as { netherPreview: { files: PreviewFiles } }
      ).netherPreview.files.edit(file, next);
    },
    [path, text] as const,
  );
}

/** A file of the sample vault, as Nether wrote it. */
function read(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (file) => {
    const got = await (
      globalThis as unknown as { netherPreview: { files: PreviewFiles } }
    ).netherPreview.files.read(file);
    return got.missing === true ? undefined : got.text;
  }, path);
}

/** Selects words on a page as a pointer would, in the text pdf.js laid over it. */
async function select(page: Page, number: number, words: string): Promise<void> {
  await page.evaluate(
    ([at, wanted]) => {
      const spans = document.querySelectorAll(
        `.pdf-page[data-page="${String(at)}"] .textLayer span`,
      );
      for (const span of spans) {
        const node = span.firstChild;
        const start = span.textContent.indexOf(wanted);
        if (!(node instanceof Text) || start === -1) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + wanted.length);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        return;
      }
      throw new Error(`${wanted} is not on page ${String(at)}.`);
    },
    [number, words] as const,
  );
}

async function openReading(page: Page) {
  const tree = await openSampleTree(page);
  await edit(page, "Papers/Reading.pdf", reading);
  await tree.getByRole("treeitem", { name: "Papers" }).click();
  await tree.getByRole("treeitem", { name: /^Reading\s*pdf$/ }).click();
  await expect(page.getByRole("tab", { name: "Reading" })).toHaveAttribute("aria-selected", "true");
  const first = page.getByRole("group", { name: "Page 1 of 2" });
  await expect(first.locator(".textLayer")).toContainText("Attention is all you need, they said.");
  return first;
}

const highlightsNote = "Papers/Reading highlights.md";

test("a PDF opens in a tab, and words selected become a highlight in a note beside it", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const first = await openReading(page);
  await expect(page.getByRole("heading", { name: "Reading", level: 1 })).toBeVisible();
  await expect(page.locator(".tree-file", { hasText: "Reading" })).toHaveAttribute(
    "data-kind",
    "pdf",
  );
  const list = page.getByRole("complementary", { name: "Highlights" });
  await expect(list).toContainText("No highlights yet");
  expect(await violations(page)).toEqual([]);

  const highlight = page.getByRole("button", { name: "Highlight", exact: true });
  await expect(highlight).toBeDisabled();
  await select(page, 1, "all you need");
  await expect(highlight).toBeEnabled();
  await highlight.click();
  await expect(page.locator(".pdf-status")).toHaveText("Highlighted: all you need");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem").first()).toContainText("Page 1");
  await expect(list.getByRole("listitem").first()).toContainText("all you need");
  // In a new note beside the PDF, as Obsidian's Copy link to selection links.
  await expect
    .poll(() => read(page, highlightsNote))
    .toMatch(
      /^> \[!quote\] \[\[Reading\.pdf#page=1&selection=1,13,1,25\|Reading, page 1\]\]\n> all you need\n\n\^[a-z0-9]{8}\n$/,
    );
  await expect(first.locator(".pdf-mark-chosen").first()).toBeVisible();

  // A comment goes in the highlight's callout.
  await list.getByRole("button", { name: "Comment", exact: true }).click();
  await list.getByRole("textbox", { name: "Comment" }).fill("Why it *matters*.");
  await list.getByRole("button", { name: "Save", exact: true }).click();
  await expect(list.locator(".pdf-highlight-comment")).toHaveText("Why it *matters*.");
  await expect
    .poll(() => read(page, highlightsNote))
    .toContain("> all you need\n>\n> Why it *matters*.\n");
  expect(await violations(page)).toEqual([]);

  // Removed, it leaves its note.
  await list.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(list).toContainText("No highlights yet");
  await expect.poll(() => read(page, highlightsNote)).not.toContain("all you need");
  expect(errors).toEqual([]);
});

test("the keyboard finds words, highlights them, and the list shows each in its place", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await openReading(page);
  const pages = page.getByRole("region", { name: "Reading: pages" });
  await pages.focus();
  await page.keyboard.press("Control+F");
  const field = page.getByRole("searchbox", { name: "Words to find" });
  await expect(field).toBeFocused();
  await field.fill("linkable  BLOCKS");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pdf-status")).toHaveText("1 of 1 places");
  await page.keyboard.press("Control+Shift+H");
  await expect(page.locator(".pdf-status")).toHaveText("Highlighted: linkable blocks");
  await expect
    .poll(() => read(page, highlightsNote))
    .toContain("[[Reading.pdf#page=1&selection=2,18,2,33|Reading, page 1]]\n> linkable blocks\n");

  // Words on the second page: found from the page shown on.
  await field.fill("these words");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pdf-status")).toHaveText("1 of 1 places");
  await page.keyboard.press("Control+Shift+H");
  const items = page.getByRole("complementary", { name: "Highlights" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  // The second went in the same note, at its end.
  await expect
    .poll(async () => (await read(page, highlightsNote))?.match(/> \[!quote\]/g)?.length)
    .toBe(2);
  await expect(items.nth(1)).toContainText("Page 2");

  // A highlight's place, from the list.
  await items
    .nth(1)
    .getByRole("button", { name: /these words/ })
    .click();
  await expect(
    page.getByRole("group", { name: "Page 2 of 2" }).locator(".pdf-mark-chosen").first(),
  ).toBeInViewport();
  expect(errors).toEqual([]);
});

test("links to a passage and to a highlight open the PDF there", async ({ page }) => {
  const errors = errorsOf(page);
  await openReading(page);
  await select(page, 1, "Reading notes");
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => read(page, highlightsNote)).toContain("^");
  const id = /\^([a-z0-9]{8})\n/.exec((await read(page, highlightsNote)) ?? "")?.[1] ?? "";
  expect(id).not.toBe("");

  await edit(
    page,
    "Essay.md",
    `# Essay\n\nAs [[Papers/Reading.pdf#page=2&selection=0,4,0,15|Reading, page 2]] says, and as [[Reading highlights#^${id}]] marks.\n`,
  );
  const tree = page.getByRole("tree", { name: "Notes" });
  await tree.getByRole("treeitem", { name: "Essay" }).click();
  const editor = page.getByRole("textbox", { name: "Essay, note text" });
  await editor.locator(".chip-wikiLink", { hasText: "Reading, page 2" }).click();
  await expect(page.getByRole("tab", { name: "Reading" })).toHaveAttribute("aria-selected", "true");
  const second = page.getByRole("group", { name: "Page 2 of 2" });
  // The link is the essay's own link to the passage (ADR 0062), chosen in the list.
  await expect(second.locator(".pdf-mark-chosen").first()).toBeInViewport();
  await expect(
    page.getByRole("list", { name: "Linked from notes" }).locator("li.chosen"),
  ).toContainText("in Essay");
  // Not a note made of the PDF's name.
  expect(await read(page, "Papers/Reading.pdf.md")).toBeUndefined();

  await tree.getByRole("treeitem", { name: "Essay" }).click();
  await editor.locator(".chip-wikiLink", { hasText: "Reading highlights" }).click();
  await expect(page.getByRole("tab", { name: "Reading" })).toHaveAttribute("aria-selected", "true");
  const chosen = page.getByRole("complementary", { name: "Highlights" }).locator("li.chosen");
  await expect(chosen).toContainText("Reading notes");
  await expect(
    page.getByRole("group", { name: "Page 1 of 2" }).locator(".pdf-mark-chosen").first(),
  ).toBeInViewport();

  // Shown in its note, from the list.
  await chosen.getByRole("button", { name: "Show in note" }).click();
  await expect(page.getByRole("tab", { name: "Reading highlights" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(errors).toEqual([]);
});

test("a PDF opens under the web app's content security policy", async ({ page }) => {
  const errors = errorsOf(page);
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": contentSecurityPolicy },
      });
    },
  );
  const first = await openReading(page);
  // Drawn: the worker parsed it, and the page's canvas has its pixels.
  await expect
    .poll(() => first.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width))
    .toBeGreaterThan(0);
  expect(errors.filter((error) => /content security policy|refused/i.test(error))).toEqual([]);
});

test("links to a passage in other notes show on the PDF, in PDF++'s colors", async ({ page }) => {
  const errors = errorsOf(page);
  await openReading(page);
  // Obsidian's Copy as quote, and PDF++'s Quote in callout, in red.
  await edit(
    page,
    "Quotes.md",
    [
      "> Attention is all you need [[Papers/Reading.pdf#page=1&selection=1,13,1,25|Reading, page 1]]",
      "",
      "> [!PDF|red] [[Papers/Reading.pdf#page=2&selection=0,4,0,15&color=red|Reading, page 2]]",
      "> > second page",
      ">",
      "> A comment.",
      "",
    ].join("\n"),
  );
  const linked = page.getByRole("list", { name: "Linked from notes" });
  const items = linked.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Page 1, Yellow, in Quotes");
  await expect(items.nth(0)).toContainText("Attention is all you need");
  await expect(items.nth(1)).toContainText("Page 2, Red, in Quotes");
  await expect(items.nth(1)).toContainText("second page");
  await expect(
    page.getByRole("group", { name: "Page 1 of 2" }).locator(".pdf-mark-highlight").first(),
  ).toBeVisible();

  await items
    .nth(1)
    .getByRole("button", { name: /second page/ })
    .click();
  const mark = page.getByRole("group", { name: "Page 2 of 2" }).locator(".pdf-mark-chosen").first();
  await expect(mark).toBeInViewport();
  expect(await mark.evaluate((element) => element.style.getPropertyValue("--mark-color"))).toBe(
    "#ea5252",
  );
  expect(await violations(page)).toEqual([]);

  // The notes' own text: shown in its note, never changed from here.
  await expect(linked.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await items.nth(1).getByRole("button", { name: "Show in note" }).click();
  await expect(page.getByRole("tab", { name: "Quotes" })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("highlights take a color, written as PDF++ writes it, and change it", async ({ page }) => {
  const errors = errorsOf(page);
  await openReading(page);
  await page.getByRole("combobox", { name: "Color of new highlights" }).selectOption("red");
  await select(page, 1, "all you need");
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect
    .poll(() => read(page, highlightsNote))
    .toContain("[[Reading.pdf#page=1&selection=1,13,1,25&color=red|Reading, page 1]]");
  const item = page
    .getByRole("complementary", { name: "Highlights" })
    .getByRole("listitem")
    .first();
  await expect(item).toContainText("Page 1, Red");

  const recolor = item.getByRole("combobox", { name: "Color", exact: true });
  await recolor.selectOption("note");
  await expect.poll(() => read(page, highlightsNote)).toContain("&color=note|Reading, page 1]]");
  await expect(item).toContainText("Page 1, Blue");
  // Yellow, the default, writes no color.
  await recolor.selectOption("yellow");
  await expect
    .poll(() => read(page, highlightsNote))
    .toContain("[[Reading.pdf#page=1&selection=1,13,1,25|Reading, page 1]]");
  expect(errors).toEqual([]);
});

test("the PDF's outline and its links go to their places, and Back returns", async ({
  page,
  context,
}) => {
  const errors = errorsOf(page);
  await context.route("https://example.com/**", (route) => route.fulfill({ body: "More" }));
  const tree = await openSampleTree(page);
  await edit(page, "Papers/Guide.pdf", guide);
  await tree.getByRole("treeitem", { name: "Papers" }).click();
  await tree.getByRole("treeitem", { name: /^Guide\s*pdf$/ }).click();
  const first = page.getByRole("group", { name: "Page 1 of 2" });
  await expect(first.locator(".textLayer")).toContainText("Chapter two is on the next page.");
  const shown = page.getByRole("spinbutton", { name: /^Page/ });
  const back = page.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeDisabled();

  await page.getByRole("button", { name: "Outline", exact: true }).click();
  const outline = page.getByRole("complementary", { name: "Outline" });
  await expect(outline.getByRole("button")).toHaveText(["Chapter one", "Chapter two"]);
  expect(await violations(page)).toEqual([]);
  await outline.getByRole("button", { name: "Chapter two" }).click();
  await expect(shown).toHaveValue("2");
  await back.click();
  await expect(shown).toHaveValue("1");
  await expect(back).toBeDisabled();

  // A link to the next page, over its words, from the keyboard too.
  const next = first.getByRole("button", { name: "Go to page 2" });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(shown).toHaveValue("2");
  await back.click();
  await expect(shown).toHaveValue("1");

  // A link to the web opens in the browser, never in the app's page.
  const popup = page.waitForEvent("popup");
  await first.getByRole("button", { name: "Open https://example.com/more" }).click();
  expect((await popup).url()).toBe("https://example.com/more");
  expect(page.url()).not.toContain("example.com");
  expect(errors).toEqual([]);
});

test("an area of a page is highlighted from the keyboard or by a drag, as PDF++'s rect", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await openReading(page);
  const area = page.getByRole("button", { name: "Area", exact: true });
  await area.click();
  await expect(area).toHaveAttribute("aria-pressed", "true");
  // A box in the middle of the page shown, which the keyboard moves and resizes.
  const box = page.getByRole("button", { name: /^Area on page 1:/ });
  await expect(box).toBeFocused();
  await expect(box).toHaveAccessibleName(/25% across, 35% down, 50% wide, 30% high/);
  await page.keyboard.press("ArrowRight");
  await expect(box).toHaveAccessibleName(/27% across, 35% down/);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(box).toHaveAccessibleName(/50% wide, 32% high/);
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page.locator(".pdf-status")).toHaveText("Highlighted an area of page 1.");
  await expect(area).toHaveAttribute("aria-pressed", "false");
  // The box in the PDF's own units, as PDF++ writes it, and no words.
  await expect
    .poll(() => read(page, highlightsNote))
    .toMatch(
      /^> \[!quote\] \[\[Reading\.pdf#page=1&rect=108,99,308,195\|Reading, page 1\]\]\n\n\^[a-z0-9]{8}\n$/,
    );
  const items = page.getByRole("complementary", { name: "Highlights" }).getByRole("listitem");
  await expect(items.first()).toContainText("An area of the page");
  await expect(
    page.getByRole("group", { name: "Page 1 of 2" }).locator(".pdf-mark-chosen").first(),
  ).toBeVisible();

  // With the pointer: a box dragged on the second page.
  await area.click();
  const second = page.getByRole("group", { name: "Page 2 of 2" });
  await second.scrollIntoViewIfNeeded();
  const frame = await second.boundingBox();
  if (frame === null) throw new Error("the second page is not on the screen");
  await page.mouse.move(frame.x + frame.width * 0.1, frame.y + frame.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.6, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: /^Area on page 2:/ })).toHaveAccessibleName(
    /10% across, 10% down, 40% wide, 50% high/,
  );
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect.poll(() => read(page, highlightsNote)).toContain("[[Reading.pdf#page=2&rect=");
  await expect(items).toHaveCount(2);
  expect(errors).toEqual([]);
});

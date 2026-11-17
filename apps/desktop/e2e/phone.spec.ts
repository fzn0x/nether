// The layout on a phone (ADR 0087), on a Pixel 7's viewport in Chromium, as
// Android's WebView is, and an iPhone 15's in WebKit, as iOS's is, pressed
// by touch: one note at a time under a bar, the sidebar a drawer, menus and
// dialogs sheets along the bottom, a bar of formatting over the keyboard,
// and every control big enough for a finger.
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { errorsOf } from "./helpers.ts";

/** What the page reports as errors, but WebKit's notes of a ResizeObserver loop, which it delivers next frame. */
function pageErrors(errors: readonly string[]): string[] {
  return errors.filter((error) => !error.startsWith("ResizeObserver loop"));
}

/** Opens the preview's sample vault, which shows under the phone's bar. */
async function openVault(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open a folder" }).tap();
  await expect(page.getByRole("button", { name: "Notes and menus", exact: true })).toBeVisible();
}

/** Opens the drawer from the bar, which takes the focus. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Notes and menus", exact: true }).tap();
  const drawer = page.getByRole("complementary", { name: "Sample vault" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close notes and menus" })).toBeFocused();
  return drawer;
}

/** Opens a note from the drawer's list of notes. */
async function openNote(page: Page, title: string): Promise<Locator> {
  const drawer = await openDrawer(page);
  await drawer.getByRole("button", { name: "List", exact: true }).tap();
  await drawer
    .getByRole("list", { name: "Notes" })
    .getByRole("button", { name: new RegExp(title) })
    .tap();
  await expect(drawer).toBeHidden();
  return page.getByRole("textbox", { name: `${title}, note text` });
}

/** Every control on screen smaller than 48 by 48 CSS pixels, outside the note's text. */
async function smallControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls =
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="treeitem"]';
    const small: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(controls)) {
      // The note's own text, and what is out of reach behind a drawer or a dialog.
      if (element.closest(".nether-editor, [inert]") !== null) continue;
      // A box, by its label, whose whole area a press reaches.
      const label = element.matches('input[type="checkbox"], input[type="radio"]')
        ? element.closest("label")
        : null;
      const box = (label ?? element).getBoundingClientRect();
      const shown =
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.top < innerHeight &&
        box.right > 0 &&
        box.left < innerWidth &&
        getComputedStyle(element).visibility !== "hidden";
      if (shown && (box.width < 47.5 || box.height < 47.5)) {
        const name = element.getAttribute("aria-label") ?? element.textContent.trim();
        small.push(
          `${name}: ${String(Math.round(box.width))} by ${String(Math.round(box.height))}`,
        );
      }
    }
    return small;
  });
}

async function violations(page: Page): Promise<string[]> {
  // Plugins' hidden sandboxed frames hold nothing to check, and WebKit never answers axe from them.
  const results = await new AxeBuilder({ page })
    .exclude(".plugin-frame")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
}

test("the vault shows one note under a bar, its notes in a drawer over it", async ({ page }) => {
  const errors = errorsOf(page);
  await openVault(page);
  const menu = page.getByRole("button", { name: "Notes and menus", exact: true });
  const drawer = page.getByRole("complementary", { name: "Sample vault" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toBeHidden();

  // A note opened from the drawer closes it, and shows alone, with no tabs.
  const editor = await openNote(page, "Welcome");
  await expect(editor).toBeVisible();
  await expect(page.locator(".phone-title")).toHaveText("Welcome");
  await expect(page.getByRole("tablist")).toHaveCount(0);

  // Escape closes the drawer, which gives the focus back to its button.
  await openDrawer(page);
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();

  // So does a press beside it.
  await openDrawer(page);
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  await page.touchscreen.tap(size.width - 10, size.height / 2);
  await expect(drawer).toBeHidden();
  expect(pageErrors(errors)).toEqual([]);
});

test("menus and dialogs are sheets along the bottom, without tabs or panes", async ({ page }) => {
  await openVault(page);
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const isSheet = async (sheet: Locator) => {
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(size.width);
    expect(Math.round(box.y + box.height)).toBe(size.height);
  };

  const drawer = await openDrawer(page);
  await drawer.getByRole("menuitem", { name: "File" }).tap();
  const file = page.getByRole("menu", { name: "File" });
  await expect(file).toBeVisible();
  await isSheet(file);
  await expect(file.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(file).toBeHidden();

  // A note's menu offers no tab or pane to open it in.
  await drawer.getByRole("button", { name: "List", exact: true }).tap();
  await drawer
    .getByRole("list", { name: "Notes" })
    .getByRole("button", { name: /Welcome/ })
    .click({ button: "right" });
  const noteMenu = page.getByRole("menu").last();
  await expect(noteMenu).toBeVisible();
  await isSheet(noteMenu);
  await expect(noteMenu.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await expect(noteMenu.getByRole("menuitem", { name: "Open in new tab" })).toHaveCount(0);
  await expect(noteMenu.getByRole("menuitem", { name: "Open to the right" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The palette is a sheet too, and leaves out the commands about tabs and panes.
  await page.getByRole("button", { name: "Command palette" }).tap();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await isSheet(palette);
  await page.getByRole("combobox", { name: "Command" }).fill("the right");
  await expect(palette.getByRole("option", { name: /Open the note to the right/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Command" }).fill("tab");
  await expect(palette.getByRole("option", { name: /Show the next tab/ })).toHaveCount(0);
});

test("the bar over the keyboard formats, moves blocks, and leaves the focus in the note", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await openVault(page);
  const editor = await openNote(page, "Welcome");
  const formatting = page.getByRole("toolbar", { name: "Formatting" });
  await expect(formatting).toBeHidden();

  await editor.locator("p").first().tap();
  await expect(formatting).toBeVisible();
  // Above the bottom of the window, over everything else.
  const box = await formatting.boundingBox();
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  expect(box !== null && Math.round(box.y + box.height) <= size.height).toBe(true);

  // The paragraph moves above the heading, the caret staying in it.
  await formatting.getByRole("button", { name: "Move up" }).tap();
  await expect(editor.locator(":scope > *").first()).toHaveText(/^Notes are plain/);
  await expect(editor).toBeFocused();

  // Bold, pressed then typed.
  await page.keyboard.press("End");
  const bold = formatting.getByRole("button", { name: "Bold" });
  await bold.tap();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("strong words");
  await expect(editor.locator("strong", { hasText: "strong words" })).toBeVisible();
  await expect(editor).toBeFocused();

  // A list from the bar, indented in it once there is an item before.
  await page.keyboard.press("Enter");
  await formatting.getByRole("button", { name: "Bold" }).tap();
  await formatting.getByRole("button", { name: "Bulleted list" }).tap();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await formatting.getByRole("button", { name: "Indent" }).tap();
  await expect(editor.locator("ul ul li", { hasText: "second" })).toBeVisible();

  // Putting the keyboard away puts the bar away too.
  await formatting.getByRole("button", { name: "Hide the keyboard" }).tap();
  await expect(formatting).toBeHidden();
  expect(pageErrors(errors)).toEqual([]);
});

test("a property moves up and down from its handle's menu, with no drag", async ({ page }) => {
  await openVault(page);
  await openNote(page, "Welcome");
  const properties = page.getByRole("region", { name: "Properties" });
  await properties.getByRole("button", { name: "Add a property" }).tap();
  await page.keyboard.press("Enter");
  const order = () =>
    properties
      .getByRole("group")
      .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
  await expect.poll(order).toEqual(["tags", "property"]);

  await properties.getByRole("button", { name: "Move property", exact: true }).tap();
  const menu = page.getByRole("menu", { name: "Move property" });
  await expect(menu.getByRole("menuitem", { name: "Move property down" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await menu.getByRole("menuitem", { name: "Move property up" }).tap();
  await expect.poll(order).toEqual(["property", "tags"]);
  await expect(
    properties.getByRole("button", { name: "Move property", exact: true }),
  ).toBeFocused();
});

test("every control a finger reaches is at least 48 pixels square", async ({ page }) => {
  await openVault(page);
  expect(await smallControls(page)).toEqual([]);
  const drawer = await openDrawer(page);
  expect(await smallControls(page)).toEqual([]);
  await drawer.getByRole("menuitem", { name: "File" }).tap();
  expect(await smallControls(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  const editor = await openNote(page, "Welcome");
  expect(await smallControls(page)).toEqual([]);
  await editor.locator("p").first().tap();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  expect(await smallControls(page)).toEqual([]);

  await page.getByRole("button", { name: "Command palette" }).tap();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  expect(await smallControls(page)).toEqual([]);
});

test("a database fits the phone's width, its views scrolling on their own", async ({ page }) => {
  await openVault(page);
  const drawer = await openDrawer(page);
  await drawer.getByRole("button", { name: "New database" }).tap();
  const database = page.getByRole("region", { name: "Database" });
  await expect(database).toBeVisible();
  await expect(drawer).toBeHidden();
  // The page never scrolls sideways; a view wider than the phone scrolls inside it.
  const width = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  const panel = database.getByRole("tabpanel");
  expect(await panel.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
  expect(await smallControls(page)).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`in the ${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("the phone's screens pass axe", async ({ page }) => {
      // Five screens checked in full, which WebKit takes its time over.
      test.slow();
      await openVault(page);
      expect(await violations(page)).toEqual([]);
      const drawer = await openDrawer(page);
      // Once it has slid in.
      await expect(drawer).toHaveCSS("transform", "none");
      expect(await violations(page)).toEqual([]);
      await drawer.getByRole("menuitem", { name: "File" }).tap();
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      const editor = await openNote(page, "Welcome");
      await editor.locator("p").first().tap();
      await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      await page.getByRole("button", { name: "Command palette" }).tap();
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  });
}

test("the drawer opens from the right, right to left", async ({ page }) => {
  await openVault(page);
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  const drawer = await openDrawer(page);
  await expect(drawer).toHaveCSS("transform", "none");
  const box = await drawer.boundingBox();
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  expect(box !== null && Math.round(box.x + box.width) === size.width && box.x > 0).toBe(true);
});

import { type Page, expect, test } from "@playwright/test";
import { errorsOf, openSample, openSampleTree, violations } from "./helpers.ts";

/** A file of the sample vault, as the app last wrote it. */
async function fileText(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (file) => {
    const preview = (
      globalThis as unknown as {
        netherPreview: {
          files: { read(path: string): Promise<{ text: string; missing?: boolean }> };
        };
      }
    ).netherPreview;
    const read = await preview.files.read(file);
    return read.missing === true ? undefined : read.text;
  }, path);
}

/** Opens the vault's settings at a tab, from the Settings menu. */
async function openSettings(page: Page, item: RegExp) {
  await page.getByRole("menuitem", { name: "Settings" }).click();
  // A plugin's commands make a Plugins menu beside it.
  await page.getByRole("menu", { name: "Settings" }).getByRole("menuitem", { name: item }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

test("the settings turn a built-in plugin off and on again, and the vault keeps it", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await openSample(page);
  const tagsTab = page.locator(".sidebar-tabs").getByRole("button", { name: "Tags" });
  await expect(tagsTab).toBeVisible();

  const settings = await openSettings(page, /^Plugins/);
  const plugins = settings.getByRole("tabpanel", { name: "Plugins" });
  await expect(settings.getByRole("tab", { name: "Plugins" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await violations(page)).toEqual([]);
  await plugins.getByRole("checkbox", { name: "Tags" }).uncheck();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();
  // What it added goes: its tab in the sidebar.
  await expect(tagsTab).toBeHidden();
  await expect
    .poll(async () => JSON.parse((await fileText(page, ".nether/plugins.json")) ?? "{}") as unknown)
    .toEqual({
      mermaid: true,
      query: true,
      tags: false,
      assigned: true,
      outline: true,
      backlinks: true,
      canvas: true,
      graph: true,
      layouts: true,
    });

  await openSettings(page, /^Plugins/);
  await plugins.getByRole("checkbox", { name: "Tags" }).check();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(tagsTab).toBeVisible();
  expect(errors).toEqual([]);
});

test("the settings' tabs move with the arrow keys, and Escape closes them", async ({ page }) => {
  await openSample(page);
  const settings = await openSettings(page, /^Appearance/);
  const appearance = settings.getByRole("tab", { name: "Appearance" });
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await appearance.focus();
  await page.keyboard.press("ArrowDown");
  const shortcuts = settings.getByRole("tab", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeFocused();
  await expect(settings.getByRole("tabpanel", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(settings.getByRole("tabpanel", { name: "Templates" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(settings.getByRole("tab", { name: "Backlinks" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});

test("a plugin's settings change what it shows, and the vault keeps them", async ({ page }) => {
  const errors = errorsOf(page);
  const notes = await openSample(page);
  await notes.getByRole("button", { name: /Roadmap/ }).click();
  const linkedFrom = page
    .getByRole("complementary", { name: "About this note" })
    .getByRole("region", { name: "Linked from" });
  await expect(linkedFrom).toContainText("Notes are plain Markdown files");

  const settings = await openSettings(page, /^Plugins/);
  await settings.getByRole("tab", { name: "Backlinks" }).click();
  const backlinks = settings.getByRole("tabpanel", { name: "Backlinks" });
  const context = backlinks.getByRole("checkbox", { name: "Show the text around each link" });
  await expect(context).toBeChecked();
  expect(await violations(page)).toEqual([]);
  await context.uncheck();
  await backlinks.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();

  // The notes that link here still show, without their text.
  await expect(linkedFrom.getByRole("button", { name: "Welcome" })).toBeVisible();
  await expect(linkedFrom).not.toContainText("Notes are plain Markdown files");
  await expect
    .poll(() => fileText(page, ".nether/plugins/backlinks/data.json"))
    .toBe('{\n  "context": false\n}\n');
  expect(errors).toEqual([]);
});

test("with the canvas plugin off, a canvas says no plugin opens it, and New canvas waits", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const tree = await openSampleTree(page);
  await page.evaluate(() => {
    (
      globalThis as unknown as {
        netherPreview: { files: { edit(path: string, text: string | undefined): void } };
      }
    ).netherPreview.files.edit("Projects/Board.canvas", '{"nodes":[],"edges":[]}');
  });
  const settings = await openSettings(page, /^Plugins/);
  const plugins = settings.getByRole("tabpanel", { name: "Plugins" });
  await plugins.getByRole("checkbox", { name: "Canvas" }).uncheck();
  await plugins.getByRole("button", { name: "Save" }).click();

  await tree.getByRole("treeitem", { name: "Projects" }).click();
  await tree.getByRole("treeitem", { name: /^Board/ }).click();
  await expect(page.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No plugin here opens .canvas files.")).toBeVisible();
  await page.getByRole("menuitem", { name: "File" }).click();
  await expect(page.getByRole("menuitem", { name: /^New canvas/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");

  // On again, the canvas opens.
  await openSettings(page, /^Plugins/);
  await plugins.getByRole("checkbox", { name: "Canvas" }).check();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("with the layouts plugin off, a board shows as a table, and keeps its layout", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await openSample(page);
  await page.keyboard.press("Control+p");
  await page.keyboard.type("new database");
  await page.keyboard.press("Enter");
  await expect(page.locator("#note-title")).toHaveText("Untitled database");
  const database = page.getByRole("region", { name: "Database" });
  await database.getByRole("button", { name: "Properties" }).click();
  await database.getByRole("textbox", { name: "Property name" }).fill("Status");
  await database.getByRole("combobox", { name: "Type of the new property" }).selectOption("Select");
  await database.getByRole("button", { name: "Add a property" }).click();
  const layout = database.getByRole("combobox", { name: "Layout" });
  await layout.selectOption("board");
  await expect(database.getByRole("combobox", { name: "Columns" })).toHaveValue("Status");

  const settings = await openSettings(page, /^Plugins/);
  const plugins = settings.getByRole("tabpanel", { name: "Plugins" });
  await plugins.getByRole("checkbox", { name: "Database layouts" }).uncheck();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(
    database.getByText("No plugin here shows the board layout, so its rows show as a table."),
  ).toBeVisible();
  await expect(database.getByRole("table")).toBeVisible();
  // The view is still a board, as the note's schema says.
  await expect(layout).toHaveValue("board");
  await expect.poll(() => fileText(page, "Untitled database.md")).toContain("layout: board");

  await openSettings(page, /^Plugins/);
  await plugins.getByRole("checkbox", { name: "Database layouts" }).check();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(database.getByRole("combobox", { name: "Columns" })).toHaveValue("Status");
  expect(errors).toEqual([]);
});

test("a property of a type no plugin here has edits as what it stores as, and keeps its type", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const notes = await openSample(page);
  await page.evaluate(() => {
    const files = (
      globalThis as unknown as {
        netherPreview: { files: { edit(path: string, text: string): void } };
      }
    ).netherPreview.files;
    files.edit(".nether/properties.json", '{"rating":{"type":"stars/rating","stores":"number"}}');
    files.edit("Rated.md", "---\nrating: 4\n---\n\nA rated note.\n");
  });
  await notes.getByRole("button", { name: /^Rated/ }).click();
  const properties = page.getByRole("region", { name: "Properties" });
  // Its type is named as the vault has it, and its value is a number.
  const type = properties.getByRole("combobox", { name: "Type of rating" });
  await expect(type).toHaveValue("stars/rating");
  await expect(type.locator("option:checked")).toHaveText("stars/rating");
  const value = properties.getByRole("spinbutton", { name: "rating" });
  await expect(value).toHaveValue("4");
  await value.fill("5");
  await value.press("Enter");
  await expect.poll(() => fileText(page, "Rated.md")).toContain("rating: 5");
  // The vault still says what the type is.
  expect(JSON.parse((await fileText(page, ".nether/properties.json")) ?? "{}")).toEqual({
    rating: { type: "stars/rating", stores: "number" },
  });
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

/** Edits files of the sample vault, as another app would. */
async function editFiles(page: Page, files: Readonly<Record<string, string>>) {
  await page.evaluate((edits) => {
    const preview = (
      globalThis as unknown as {
        netherPreview: { files: { edit(path: string, text: string): void } };
      }
    ).netherPreview;
    for (const [path, text] of Object.entries(edits)) preview.files.edit(path, text);
  }, files);
}

const echoManifest = JSON.stringify({
  id: "echo",
  name: "Echo",
  version: "1.0.0",
  api: "^0.1",
  contributes: {
    commands: [{ id: "fetch", name: "Fetch from elsewhere" }],
    codeBlocks: [{ language: "echo" }],
  },
});

// A plugin as its author would bundle it: one module, its plugin as its default.
const echoCode = `export default {
  async activate(context) {
    await context.codeBlocks.register("echo", (source) => ({
      html: '<b class="echoed">' + source.trim() + '</b>' +
        '<img src="https://example.com/a.png" onerror="document.title = 42">',
    }));
    await context.commands.register("fetch", async () => {
      await fetch("https://example.com/");
    });
  },
};
`;

test("a plugin from the vault runs once approved, apart, and is off again when its code changes", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const notes = await openSample(page);
  await editFiles(page, {
    ".nether/plugins/echo/manifest.json": echoManifest,
    ".nether/plugins/echo/main.js": echoCode,
    "Echoed.md": "Before.\n\n```echo\nhello\n```\n",
  });

  const settings = await openSettings(page, /^Plugins/);
  const plugins = settings.getByRole("tabpanel", { name: "Plugins" });
  await expect(plugins.getByRole("heading", { name: "From this vault" })).toBeVisible();
  await expect(plugins.getByText(/Version 1\.0\.0\. It asks for nothing more\./)).toBeVisible();
  expect(await violations(page)).toEqual([]);
  const echo = plugins.getByRole("checkbox", { name: "Echo" });
  await expect(echo).not.toBeChecked();
  await echo.check();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();
  expect(JSON.parse((await fileText(page, ".nether/plugins.json")) ?? "{}")).toMatchObject({
    echo: true,
  });

  // What it draws shows, cleaned: no handler, and no address outside the page.
  await notes.getByRole("button", { name: /^Echoed/ }).click();
  const output = page.locator('.code-output[data-language="echo"]');
  await expect(output.locator("b.echoed")).toHaveText("hello");
  const image = output.locator("img");
  await expect(image).toHaveCount(1);
  expect(await image.evaluate((element) => element.getAttributeNames())).toEqual([]);
  await expect(page.locator("iframe.plugin-frame")).toHaveCount(1);

  // It reaches nothing outside: its request fails, and says so.
  await page.keyboard.press("Control+p");
  await page.keyboard.type("Fetch from elsewhere");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/^The plugin echo failed: /)).toBeVisible();
  expect(await page.title()).not.toBe("42");

  // Its code changed: it stops, and waits for this device to approve it again.
  await editFiles(page, { ".nether/plugins/echo/main.js": `${echoCode}// changed\n` });
  await openSettings(page, /^Plugins/);
  await expect(
    plugins.getByText(
      "The vault has it on, but this device has not approved it as it is now. Turn it on to approve it.",
    ),
  ).toBeVisible();
  await expect(plugins.getByRole("checkbox", { name: "Echo" })).not.toBeChecked();
  await expect(page.locator("iframe.plugin-frame")).toHaveCount(0);
  // Only its blocked request complains.
  expect(errors.filter((error) => !/example\.com|Failed to fetch/.test(error))).toEqual([]);
});

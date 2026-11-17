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
      automations: true,
      tags: false,
      assigned: true,
      outline: true,
      backlinks: true,
      canvas: true,
      graph: true,
      pdf: true,
      layouts: true,
      // Nether's integrations start off (ADR 0090).
      calendar: false,
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

const countsManifest = JSON.stringify({
  id: "counts",
  name: "Counts",
  version: "1.0.0",
  api: "^0.1",
  permissions: ["vault:read", "vault:write"],
  contributes: {
    commands: [
      { id: "count", name: "Count the notes" },
      { id: "tidy", name: "Tidy the count away" },
      { id: "peek", name: "Peek at the plugins" },
    ],
  },
});

// A plugin that reads the vault and writes a note of its own.
const countsCode = `export default {
  async activate(context) {
    await context.commands.register("count", async () => {
      const notes = await context.vault.notes();
      const first = await context.vault.read(notes[0].path);
      await context.vault.write(
        "Counted.md",
        "There are " + notes.length + " notes. The first starts " + JSON.stringify(first.slice(0, 5)) + ".\\n",
      );
    });
    await context.commands.register("tidy", async () => {
      await context.vault.remove("Counted.md");
    });
    await context.commands.register("peek", async () => {
      await context.vault.read(".nether/plugins.json");
    });
  },
};
`;

/** Runs a command from the palette. */
async function runCommand(page: Page, name: string) {
  await page.keyboard.press("Control+p");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("a plugin from the vault reads and writes notes through the app, and no hidden folder", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const notes = await openSample(page);
  await editFiles(page, {
    ".nether/plugins/counts/manifest.json": countsManifest,
    ".nether/plugins/counts/main.js": countsCode,
  });
  const settings = await openSettings(page, /^Plugins/);
  const plugins = settings.getByRole("tabpanel", { name: "Plugins" });
  await expect(
    plugins.getByText("It asks for reading the vault's notes and files and changing them."),
  ).toBeVisible();
  await plugins.getByRole("checkbox", { name: "Counts" }).check();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();

  await runCommand(page, "Count the notes");
  await expect(notes.getByRole("button", { name: /^Counted/ })).toBeVisible();
  expect(await fileText(page, "Counted.md")).toMatch(
    /^There are \d+ notes\. The first starts ".+"\.\n$/,
  );

  // Moved to the trash as the app moves a note there, with the way back.
  await runCommand(page, "Tidy the count away");
  await expect(page.getByText("The plugin counts moved Counted to the trash.")).toBeVisible();
  await expect(notes.getByRole("button", { name: /^Counted/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(notes.getByRole("button", { name: /^Counted/ })).toBeVisible();

  // A hidden folder is not the vault's notes.
  await runCommand(page, "Peek at the plugins");
  await expect(page.getByText(/^The plugin counts failed: .*A plugin reaches no/)).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

const tallyManifest = JSON.stringify({
  id: "tally",
  name: "Tally",
  version: "1.0.0",
  api: "^0.1",
  contributes: { panels: [{ id: "count", name: "Count", place: "note" }] },
});

// A panel drawn in the plugin's worker, with what the page must leave out.
const tallyCode = `export default {
  async activate(context) {
    await context.panels.register("count", {
      mount(element) {
        const style = document.createElement("style");
        style.textContent = ".n { color: rgb(1, 2, 3) } .bad { background: url(https://example.com/x.png) }";
        const button = document.createElement("button");
        button.className = "n bad";
        let clicks = 0;
        button.textContent = "Clicked 0";
        button.addEventListener("click", () => {
          clicks++;
          button.textContent = "Clicked " + clicks;
        });
        const input = document.createElement("input");
        input.setAttribute("aria-label", "Say");
        const said = document.createElement("output");
        input.addEventListener("input", (event) => {
          said.textContent = event.target.value.toUpperCase();
        });
        const image = document.createElement("img");
        image.setAttribute("src", "https://example.com/a.png");
        image.setAttribute("alt", "");
        image.setAttribute("onerror", "document.title = 42");
        const script = document.createElement("script");
        script.textContent = "document.title = 42";
        element.append(style, button, input, said, image, script);
      },
    });
  },
};
`;

test("a plugin from the vault draws its panel apart, and the page shows it cleaned", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.com")) asked.push(request.url());
  });
  const notes = await openSample(page);
  await editFiles(page, {
    ".nether/plugins/tally/manifest.json": tallyManifest,
    ".nether/plugins/tally/main.js": tallyCode,
    "Tallied.md": "Counted here.\n",
  });
  const settings = await openSettings(page, /^Plugins/);
  const plugins = settings.getByRole("tabpanel", { name: "Plugins" });
  await plugins.getByRole("checkbox", { name: "Tally" }).check();
  await plugins.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();

  await notes.getByRole("button", { name: /^Tallied/ }).click();
  const panel = page.getByRole("region", { name: "Count" });
  const button = panel.getByRole("button", { name: "Clicked 0" });
  await expect(button).toBeVisible();
  // Its own style shows, and the rule that would load from elsewhere does not.
  await expect(button).toHaveCSS("color", "rgb(1, 2, 3)");
  const sheets = await panel.evaluate((section) =>
    [...section.querySelectorAll("*")]
      .flatMap((element) => [...(element.shadowRoot?.querySelectorAll("style") ?? [])])
      .map((style) => style.textContent)
      .join("\n"),
  );
  expect(sheets).toContain("rgb(1, 2, 3)");
  expect(sheets).not.toContain("example.com");

  await button.click();
  await expect(panel.getByRole("button", { name: "Clicked 1" })).toBeVisible();
  await panel.getByRole("textbox", { name: "Say" }).fill("loud");
  await expect(panel.locator("output")).toHaveText("LOUD");
  const image = panel.locator("img");
  await expect(image).toHaveCount(1);
  expect(await image.evaluate((element) => element.getAttributeNames())).toEqual(["alt"]);
  await expect(panel.locator("script")).toHaveCount(0);
  expect(await page.title()).not.toBe("42");
  expect(asked).toEqual([]);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

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

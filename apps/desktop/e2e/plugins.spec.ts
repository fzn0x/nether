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
  await page.getByRole("menuitem", { name: item }).click();
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

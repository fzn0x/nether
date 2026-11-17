// A database's triggers (ADR 0072): a rule added in its settings sets a
// row's properties when the app changes one into its value, in a table's
// cell or by a card moved on a board, and not when another app edits it.
import { type Page, expect, test } from "@playwright/test";
import { errorsOf, openSample, violations } from "./helpers.ts";

// Friday, 6 November 2026, where the browser is.
const friday = new Date(2026, 10, 6, 9, 30);

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

/** Changes a file of the sample vault as another app, such as Obsidian, would. */
async function editFile(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ([file, next]) => {
      const preview = (
        globalThis as unknown as {
          netherPreview: { files: { edit(path: string, text: string): void } };
        }
      ).netherPreview;
      preview.files.edit(file ?? "", next ?? "");
    },
    [path, text],
  );
}

const tasks = `---
database:
  properties:
    - key: Status
      type: select
      options:
        - name: Doing
        - name: Done
    - key: Completed
      type: date
  views:
    - name: Table
      layout: table
      visible: [Status, Completed]
    - name: Board
      layout: board
      groupBy: Status
      visible: [Completed]
---
`;

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(friday);
});

test("a trigger sets Completed when Status becomes Done in a cell or on a board, not from outside", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const notes = await openSample(page);
  await editFile(page, "Tasks.md", tasks);
  for (const name of ["Write", "Ship", "Read"]) {
    await editFile(page, `Tasks/${name}.md`, "---\nStatus: Doing\n---\n");
  }
  await notes.getByRole("button", { name: /^Tasks/ }).click();
  await expect(page.locator("#note-title")).toHaveText("Tasks");
  const database = page.getByRole("region", { name: "Database" });
  await expect(database.getByRole("table").getByRole("rowheader")).toHaveCount(3);

  // The rule, added in the database's settings: a date is set to the day it fires.
  await database.getByRole("button", { name: "Triggers" }).click();
  const triggers = database.getByRole("group", { name: "Triggers" });
  await expect(triggers.getByText("No triggers yet.")).toBeVisible();
  const form = triggers.getByRole("form", { name: "New trigger" });
  await expect(form.getByRole("combobox", { name: "When" })).toHaveValue("Status");
  // Its value offers the select's options.
  await form.getByRole("combobox", { name: "becomes" }).fill("Done");
  await expect(form.getByRole("combobox", { name: "set" })).toHaveValue("Completed");
  await expect(form.getByRole("textbox", { name: "to" })).toHaveValue("{{date}}");
  await form.getByRole("button", { name: "Add the trigger" }).click();
  await expect(triggers.getByRole("listitem")).toHaveText([
    "When Status becomes Done, set Completed to {{date}}Remove",
  ]);
  await expect(database.getByRole("button", { name: "Triggers (1)" })).toBeVisible();
  await expect
    .poll(() => fileText(page, "Tasks.md"))
    .toContain("  triggers:\n    - when: Status\n      is: Done\n      set:\n        Completed:");
  expect(await violations(page)).toEqual([]);

  // A cell set to Done sets the row's Completed to today.
  const status = database.getByLabel("Status of Write", { exact: true });
  await status.fill("Done");
  await status.press("Enter");
  await expect
    .poll(() => fileText(page, "Tasks/Write.md"))
    .toBe("---\nStatus: Done\nCompleted: 2026-11-06\n---\n");
  await expect(database.getByLabel("Completed of Write", { exact: true })).toHaveValue(
    "2026-11-06",
  );

  // A card moved to Done on the board does the same.
  await database.getByRole("tab", { name: "Board" }).click();
  const column = (name: string) => database.getByRole("region", { name, exact: true });
  await column("Doing").getByRole("combobox", { name: "Move Ship to" }).selectOption({
    label: "Done",
  });
  await expect
    .poll(() => fileText(page, "Tasks/Ship.md"))
    .toBe("---\nStatus: Done\nCompleted: 2026-11-06\n---\n");

  // Another app setting Done runs no trigger: the board shows it, and its file stays as written.
  await editFile(page, "Tasks/Read.md", "---\nStatus: Done\n---\n");
  await expect(column("Done").getByRole("listitem")).toHaveCount(3);
  await page.waitForTimeout(1000);
  expect(await fileText(page, "Tasks/Read.md")).toBe("---\nStatus: Done\n---\n");

  // The settings stay open on the board, where the rule is removed.
  await expect(database.getByRole("button", { name: "Triggers (1)" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await triggers
    .getByRole("button", {
      name: "Remove the trigger: When Status becomes Done, set Completed to {{date}}",
    })
    .click();
  await expect(triggers.getByText("No triggers yet.")).toBeVisible();
  await expect.poll(() => fileText(page, "Tasks.md")).not.toContain("triggers:");
  expect(errors).toEqual([]);
});

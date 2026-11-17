// Buttons (ADR 0072): a `meta-bind-button` block, as Meta Bind writes it,
// shows a button below its code that runs its actions through the app.
import { type Page, expect, test } from "@playwright/test";
import { endOfFirstParagraph, errorsOf, openNote, openSample, violations } from "./helpers.ts";

// Friday, 6 November 2026, where the browser is: not a day the sample has a note for.
const friday = new Date(2026, 10, 6, 9, 30);

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

/** A note holding one button block, its lines as given. */
const withButton = (properties: string, lines: readonly string[]) =>
  `---\n${properties}\n---\n\n\`\`\`meta-bind-button\n${lines.join("\n")}\n\`\`\`\n`;

/** Opens a note made of a button block, and gives its button. */
async function openButton(page: Page, name: string, lines: readonly string[], label: string) {
  const notes = await openSample(page);
  await editFile(page, `${name}.md`, withButton("status: open", lines));
  await notes.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.locator("#note-title")).toHaveText(name);
  return page.getByRole("button", { name: label, exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(friday);
});

test("a button sets its note's property, then makes a note from a template and opens it", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const lines = [
    "label: Hold the retro",
    "style: primary",
    "tooltip: Marks this done and starts the notes",
    "actions:",
    "  - type: updateMetadata",
    "    bindTarget: status",
    "    evaluate: false",
    "    value: Done",
    "  - type: templaterCreateNote",
    "    templateFile: Templates/Meeting.md",
    "    folderPath: Meetings",
    "    fileName: Retro",
    "    openNote: true",
  ];
  const button = await openButton(page, "Retro plan", lines, "Hold the retro");
  await expect(button).toHaveAttribute("title", "Marks this done and starts the notes");
  expect(await violations(page)).toEqual([]);
  await button.click();

  await expect(page.locator("#note-title")).toHaveText("Retro");
  await expect.poll(() => fileText(page, "Retro plan.md")).toBe(withButton("status: Done", lines));
  const made = await fileText(page, "Meetings/Retro.md");
  expect(made).toContain('created: "2026-11-06"');
  expect(made).toContain("# Retro\n");

  // Clicked again, the note's name is taken: the next is beside it, and stays closed.
  await editFile(
    page,
    "Retro plan.md",
    withButton(
      "status: open",
      lines.map((line) => (line === "    openNote: true" ? "    openNote: false" : line)),
    ),
  );
  await page
    .getByRole("list", { name: "Notes" })
    .getByRole("button", { name: /^Retro plan/ })
    .click();
  await page.getByRole("button", { name: "Hold the retro", exact: true }).click();
  await expect.poll(() => fileText(page, "Meetings/Retro 2.md")).toContain("# Retro 2\n");
  await expect(page.locator("#note-title")).toHaveText("Retro plan");
  expect(errors).toEqual([]);
});

test("a button asks before it runs a command, then not again until the button changes", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const lines = [
    "label: Close the day",
    "actions:",
    "  - type: updateMetadata",
    "    bindTarget: status",
    "    value: closed",
    "  - type: command",
    "    command: dayNote",
  ];
  const button = await openButton(page, "Today", lines, "Close the day");
  const title = page.locator("#note-title");
  const ask = page.getByRole("alertdialog", { name: "Run this button?" });

  // It names the command as the palette does; Cancel runs none of its actions.
  await button.click();
  await expect(ask).toHaveAccessibleDescription("This button runs: Open today's note. Run it?");
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await violations(page)).toEqual([]);
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  await expect(title).toHaveText("Today");
  expect(await fileText(page, "Today.md")).toContain("status: open");

  // Run runs them all.
  await button.click();
  await ask.getByRole("button", { name: "Run" }).click();
  await expect(title).toHaveText("2026-11-06");
  await expect.poll(() => fileText(page, "Today.md")).toContain("status: closed");

  // On this device, the button as it is runs at once.
  const notes = page.getByRole("list", { name: "Notes" });
  await notes.getByRole("button", { name: /^Today/ }).click();
  await expect(title).toHaveText("Today");
  await page.getByRole("button", { name: "Close the day", exact: true }).click();
  await expect(title).toHaveText("2026-11-06");
  await expect(ask).toHaveCount(0);

  // Edited, it asks again.
  await notes.getByRole("button", { name: /^Today/ }).click();
  await expect(title).toHaveText("Today");
  await editFile(
    page,
    "Today.md",
    withButton(
      "status: open",
      lines.map((line) => (line === "label: Close the day" ? "label: End the day" : line)),
    ),
  );
  await page.getByRole("button", { name: "End the day", exact: true }).click();
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  await expect(title).toHaveText("Today");
  expect(errors).toEqual([]);
});

test("a button says when Nether has no command it names, and asks nothing", async ({ page }) => {
  const errors = errorsOf(page);
  const missing = await openButton(
    page,
    "Bold",
    [
      "label: Bold it",
      "actions:",
      "  - type: command",
      "    command: editor:toggle-bold",
      "  - type: updateMetadata",
      "    bindTarget: status",
      "    value: bold",
    ],
    "Bold it",
  );
  await missing.click();
  await expect(page.getByRole("alert")).toHaveText(
    "The button stopped: Nether has no command editor:toggle-bold.",
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  // The actions after it do not run.
  expect(await fileText(page, "Bold.md")).toContain("status: open");
  expect(errors).toEqual([]);
});

test("a button that runs code says so, and runs none of its actions", async ({ page }) => {
  const errors = errorsOf(page);
  const button = await openButton(
    page,
    "Script",
    [
      "label: Run it",
      "actions:",
      "  - type: updateMetadata",
      "    bindTarget: status",
      "    value: ran",
      "  - type: js",
      "    file: script.js",
    ],
    "Run it",
  );
  await expect(button).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Nether does not run" })).toHaveText(
    "Nether does not run js, so this button runs none of its actions.",
  );

  await editFile(page, "Script.md", withButton("status: open", ["style: primary"]));
  await expect(page.locator(".note-button-problem")).toHaveText("This button has no label.");
  expect(errors).toEqual([]);
});

test("the slash menu's Button makes a block whose button sets a property", async ({ page }) => {
  const errors = errorsOf(page);
  const editor = await openNote(page, "Welcome");
  await endOfFirstParagraph(page, editor);
  await page.keyboard.press("Enter");
  await page.keyboard.type("/button");
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("textbox", { name: "Language" })).toHaveValue("meta-bind-button");
  await page.getByRole("button", { name: "Mark done", exact: true }).click();
  await expect.poll(() => fileText(page, "Welcome.md")).toMatch(/^---\n(.*\n)*status: Done\n/);
  expect(errors).toEqual([]);
});

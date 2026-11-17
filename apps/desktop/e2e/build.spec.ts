// Building with AI (ADR 0078), in the desktop app's preview: the File
// menu's command shows only once a provider is set up; a database is
// described, previewed with every note it would make, and made as it was
// shown, its schema in its note; Cancel makes nothing; a reply that does
// not read is refused, saying why. The provider is a route of the page.
import { type Page, type Request, expect, test } from "@playwright/test";
import { errorsOf, openSample, violations } from "./helpers.ts";

/** A reply as an OpenAI-compatible endpoint streams it, cut in two. */
function streamed(text: string): string {
  const half = Math.floor(text.length / 2);
  return [text.slice(0, half), text.slice(half)]
    .map(
      (part) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`,
    )
    .concat("data: [DONE]\n\n")
    .join("");
}

const books = {
  kind: "database",
  name: "Reading list",
  description: "Books, and how far along each is.",
  properties: [
    { key: "Author", type: "text" },
    { key: "Status", type: "select", options: ["To read", "Reading", "Done"] },
  ],
  views: [
    { name: "All", layout: "table", visible: ["Author", "Status"] },
    { name: "By status", layout: "board", groupBy: "Status", visible: ["Author"] },
  ],
  rows: [],
};

async function fakeProvider(page: Page, replies: string[]) {
  const sent: Request[] = [];
  await page.route("**/fake-ai/v1/chat/completions", async (route) => {
    sent.push(route.request());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: streamed(replies.shift() ?? "{}"),
    });
  });
  return sent;
}

async function setUpProvider(page: Page, baseURL: string | undefined) {
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page
    .getByRole("menu", { name: "Settings" })
    .getByRole("menuitem", { name: /^Plugins/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "AI" }).click();
  const tab = settings.getByRole("tabpanel", { name: "AI" });
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("Name", { exact: true }).fill("Local");
  await tab.getByLabel("Address").fill(`${baseURL ?? ""}/fake-ai/v1`);
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByRole("button", { name: "Save" }).click();
  await expect(tab.getByRole("listitem").filter({ hasText: "Local" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
}

async function fileMenu(page: Page): Promise<string> {
  await page.getByRole("menuitem", { name: "File" }).click();
  const items = await page
    .getByRole("menu", { name: "File" })
    .getByRole("menuitem")
    .allTextContents();
  await page.keyboard.press("Escape");
  return items.join(" | ");
}

async function openBuild(page: Page) {
  await page.getByRole("menuitem", { name: "File" }).click();
  await page
    .getByRole("menu", { name: "File" })
    .getByRole("menuitem", { name: /Build with AI/ })
    .click();
  return page.getByRole("dialog", { name: "Build with AI" });
}

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

test("a database described, previewed, and made as it was shown", async ({ page, baseURL }) => {
  const errors = errorsOf(page);
  const sent = await fakeProvider(page, [JSON.stringify(books)]);
  await openSample(page);
  expect(await fileMenu(page)).not.toContain("Build with AI");
  await setUpProvider(page, baseURL);
  expect(await fileMenu(page)).toContain("Build with AI");

  const dialog = await openBuild(page);
  await expect(dialog).toContainText(
    "Sends your description to Local, test-model on this computer. Nothing is made until you have seen what it would make and said so.",
  );
  await expect(dialog.getByRole("radio", { name: /^A database/ })).toBeChecked();
  await dialog.getByLabel("Describe it").fill("Books I read, by author and how far along");
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Build" }).click();

  await expect(dialog.getByRole("status")).toHaveText(
    "This is what it would make. Nothing is made until you choose Make it.",
  );
  const notes = dialog.getByRole("list", { name: "Notes it would make" });
  await expect(notes.getByRole("listitem")).toHaveCount(1);
  await expect(notes).toContainText("Reading list.md");
  await expect(notes).toContainText(
    "Properties: Author (text); Status (select: To read, Reading, Done)",
  );
  await expect(notes).toContainText("Views: All (table); By status (board)");
  await expect(dialog.getByLabel("Name")).toHaveValue("Reading list");
  expect(await violations(page)).toEqual([]);
  // Nothing is written before Make it.
  expect(await fileText(page, "Reading list.md")).toBeUndefined();
  // The last message is the user's, after the system prompt.
  const asked = (sent[0]?.postDataJSON() as { messages: { content: string }[] }).messages.at(
    -1,
  )?.content;
  expect(asked).toContain(
    "<description>\nBooks I read, by author and how far along\n</description>",
  );
  expect(asked).toContain('Give it no rows: "rows": [].');

  await dialog.getByRole("button", { name: "Make it" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#note-title")).toHaveText("Reading list");
  const text = (await fileText(page, "Reading list.md")) ?? "";
  expect(text).toContain("database:");
  expect(text).toContain("key: Author");
  expect(text).toContain("key: Status");
  expect(text).toContain("layout: board");
  expect(errors).toEqual([]);
});

test("Cancel makes nothing, and a reply that does not read is refused, saying why", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  await fakeProvider(page, [
    JSON.stringify(books),
    JSON.stringify({ ...books, views: [{ name: "Board", layout: "board", visible: [] }] }),
  ]);
  await openSample(page);
  await setUpProvider(page, baseURL);

  const dialog = await openBuild(page);
  await dialog.getByLabel("Describe it").fill("Books");
  await dialog.getByRole("button", { name: "Build" }).click();
  await expect(dialog.getByRole("list", { name: "Notes it would make" })).toContainText(
    "Reading list.md",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await fileText(page, "Reading list.md")).toBeUndefined();

  const again = await openBuild(page);
  await again.getByLabel("Describe it").fill("Books on a board");
  await again.getByRole("button", { name: "Build" }).click();
  await expect(again.getByRole("alert")).toHaveText(
    "The reply could not be built from: database.views[0].groupBy is needed by a board. Try again, or describe it another way.",
  );
  await again.getByRole("button", { name: "Cancel" }).click();
  expect(await fileText(page, "Reading list.md")).toBeUndefined();
  expect(errors).toEqual([]);
});

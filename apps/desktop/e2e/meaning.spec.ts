// Search by meaning (ADR 0074): off until it is turned on in the AI tab with
// an OpenAI-compatible provider and its embedding model, sending nothing
// before; then the vault's notes go to the model a passage at a time, and
// the sidebar's search finds a note by what it is about, by its closest
// passage, which opens at its heading. The provider is a route of the page
// here, never a provider.
import { type Page, type Request, expect, test } from "@playwright/test";
import { errorsOf, openSample, violations } from "./helpers.ts";

/** Topics the fake model knows: each number of its vectors counts one topic's words. */
const topics = [
  // "documents" is in no sample note: only meaning finds a note by it.
  ["markdown", "files", "plain", "documents"],
  ["phase", "scope", "server", "account", "roadmap"],
  ["answer", "number", "const", "integral"],
];

function vectorOf(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  return topics.map((topic) => words.filter((word) => topic.includes(word)).length + 0.01);
}

/** Answers the provider's embeddings on the page's own origin, a vector by topic for each text. */
async function fakeEmbeddings(page: Page) {
  const sent: Request[] = [];
  await page.route("**/fake-ai/v1/embeddings", async (route) => {
    sent.push(route.request());
    const { input } = route.request().postDataJSON() as { input: string[] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        object: "list",
        data: input.map((text, index) => ({
          object: "embedding",
          index,
          embedding: vectorOf(text),
        })),
      }),
    });
  });
  return sent;
}

async function openSettingsAt(page: Page, tab: string) {
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page
    .getByRole("menu", { name: "Settings" })
    .getByRole("menuitem", { name: /^Plugins/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: tab }).click();
  return settings;
}

test("search by meaning sends nothing until turned on, then finds a note by what it is about", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  const sent = await fakeEmbeddings(page);
  await openSample(page);

  // Off: the search has no modes.
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(page.getByRole("searchbox", { name: "Search the vault" })).toBeFocused();
  await expect(page.getByRole("group", { name: "Search by" })).toHaveCount(0);

  // A provider on this computer, then search by meaning with its embedding model.
  const settings = await openSettingsAt(page, "AI");
  const tab = settings.getByRole("tabpanel", { name: "AI" });
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("Name", { exact: true }).fill("Local");
  await tab.getByLabel("Address").fill(`${baseURL ?? ""}/fake-ai/v1`);
  await tab.getByLabel("Model", { exact: true }).fill("chat-model");
  await tab.getByRole("button", { name: "Save" }).click();
  const meaning = tab.getByRole("region", { name: "Search by meaning" });
  await expect(meaning).toContainText("sends the whole vault's text to the provider once");
  await expect(meaning.getByLabel("Provider")).toHaveValue(/.+/);
  await meaning.getByLabel("Embedding model").fill("embed-model");
  expect(await violations(page)).toEqual([]);
  expect(sent).toHaveLength(0);

  await meaning.getByRole("button", { name: "Turn on" }).click();
  await expect(meaning.getByRole("status")).toHaveText(
    "On, with embed-model on Local: the vault is embedded.",
    { timeout: 20_000 },
  );
  // The notes went to the embedding model, each passage under its note's title and headings.
  const asked = sent.flatMap(
    (request) => (request.postDataJSON() as { model: string; input: string[] }).input,
  );
  expect(
    new Set(sent.map((request) => (request.postDataJSON() as { model: string }).model)),
  ).toEqual(new Set(["embed-model"]));
  expect(
    asked.some((text) => text.startsWith("Welcome > Welcome to Nether\n\nNotes are plain")),
  ).toBe(true);
  expect(asked.some((text) => text.startsWith("Roadmap > Roadmap\n\n"))).toBe(true);
  expect(await violations(page)).toEqual([]);
  await settings.getByRole("button", { name: "Close" }).click();

  // The sidebar's search, by meaning, on Enter.
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page
    .getByRole("group", { name: "Search by" })
    .getByRole("button", { name: "By meaning" })
    .click();
  const field = page.getByRole("searchbox", { name: "Search the vault by meaning" });
  await field.fill("where my plain files live in a folder");
  const before = sent.length;
  await field.press("Enter");
  const found = page.getByRole("list", { name: "Notes found" });
  await expect(found.locator(".note-title").first()).toHaveText("Welcome");
  await expect(found.getByRole("listitem").first()).toContainText("Welcome to Nether");
  await expect(found.getByRole("listitem").first()).toContainText("Notes are plain");
  // The query went once, alone.
  expect(sent).toHaveLength(before + 1);
  expect((sent.at(-1)?.postDataJSON() as { input: string[] }).input).toEqual([
    "where my plain files live in a folder",
  ]);
  expect(await violations(page)).toEqual([]);

  // A filter narrows what meaning found; the closest note opens.
  await field.fill("plain files folder path:Projects");
  await field.press("Enter");
  await expect(found.locator(".note-title", { hasText: "Welcome" })).toHaveCount(0);
  await expect(found.locator(".note-title").first()).toBeVisible();
  await field.fill("plain files in a folder");
  await field.press("Enter");
  await found.getByRole("button", { name: /Welcome/ }).click();
  await expect(page.locator("#note-title")).toHaveText("Welcome");

  // By words still searches as typed.
  await page
    .getByRole("group", { name: "Search by" })
    .getByRole("button", { name: "By words" })
    .click();
  await page.getByRole("searchbox", { name: "Search the vault" }).fill("roadmap");
  await expect(
    page.getByRole("list", { name: "Notes found" }).locator(".note-title"),
  ).toContainText(["Roadmap"]);
  expect(errors).toEqual([]);
});

/** A reply as an OpenAI-compatible endpoint streams it. */
function streamed(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

test("asking your notes finds notes by meaning too, and says where the question goes", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  await fakeEmbeddings(page);
  const asked: Request[] = [];
  await page.route("**/fake-ai/v1/chat/completions", async (route) => {
    asked.push(route.request());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: streamed("They are plain files in a folder you choose [1]."),
    });
  });
  await openSample(page);

  const settings = await openSettingsAt(page, "AI");
  const tab = settings.getByRole("tabpanel", { name: "AI" });
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("Name", { exact: true }).fill("Local");
  await tab.getByLabel("Address").fill(`${baseURL ?? ""}/fake-ai/v1`);
  await tab.getByLabel("Model", { exact: true }).fill("chat-model");
  await tab.getByRole("button", { name: "Save" }).click();
  const meaning = tab.getByRole("region", { name: "Search by meaning" });
  await meaning.getByLabel("Embedding model").fill("embed-model");
  await meaning.getByRole("button", { name: "Turn on" }).click();
  await expect(meaning.getByRole("status")).toHaveText(
    "On, with embed-model on Local: the vault is embedded.",
    { timeout: 20_000 },
  );
  await settings.getByRole("button", { name: "Close" }).click();

  await page.locator(".sidebar-tabs").getByRole("button", { name: "Ask" }).click();
  const panel = page.getByRole("region", { name: "Ask your notes" });
  await expect(panel).toContainText(
    "Search by meaning also sends the question to embed-model on Local, to find the notes it is about.",
  );
  // No note has these words: meaning alone finds the welcome note.
  await panel
    .getByRole("textbox", { name: "Your question" })
    .fill("Where are my documents stored?");
  await page.keyboard.press("Enter");
  const answer = panel.locator(".ask-answer").last();
  await expect(answer).toContainText("They are plain files in a folder you choose");
  await expect(answer.getByRole("button", { name: /^\[1\] 1\. Welcome/ })).toBeVisible();
  expect(asked).toHaveLength(1);
  const body = asked[0]?.postDataJSON() as { messages: { content: string }[] };
  expect(body.messages.at(-1)?.content).toContain('From "Welcome"');
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

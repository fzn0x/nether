// Asking your notes (ADR 0075), in the desktop app's preview: the Ask tab
// shows only once a provider is set up, says where a question goes, sends
// it with passages of the notes the vault's search finds, and shows each
// citation as a link that opens its note, an invented one as unverified.
// A question no note answers sends nothing. The conversation saves as a
// note. The provider is a route of the page here.
import { type Page, type Request, expect, test } from "@playwright/test";
import { errorsOf, openSample, violations } from "./helpers.ts";

/** A reply as an OpenAI-compatible endpoint streams it. */
function streamed(...parts: string[]): string {
  return [
    ...parts.map(
      (part) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`,
    ),
    "data: [DONE]\n\n",
  ].join("");
}

async function fakeProvider(page: Page, answers: string[]) {
  const sent: Request[] = [];
  await page.route("**/fake-ai/v1/chat/completions", async (route) => {
    sent.push(route.request());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: streamed(answers.shift() ?? ""),
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

test("asks the notes a question, citing the passages sent, and saves the conversation", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  const sent = await fakeProvider(page, [
    "It works with no account and no server [1]. See also [7].",
  ]);
  await openSample(page);
  const tabs = page.locator(".sidebar-tabs");
  // No provider, no Ask.
  await expect(tabs.getByRole("button", { name: "Trash" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Ask" })).toHaveCount(0);

  await setUpProvider(page, baseURL);
  await tabs.getByRole("button", { name: "Ask" }).click();
  const panel = page.getByRole("region", { name: "Ask your notes" });
  await expect(panel).toContainText(
    "Asks Local, test-model on this computer: your question, and passages of the notes the vault's search finds for it.",
  );
  expect(await violations(page)).toEqual([]);

  // Words no note has: nothing goes.
  await panel.getByRole("textbox", { name: "Your question" }).fill("zzqx flurble?");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("status").first()).toHaveText(
    "No note has these words, so nothing was sent. Try others.",
  );
  expect(sent).toHaveLength(0);

  await panel
    .getByRole("textbox", { name: "Your question" })
    .fill("Does the desktop app need a server?");
  await page.keyboard.press("Enter");
  const answer = panel.locator(".ask-answer").last();
  await expect(answer).toHaveText(
    "It works with no account and no server [1]. See also [7] names no passage that was sent, so it is not checked.",
  );
  // Only passages of the notes found went, with the question.
  expect(sent).toHaveLength(1);
  const body = sent[0]?.postDataJSON() as { messages: { content: string }[] };
  const asked = body.messages.at(-1)?.content ?? "";
  expect(asked).toContain('From "Roadmap"');
  expect(asked).toContain("The desktop app works with no account and no server.");
  expect(asked).toContain("Question: Does the desktop app need a server?");
  expect(asked).not.toContain("const answer");

  // The invented citation is no link; the real one opens its note.
  await expect(answer.locator(".ask-unverified")).toContainText("[7]");
  await expect(answer.getByRole("button")).toHaveCount(1);
  await answer.getByRole("button", { name: /^\[1\] 1\. Roadmap/ }).click();
  await expect(page.getByRole("textbox", { name: "Roadmap, note text" })).toBeVisible();
  await panel.getByText(/^Read from \d+ passages$/).click();
  await expect(panel.locator(".ask-sources button.cited")).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await panel.getByRole("button", { name: "Save as note" }).click();
  await expect(panel.getByRole("status").last()).toHaveText(
    "Saved as Does the desktop app need a server.",
  );
  await expect
    .poll(() => fileText(page, "Does the desktop app need a server.md"))
    .toContain("It works with no account and no server [[Roadmap|1]]. See also [7].");
  expect(await fileText(page, "Does the desktop app need a server.md")).toContain(
    "### Sources\n\n1. [[Roadmap]]",
  );
  expect(errors).toEqual([]);
});

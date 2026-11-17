// AI, bring your own (ADRs 0068 and 0069): nothing of it shows until a
// provider is set up in the settings' AI tab; then writing assist works on
// the selection, names where the text goes, streams the reply into a
// preview, and puts it in the note as one edit that one undo takes out. A
// workspace's owner turns AI off for everyone, and the app hears it before
// it sends. A provider's requests go to a route of the page here, never to
// a provider, and the server is the test's.
import { type Page, type Request, expect, test } from "@playwright/test";
import { errorsOf, fakeServer, openSample, pageErrors, settle, violations } from "./helpers.ts";

/** A reply as an OpenAI-compatible endpoint streams it. */
function streamed(...parts: string[]): string {
  return [
    ...parts.map(
      (part) =>
        `data: ${JSON.stringify({
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        })}\n\n`,
    ),
    `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

/** Answers the provider's chat completions on the page's own origin, in order. */
async function fakeProvider(page: Page, answers: { status?: number; body: string }[]) {
  const sent: Request[] = [];
  await page.route("**/fake-ai/v1/chat/completions", async (route) => {
    sent.push(route.request());
    const answer = answers.shift() ?? { status: 500, body: "{}" };
    await route.fulfill({
      status: answer.status ?? 200,
      contentType: (answer.status ?? 200) === 200 ? "text/event-stream" : "application/json",
      body: answer.body,
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

/** The Note menu's items, as one text. */
async function noteMenuItems(page: Page): Promise<string> {
  await page.getByRole("menuitem", { name: "Note" }).click();
  const items = await page
    .getByRole("menu", { name: "Note" })
    .getByRole("menuitem")
    .allTextContents();
  await page.keyboard.press("Escape");
  return items.join(" | ");
}

/** The sample's welcome note, with its heading selected. */
async function selectHeading(page: Page) {
  await page
    .getByRole("list", { name: "Notes" })
    .getByRole("button", { name: /Welcome/ })
    .click();
  const editor = page.getByRole("textbox", { name: "Welcome, note text" });
  await editor.locator("h1").click();
  await settle(page);
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await settle(page);
  return editor;
}

async function noteText(page: Page, path: string): Promise<string> {
  return page.evaluate(async (file) => {
    const preview = (
      globalThis as unknown as {
        netherPreview: { files: { read(path: string): Promise<{ text: string }> } };
      }
    ).netherPreview;
    return (await preview.files.read(file)).text;
  }, path);
}

test("nothing of AI shows until a provider is set up, then writing assist rewrites the selection", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  const sent = await fakeProvider(page, [
    { body: streamed("Hello ", "from **Nether**") },
    { body: streamed("A second ", "try") },
  ]);
  await openSample(page);

  // No provider: no command, and its shortcut does nothing.
  expect(await noteMenuItems(page)).not.toContain("Writing assist");
  await selectHeading(page);
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("region", { name: "Writing assist" })).toHaveCount(0);

  // A provider on this computer, set up in the settings' AI tab.
  const settings = await openSettingsAt(page, "AI");
  const tab = settings.getByRole("tabpanel", { name: "AI" });
  await expect(tab.getByText("No provider is set up yet.")).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("Name", { exact: true }).fill("Local");
  // Another computer over plain HTTP is said to be unencrypted.
  await tab.getByLabel("Address").fill("http://192.168.1.20:11434/v1");
  await expect(tab.getByText(/over plain HTTP/)).toBeVisible();
  await tab.getByLabel("Address").fill(`${baseURL ?? ""}/fake-ai/v1`);
  await expect(tab.getByText(/over plain HTTP/)).toHaveCount(0);
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByLabel("Key", { exact: true }).fill("sk-local");
  expect(await violations(page)).toEqual([]);
  await tab.getByRole("button", { name: "Save" }).click();
  const listed = tab.getByRole("listitem").filter({ hasText: "Local" });
  await expect(listed).toContainText("test-model on this computer");
  await expect(listed).toContainText("Default");
  await expect(tab.getByLabel("AI in this vault")).toHaveValue("default");
  await settings.getByRole("button", { name: "Close" }).click();

  expect(await noteMenuItems(page)).toContain("Writing assist");
  const editor = await selectHeading(page);
  await page.keyboard.press("Control+j");
  const assist = page.getByRole("region", { name: "Writing assist" });
  await expect(assist).toContainText("Sends the text to Local, test-model on this computer.");
  await expect(assist).toContainText("On: Welcome to Nether");
  await expect(editor.locator(".assist-highlight")).toHaveText("Welcome to Nether");
  await expect(assist.getByRole("button", { name: "Rewrite" })).toBeFocused();
  expect(await violations(page)).toEqual([]);
  // Nothing went anywhere before the user chose what to do.
  expect(sent).toHaveLength(0);

  await assist.getByRole("button", { name: "Rewrite" }).click();
  await expect(assist.getByRole("status")).toHaveText(
    "Done. Check it, then put it in the note or try again.",
  );
  await expect(assist.getByRole("region", { name: "What came back" })).toHaveText(
    "Hello from **Nether**",
  );
  expect(await violations(page)).toEqual([]);
  // Only the selection went, with the key, to the provider chosen.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers().authorization).toBe("Bearer sk-local");
  const body = sent[0]?.postDataJSON() as {
    model: string;
    stream: boolean;
    messages: { role: string; content: string }[];
  };
  expect(body.model).toBe("test-model");
  expect(body.stream).toBe(true);
  // The heading's text, as the note writes it.
  expect(body.messages.at(-1)?.content).toContain("<text>\n# Welcome to Nether\n</text>");
  expect(JSON.stringify(body)).not.toContain("plain **Markdown** files");

  await assist.getByRole("button", { name: "Try again" }).click();
  await expect(assist.getByRole("region", { name: "What came back" })).toHaveText("A second try");
  await assist.getByRole("button", { name: "Replace" }).click();
  await expect(assist).toHaveCount(0);
  await expect(editor.locator("h1")).toHaveText("A second try");
  await expect.poll(() => noteText(page, "Welcome.md")).toContain("# A second try\n");

  // One undo takes the whole reply out.
  await page.keyboard.press("Control+z");
  await expect(editor.locator("h1")).toHaveText("Welcome to Nether");
  expect(errors).toEqual([]);
});

test("writing assist tells a provider's error, and AI turned off for the vault hides it", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  await fakeProvider(page, [
    {
      status: 401,
      body: JSON.stringify({
        error: { message: "Incorrect API key provided.", type: "invalid_request_error" },
      }),
    },
    { body: streamed("Welcome to Nether.") },
    { body: streamed("Continued here.") },
  ]);
  await openSample(page);
  const settings = await openSettingsAt(page, "AI");
  const tab = settings.getByRole("tabpanel", { name: "AI" });
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("Name", { exact: true }).fill("Local");
  await tab.getByLabel("Address").fill(`${baseURL ?? ""}/fake-ai/v1`);
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByRole("button", { name: "Save" }).click();
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = await selectHeading(page);
  await page.getByRole("menuitem", { name: "Note" }).click();
  await page
    .getByRole("menu", { name: "Note" })
    .getByRole("menuitem", { name: /Writing assist/ })
    .click();
  const assist = page.getByRole("region", { name: "Writing assist" });
  await assist.getByRole("button", { name: "Fix grammar" }).click();
  await expect(assist.getByRole("alert")).toHaveText(
    "Local could not answer: Incorrect API key provided.",
  );
  await assist.getByRole("button", { name: "Try again" }).click();
  // A continuation goes after the text, which stays.
  await expect(assist.getByRole("button", { name: "Replace" })).toBeVisible();
  await assist.getByRole("button", { name: "Discard" }).click();
  await expect(assist).toHaveCount(0);
  await expect(editor.locator(".assist-highlight")).toHaveCount(0);
  await expect(editor.locator("h1")).toHaveText("Welcome to Nether");

  await page.keyboard.press("Control+j");
  await assist.getByRole("button", { name: "Continue writing" }).click();
  await assist.getByRole("button", { name: "Insert below" }).click();
  await expect(editor.locator("h1")).toHaveText("Welcome to Nether");
  await expect(editor.locator("h1 + p")).toHaveText("Continued here.");

  // Off for this vault: the command goes.
  const again = await openSettingsAt(page, "AI");
  await again
    .getByRole("tabpanel", { name: "AI" })
    .getByLabel("AI in this vault")
    .selectOption("off");
  await again.getByRole("button", { name: "Close" }).click();
  expect(await noteMenuItems(page)).not.toContain("Writing assist");
  expect(errors.filter((error) => !error.startsWith("Failed to load resource"))).toEqual([]);
});

const ada = { id: "u1", name: "Ada", email: "ada@example.org", instanceAdmin: false };

async function command(page: Page, name: string) {
  await page.keyboard.press("Control+p");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

/** Signs in to the test's server and syncs the sample vault with its empty workspace. */
async function linked(page: Page) {
  await openSample(page);
  await command(page, "servers");
  const servers = page.getByRole("dialog", { name: "Servers" });
  await servers.getByRole("textbox", { name: "Server address" }).fill("nether.test");
  await servers.getByRole("button", { name: "Continue" }).click();
  await servers.getByRole("textbox", { name: "Email address" }).fill("ada@example.org");
  await servers.getByLabel("Password").fill("a long password");
  await servers.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(servers.getByRole("status")).toHaveText("Signed in to nether.test as Ada.");
  await page.keyboard.press("Escape");
  await command(page, "sync this vault");
  const sync = page.getByRole("dialog", { name: "Sync" });
  await sync.getByRole("button", { name: "Sync this vault" }).click();
  await expect(sync.getByText("This vault syncs with Team on nether.test.")).toBeVisible();
  await sync.getByRole("button", { name: "Done" }).click();
  await expect(sync).toBeHidden();
}

test("a workspace's owner turns AI off for everyone, and the app hears it before it sends", async ({
  page,
  baseURL,
}) => {
  const errors = errorsOf(page);
  const workspace = { ai: true };
  const switched: unknown[] = [];
  await fakeServer(page, {
    "GET /api/sign-in-methods": () => [200, { password: true, emailCode: false, oidc: null }],
    "POST /api/sessions": () => [201, { token: "session-token", expiresAt: "", user: ada }],
    "GET /api/me": () => [
      200,
      { user: ada, workspaces: [{ id: "w", name: "Team", role: "owner", ai: workspace.ai }] },
    ],
    "GET /api/workspaces/w/documents": () => [200, { documents: [], more: false }],
    "GET /api/workspaces/w/units": () => [
      200,
      { units: [{ id: "general", kind: "general", level: "full", document: "vault" }] },
    ],
    "PATCH /api/workspaces/w": (request) => {
      const body = request.postDataJSON() as { ai: boolean };
      switched.push(body);
      workspace.ai = body.ai;
      return [200, { id: "w", ai: body.ai }];
    },
  });
  const sent = await fakeProvider(page, [{ body: streamed("Never shown") }]);
  await linked(page);

  const settings = await openSettingsAt(page, "AI");
  const tab = settings.getByRole("tabpanel", { name: "AI" });
  const allows = tab.getByRole("checkbox", { name: "Members' apps may offer AI in Team" });
  await expect(allows).toBeChecked();
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("Name", { exact: true }).fill("Local");
  await tab.getByLabel("Address").fill(`${baseURL ?? ""}/fake-ai/v1`);
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByRole("button", { name: "Save" }).click();
  await expect(tab.getByLabel("AI in this vault")).toHaveValue("default");
  expect(await violations(page)).toEqual([]);
  await settings.getByRole("button", { name: "Close" }).click();

  await selectHeading(page);
  await page.keyboard.press("Control+j");
  const assist = page.getByRole("region", { name: "Writing assist" });
  await expect(assist).toBeVisible();
  // Another admin turns AI off meanwhile: the app asks before it sends.
  workspace.ai = false;
  await assist.getByRole("button", { name: "Rewrite" }).click();
  await expect(assist.getByRole("alert")).toHaveText(
    "AI is off here now, for this vault or its workspace, so nothing was sent.",
  );
  expect(sent).toHaveLength(0);
  await assist.getByRole("button", { name: "Discard" }).click();
  expect(await noteMenuItems(page)).not.toContain("Writing assist");

  // This owner turns it on again, for everyone.
  const again = await openSettingsAt(page, "AI");
  const back = again
    .getByRole("tabpanel", { name: "AI" })
    .getByRole("checkbox", { name: "Members' apps may offer AI in Team" });
  await expect(back).not.toBeChecked();
  await back.check();
  await expect.poll(() => switched).toEqual([{ ai: true }]);
  await again.getByRole("button", { name: "Close" }).click();
  expect(await noteMenuItems(page)).toContain("Writing assist");
  // Sync's socket finds no test server, as in the other tests of a linked vault.
  expect(pageErrors(errors).filter((error) => !error.includes("WebSocket"))).toEqual([]);
});

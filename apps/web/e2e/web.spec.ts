// The web app as its server serves it, in Chromium, against a real server
// (e2e/server.ts): signing in each way the server offers, workspaces as
// vaults kept in the browser and synced, invitations, offline, one tab per
// workspace, and its content security policy kept throughout.
import AxeBuilder from "@axe-core/playwright";
import {
  type BrowserContext,
  type Locator,
  type Page,
  chromium,
  expect,
  test,
} from "@playwright/test";
import { reading } from "../../desktop/e2e/pdfs.ts";

const control = "http://127.0.0.1:4176";

async function ask<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(control + path, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Someone new in the workspace Team, with an account of their own. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-${String(Date.now())}@example.org`;
  return { name, ...(await ask<{ email: string; password: string }>("/person", { name, email })) };
}

/** The page's errors, and what its content security policy refused, as they happen. */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) problems.push(text);
  });
  return problems;
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  return results.violations.map((violation) => violation.id);
}

/** Removes every provider the console lists, as a test that adds them leaves the server. */
async function removeProviders(section: Locator) {
  const providers = section.getByRole("list").first().getByRole("listitem");
  while ((await providers.count()) > 0) {
    const first = providers.first();
    const name = (await first.getByRole("heading").textContent()) ?? "";
    await first.getByRole("button", { name: "Remove" }).click();
    await first.getByRole("button", { name: "Remove" }).click();
    await expect(section.getByRole("heading", { name, exact: true })).toHaveCount(0);
  }
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  await dialog.getByRole("textbox", { name: "Email address" }).fill(who.email);
  await dialog.getByLabel("Password").fill(who.password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Signed in to");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
}

async function openTeam(page: Page) {
  await page.getByRole("button", { name: /^Team/ }).click();
  await expect(page.getByText(/Synced with Team|Syncing/)).toBeVisible({ timeout: 20_000 });
}

async function newNote(page: Page, name: string, text: string) {
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New note" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.getByRole("textbox", { name: `${name}, note text` }).click();
  await page.keyboard.type(text);
}

/** The text of a note's file in the browser's private file system. */
function fileText(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (wanted) => {
    const root = await navigator.storage.getDirectory();
    const workspaces = await root.getDirectoryHandle("workspaces");
    for await (const [, folder] of workspaces.entries()) {
      if (folder.kind !== "directory") continue;
      try {
        let current = folder;
        const parts = wanted.split("/");
        for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part);
        const file = await current.getFileHandle(parts.at(-1) ?? "");
        return await (await file.getFile()).text();
      } catch {
        // Not in this workspace.
      }
    }
    return undefined;
  }, path);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`signs in, writes a note kept in the browser and on the server, and signs out, in the ${colorScheme} theme`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme });
    const problems = problemsOf(page);
    const ada = await person(`Ada${colorScheme}`);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("dialog", { name: "Account and encryption" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await signIn(page, ada);
    const cookies = await context.cookies();
    expect(cookies.find((cookie) => cookie.name === "nether_session")).toMatchObject({
      httpOnly: true,
      sameSite: "Strict",
    });
    expect(await page.evaluate(() => document.cookie)).not.toContain("nether_session");
    expect(await violations(page)).toEqual([]);

    await openTeam(page);
    const name = `Plan ${colorScheme}`;
    await newNote(page, name, "Written in the browser.");
    await expect.poll(() => fileText(page, `${name}.md`)).toBe("Written in the browser.\n");
    // On the server too: a note named so is among the workspace's documents.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const me = (await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] };
          const id = me.workspaces[0]?.id ?? "";
          const listed = (await (await fetch(`/api/workspaces/${id}/documents`)).json()) as {
            documents: unknown[];
          };
          return listed.documents.length;
        }),
      )
      .toBeGreaterThan(1);

    await page.getByRole("button", { name: "Close vault" }).click();
    await page.getByRole("button", { name: "Account and encryption" }).click();
    const dialog = page.getByRole("dialog", { name: "Account and encryption" });
    await dialog.getByRole("button", { name: /^Sign out of/ }).click();
    await expect(dialog.getByRole("status")).toContainText("Signed out");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect((await context.cookies()).map((cookie) => cookie.name)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("a note written in one browser reaches another through the server", async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  try {
    const writer = await person("Writer");
    const reader = await person("Reader");
    contexts.push(await browser.newContext(), await browser.newContext());
    const [first, second] = await Promise.all(contexts.map((context) => context.newPage()));
    if (first === undefined || second === undefined) throw new Error("No pages.");
    const problems = [...problemsOf(first), ...problemsOf(second)];
    await signIn(first, writer);
    await openTeam(first);
    await newNote(first, "Shared plan", "From the first browser.");
    await expect.poll(() => fileText(first, "Shared plan.md")).toBe("From the first browser.\n");

    await signIn(second, reader);
    await openTeam(second);
    await second.getByRole("treeitem", { name: "Shared plan" }).click({ timeout: 20_000 });
    await expect(second.getByRole("textbox", { name: "Shared plan, note text" })).toHaveText(
      "From the first browser.",
    );
    expect(problems).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("an invitation link makes an account and joins the workspace", async ({ page }) => {
  const problems = problemsOf(page);
  const { token } = await ask<{ token: string }>("/invitation");
  await page.goto(`/invite#${token}`);
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText(/You are invited to Team/)).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole("textbox", { name: "Your name" }).fill("Grace");
  await dialog
    .getByRole("textbox", { name: "Email address" })
    .fill(`grace-${String(Date.now())}@example.org`);
  await dialog.getByLabel("Password").fill("another long password");
  await dialog.getByRole("button", { name: "Make the account and join" }).click();
  await expect(dialog.getByRole("status")).toHaveText("You joined Team. It is in your workspaces.");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText(/^Signed in as Grace/)).toBeVisible();
  await openTeam(page);
  expect(problems).toEqual([]);
});

test("a new server is set up from its web app, with the code from its log", async ({
  page,
  context,
}) => {
  const problems = problemsOf(page);
  const fresh = await ask<{ url: string; setupCode: string }>("/fresh");
  await page.goto(fresh.url);
  await page.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  await expect(dialog.getByRole("group", { name: /^Set up 127\.0\.0\.1:\d+$/ })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await dialog.getByRole("textbox", { name: "Setup code" }).fill(fresh.setupCode);
  await dialog.getByRole("textbox", { name: "Your name" }).fill("Grace");
  await dialog.getByRole("textbox", { name: "Email address" }).fill("grace@example.org");
  await dialog.getByLabel("Password").fill("a long password");
  await dialog.getByRole("textbox", { name: "First workspace's name" }).fill("Home");
  await dialog.getByRole("button", { name: "Set up the server" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "is set up, and you are signed in as Grace, its admin.",
  );
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "nether_session"),
  ).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Home/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test("the link in a sign-in email signs in", async ({ page }) => {
  const problems = problemsOf(page);
  const grace = await person("Mailed");
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  await dialog.getByRole("textbox", { name: "Email address" }).fill(grace.email);
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await expect(dialog.getByRole("textbox", { name: "Code" })).toBeVisible();
  const mail = await ask<{ to: string; text: string }[]>("/mail");
  const sent = mail.filter((message) => message.to === grace.email).at(-1);
  const link = /http:\/\/127\.0\.0\.1:4175\/sign-in#\S+/.exec(sent?.text ?? "")?.[0];
  expect(link).toBeDefined();

  // Opened from the email, in the browser: the code after the # signs in.
  await page.goto(link ?? "");
  await expect(page.getByText(`Signed in as Mailed, ${grace.email}`)).toBeVisible();
  await expect(page).toHaveURL("/");
  expect(problems).toEqual([]);
});

test("single sign-on comes back to the web app from the provider", async ({ page, context }) => {
  const problems = problemsOf(page);
  const sso = await person("Sso");
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    dialog.getByRole("button", { name: "Sign in with Test SSO" }).click(),
  ]);
  // The provider's page signs the person in, and sends the browser back.
  const { location } = await ask<{ location: string }>("/provider", {
    url: popup.url(),
    email: sso.email,
  });
  await popup.goto(location).catch(() => undefined);
  await expect(dialog.getByRole("status")).toContainText("Signed in to");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(`Signed in as Sso, ${sso.email}`)).toBeVisible();
  expect(problems).toEqual([]);
});

test("opens offline once opened, and one tab at a time", async ({ page, context }) => {
  const problems = problemsOf(page);
  const ada = await person("Offline");
  await signIn(page, ada);
  await openTeam(page);
  await newNote(page, "Kept here", "Readable offline.");
  await expect.poll(() => fileText(page, "Kept here.md")).toBe("Readable offline.\n");
  await page.evaluate(async () => navigator.serviceWorker.ready);

  // A second tab on the same workspace is told it is open already.
  const second = await context.newPage();
  await second.goto("/");
  await second.getByRole("button", { name: /^Team/ }).click();
  await expect(second.getByText(/This workspace is open in another tab/)).toBeVisible({
    timeout: 20_000,
  });
  await second.close();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/The server cannot be reached/)).toBeVisible();
  await page.getByRole("button", { name: /^Team/ }).click();
  await page.getByRole("treeitem", { name: "Kept here" }).click();
  await expect(page.getByRole("textbox", { name: "Kept here, note text" })).toHaveText(
    "Readable offline.",
  );
  await expect(page.getByText(/Offline: changes wait/)).toBeVisible();
  await context.setOffline(false);
  expect(problems).toEqual([]);
});

/**
 * Starts a plugin in a sandboxed frame of the app's own, as the app does
 * (ADR 0058), and gives the first message its worker sends: the plugin
 * asking the app who it is.
 */
function startFrame(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.hidden = true;
        frame.src = "/plugin-frame.html";
        const { port1, port2 } = new MessageChannel();
        const done = (settle: () => void) => {
          clearTimeout(timer);
          frame.remove();
          settle();
        };
        const timer = setTimeout(() => {
          done(() => {
            reject(new Error("The frame did not start."));
          });
        }, 10_000);
        port1.onmessage = (event) => {
          done(() => {
            resolve(JSON.stringify(event.data));
          });
        };
        addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const data = event.data as { nether?: string; message?: string } | null;
          if (data?.nether === "ready") {
            frame.contentWindow?.postMessage({ code: "export default { activate() {} };" }, "*", [
              port2,
            ]);
          } else if (data?.nether === "failed") {
            done(() => {
              reject(new Error(data.message));
            });
          }
        });
        document.body.append(frame);
      }),
  );
}

// Offline, Chromium loads no sandboxed frame from the service worker, so a
// plugin from a vault starts only while the server answers.
test("a plugin's frame starts under the server's policies", async ({ page }) => {
  const problems = problemsOf(page);
  await page.goto("/");
  expect(await startFrame(page)).toContain('"hello"');
  expect(problems).toEqual([]);
});

// PDFs (ADR 0061): a PDF kept in the browser opens through pdf.js and its
// worker, under the server's policy, and a highlight goes in a note there.
test("a PDF pasted into a note opens, and is highlighted, under the server's policies", async ({
  page,
}) => {
  const problems = problemsOf(page);
  const ada = await person("Reader");
  await signIn(page, ada);
  await openTeam(page);
  await newNote(page, "Reading list", "To read: ");
  await page.getByRole("textbox", { name: "Reading list, note text" }).evaluate((editor, text) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], "Reading.pdf", { type: "application/pdf" }));
    editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, reading);
  await expect.poll(() => fileText(page, "attachments/Reading.pdf")).toContain("%PDF-1.4");

  const tree = page.getByRole("tree", { name: "Notes" });
  await tree.getByRole("treeitem", { name: "attachments" }).click();
  await tree.getByRole("treeitem", { name: /^Reading\s*pdf$/ }).click();
  await expect(
    page.getByRole("group", { name: "Page 1 of 2" }).locator(".textLayer"),
  ).toContainText("linkable blocks");
  await page.getByRole("region", { name: "Reading: pages" }).focus();
  await page.keyboard.press("Control+F");
  await page.getByRole("searchbox", { name: "Words to find" }).fill("linkable blocks");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Shift+H");
  await expect
    .poll(() => fileText(page, "attachments/Reading highlights.md"))
    .toContain("[[Reading.pdf#page=1&selection=2,18,2,33|Reading, page 1]]\n> linkable blocks\n");
  expect(await violations(page)).toEqual([]);

  // Offline, pdf.js, its worker and what it fetches come from the service worker.
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.context().setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: /^Team/ }).click();
  // The PDF's tab is open again, as the vault was left.
  await expect(page.getByRole("tab", { name: "Reading" })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("group", { name: "Page 1 of 2" }).locator(".pdf-mark-highlight").first(),
  ).toBeVisible();
  await page.context().setOffline(false);
  expect(problems).toEqual([]);
});

test("a share link opens its page to someone with no account, until it is revoked", async ({
  page,
  browser,
}) => {
  const problems = problemsOf(page);
  const owner = await person("Owner");
  await signIn(page, owner);
  await openTeam(page);
  await newNote(page, "Launch plan", "Read me by link.");
  await expect.poll(() => fileText(page, "Launch plan.md")).toBe("Read me by link.\n");

  await page.keyboard.press("Control+p");
  await page.keyboard.type("Share this page");
  await page.keyboard.press("Enter");
  const share = page.getByRole("dialog", { name: "Share Launch plan" });
  await share.getByRole("button", { name: "Share it on its own, with its subpages" }).click();
  await expect(share.getByRole("status")).toHaveText("Launch plan is shared on its own.");
  const links = share.getByRole("region", { name: "Anyone with the link" });
  await links.getByRole("button", { name: "Make a link" }).click();
  await expect(share.getByRole("status")).toHaveText("The link is made, and copied.");
  const url = await links.getByRole("textbox", { name: "Link" }).inputValue();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:4175\/s#nether_link_/);
  expect(await violations(page)).toEqual([]);

  // Someone with no account, in a browser of their own.
  const visitor = await browser.newContext();
  try {
    const reader = await visitor.newPage();
    const readerProblems = problemsOf(reader);
    await reader.goto(url);
    await expect(reader.getByRole("heading", { name: "Launch plan" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(reader.getByText("Read me by link.")).toBeVisible();
    await expect(reader.getByRole("textbox", { name: "Launch plan" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
    // The token left the address once used.
    expect(reader.url()).toBe("http://127.0.0.1:4175/s");
    expect(await violations(reader)).toEqual([]);

    // A link with a password asks for it.
    await share.getByRole("textbox", { name: "Password (optional)" }).fill("a long password");
    await links.getByRole("button", { name: "Make a link" }).click();
    await expect(links.getByRole("textbox", { name: "Link" })).toHaveCount(2);
    const locked = await links.getByRole("textbox", { name: "Link" }).nth(1).inputValue();
    const guest = await browser.newContext();
    try {
      const asked = await guest.newPage();
      await asked.goto(locked);
      await asked.getByLabel("Password").fill("not it");
      await asked.getByRole("button", { name: "Open" }).click();
      await expect(asked.getByRole("alert")).toHaveText("That password is not this link's.");
      await asked.getByLabel("Password").fill("a long password");
      await asked.getByRole("button", { name: "Open" }).click();
      await expect(asked.getByRole("heading", { name: "Launch plan" })).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await guest.close();
    }

    // Revoked, it opens nothing, and the visit it started is over.
    await links.getByRole("button", { name: "Revoke" }).first().click();
    await expect(share.getByRole("status")).toHaveText(
      "The link is revoked: it opens nothing now.",
    );
    await reader.reload();
    await expect(reader.getByRole("alert")).toHaveText(
      "This link opens nothing: it was revoked, or it expired.",
    );
    expect(readerProblems).toEqual([]);
  } finally {
    await visitor.close();
  }
  expect(problems).toEqual([]);
});

/** Opens the settings at their AI tab, through the palette. */
async function aiTab(page: Page) {
  await page.keyboard.press("Control+p");
  await page.keyboard.type("Plugins");
  await page.keyboard.press("Enter");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "AI" }).click();
  return { settings, tab: settings.getByRole("tabpanel", { name: "AI" }) };
}

test("the admin's provider for everyone, kept on the server, and writing assist through its relay", async ({
  page,
}) => {
  const problems = problemsOf(page);
  // Ada set the server up, so she is its admin.
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await openTeam(page);
  await newNote(page, "Typo", "Teh cat sat.");
  await expect.poll(() => fileText(page, "Typo.md")).toBe("Teh cat sat.\n");

  const { settings, tab } = await aiTab(page);
  await expect(tab.getByRole("heading", { name: "Providers on 127.0.0.1:4175" })).toBeVisible();
  await expect(tab.getByText("No provider is set up yet.")).toBeVisible();
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("For").selectOption("instance");
  await tab.getByLabel("Name", { exact: true }).fill("Team model");
  await tab.getByLabel("Address").fill("http://127.0.0.1:4178/v1");
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByLabel("Key", { exact: true }).fill("sk-team");
  expect(await violations(page)).toEqual([]);
  await tab.getByRole("button", { name: "Save" }).click();
  const listed = tab.getByRole("listitem").filter({ hasText: "Team model" });
  await expect(listed).toContainText("Everyone's");
  await expect(listed).toContainText("test-model at 127.0.0.1:4178");
  expect(await violations(page)).toEqual([]);
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.getByRole("textbox", { name: "Typo, note text" });
  await editor.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Control+j");
  const assist = page.getByRole("region", { name: "Writing assist" });
  await expect(assist).toContainText(
    "Sends the text through 127.0.0.1:4175 to Team model, test-model at 127.0.0.1:4178.",
  );
  await assist.getByRole("button", { name: "Fix grammar" }).click();
  await expect(assist.getByRole("region", { name: "What came back" })).toHaveText(
    "Fixed: The cat sat.",
  );
  await assist.getByRole("button", { name: "Replace" }).click();
  await expect(editor.locator("p").first()).toHaveText("Fixed: The cat sat.");
  await expect.poll(() => fileText(page, "Typo.md")).toBe("Fixed: The cat sat.\n");

  // The server added the key and the provider's model; the page sent neither.
  const heard =
    await ask<{ path: string; authorization?: string; body: { model: string } }[]>("/model");
  expect(heard.at(-1)).toMatchObject({
    path: "/v1/chat/completions",
    authorization: "Bearer sk-team",
    body: { model: "test-model" },
  });

  // Gone again, so the other tests see no AI.
  const again = await aiTab(page);
  await again.tab.getByRole("button", { name: "Remove Team model" }).click();
  await expect(again.tab.getByText("No provider is set up yet.")).toBeVisible();
  await again.settings.getByRole("button", { name: "Close" }).click();
  expect(problems).toEqual([]);
});

test("a member's own provider is reached at public addresses only", async ({ page }) => {
  const problems = problemsOf(page);
  const mia = await person("Mia");
  await signIn(page, mia);
  await openTeam(page);
  const { settings, tab } = await aiTab(page);
  await tab.getByRole("button", { name: "Add a provider" }).click();
  // A member's provider is the member's own: no choice of whose it is.
  await expect(tab.getByLabel("For")).toHaveCount(0);
  await tab.getByLabel("Name", { exact: true }).fill("Sneaky");
  await tab.getByLabel("Address").fill("https://127.0.0.1:4178/v1");
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByRole("button", { name: "Save" }).click();
  await expect(tab.getByRole("alert")).toHaveText("An account's provider is at a public address.");
  await tab.getByRole("button", { name: "Cancel" }).click();
  await expect(tab.getByText("No provider is set up yet.")).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  expect(problems).toEqual([]);
});

/** Selects a passage of an editor's first paragraph, as a mouse would. */
async function selectText(page: Page, editor: Locator, passage: string) {
  await editor.evaluate((element, wanted) => {
    const text = element.querySelector("p")?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error("No text to select.");
    const at = (text.textContent ?? "").indexOf(wanted);
    if (at < 0) throw new Error(`No "${wanted}" to select.`);
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + wanted.length);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }, passage);
  // The editor reads the selection when the browser reports it, a frame later.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

test("comment and edit links let someone with no account comment and edit, as the name they give", async ({
  page,
  browser,
}) => {
  const problems = problemsOf(page);
  const owner = await person("Owner");
  await signIn(page, owner);
  await openTeam(page);
  await newNote(page, "Field notes", "Owner wrote this.");
  await expect.poll(() => fileText(page, "Field notes.md")).toBe("Owner wrote this.\n");

  await page.keyboard.press("Control+p");
  await page.keyboard.type("Share this page");
  await page.keyboard.press("Enter");
  const share = page.getByRole("dialog", { name: "Share Field notes" });
  await share.getByRole("button", { name: "Share it on its own, with its subpages" }).click();
  await expect(share.getByRole("status")).toHaveText("Field notes is shared on its own.");
  const links = share.getByRole("region", { name: "Anyone with the link" });
  const access = links.getByRole("combobox", { name: "Access" });
  await access.selectOption("edit");
  await links.getByRole("button", { name: "Make a link" }).click();
  await expect(share.getByRole("status")).toHaveText("The link is made, and copied.");
  await access.selectOption("comment");
  await links.getByRole("button", { name: "Make a link" }).click();
  await expect(links.getByRole("textbox", { name: "Link" })).toHaveCount(2);
  const linkThat = (lets: string) =>
    links
      .getByRole("listitem")
      .filter({ hasText: lets })
      .getByRole("textbox", { name: "Link" })
      .inputValue();
  const toEdit = await linkThat("Anyone with this link can edit and comment.");
  const toComment = await linkThat("Anyone with this link can read and comment.");
  expect(await violations(page)).toEqual([]);
  await share.getByRole("button", { name: "Close" }).click();
  const owned = page.getByRole("textbox", { name: "Field notes, note text" });

  // Two people with no account, each in a browser of their own.
  const contexts: BrowserContext[] = [];
  try {
    contexts.push(await browser.newContext(), await browser.newContext());
    const [editing, commenting] = await Promise.all(contexts.map((context) => context.newPage()));
    if (editing === undefined || commenting === undefined) throw new Error("No pages.");
    const visitorProblems = [...problemsOf(editing), ...problemsOf(commenting)];

    // An edit link asks for a name, then edits the note live, beside its owner.
    await editing.goto(toEdit);
    await editing.getByRole("textbox", { name: "Your name" }).fill("Robin");
    await editing.getByRole("button", { name: "Open" }).click();
    const editor = editing.getByRole("textbox", { name: "Field notes", exact: true });
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
    await expect(editor).toHaveText("Owner wrote this.");
    await expect(
      editing.getByText("Shared by a link, to edit and comment on, as Robin."),
    ).toBeVisible();
    await editor.click();
    await editing.keyboard.press("Control+End");
    await editing.keyboard.type(" Robin added this.");
    await editing.keyboard.press("Home");
    // The owner's editor holds Robin's caret too, named.
    await expect(owned).toContainText("Owner wrote this. Robin added this.", { timeout: 20_000 });
    await expect(owned.locator(".collaboration-carets__label")).toHaveText("Robin");
    await expect
      .poll(() => fileText(page, "Field notes.md"))
      .toBe("Owner wrote this. Robin added this.\n");
    expect(await violations(editing)).toEqual([]);

    // A comment link reads the note live, and comments on a passage of it.
    await commenting.goto(toComment);
    await commenting.getByRole("textbox", { name: "Your name" }).fill("Sam");
    await commenting.getByRole("button", { name: "Open" }).click();
    const reader = commenting.getByRole("textbox", { name: "Field notes", exact: true });
    await expect(reader).toHaveAttribute("contenteditable", "false", { timeout: 20_000 });
    await expect(reader).toHaveText("Owner wrote this. Robin added this.");
    await selectText(commenting, reader, "Robin added this.");
    await commenting.getByRole("button", { name: "Comment on the selection" }).click();
    const comments = commenting.getByRole("region", { name: "Comments" });
    const draft = comments.getByRole("group", { name: "New comment" });
    await expect(draft).toContainText("Robin added this.");
    await draft.getByRole("textbox", { name: "Write a comment" }).fill("Thanks, Robin.");
    await draft.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = comments.getByRole("listitem", { name: "Comments on “Robin added this.”" });
    await expect(thread).toContainText("Sam");
    await expect(thread).toContainText("Thanks, Robin.");
    expect(await violations(commenting)).toEqual([]);

    // The owner and the other visitor see it, on the passage it is on, as a visitor's.
    for (const seen of [page, editing]) {
      const shown = seen
        .getByRole("region", { name: "Comments" })
        .getByRole("listitem", { name: "Comments on “Robin added this.”" });
      await expect(shown).toContainText("Thanks, Robin.", { timeout: 20_000 });
      await expect(shown).toContainText("Sam (by a link)");
    }
    await expect(owned.locator(".comment-highlight")).toHaveText("Robin added this.");
    expect(visitorProblems).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
  }
  expect(problems).toEqual([]);
});

test("asks the workspace's notes through the server's relay, citing the passage it read", async ({
  page,
}) => {
  const problems = problemsOf(page);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await openTeam(page);
  await newNote(page, "Garden", "The roses bloom in June.");
  await expect.poll(() => fileText(page, "Garden.md")).toBe("The roses bloom in June.\n");
  // Once the vault's search finds it, so does asking.
  const tabs = page.locator(".sidebar-tabs");
  await tabs.getByRole("button", { name: "Search" }).click();
  await page.getByRole("searchbox", { name: "Search the vault" }).fill("roses");
  await expect(page.locator(".search-panel").getByText("Garden").first()).toBeVisible({
    timeout: 20_000,
  });

  const { settings, tab } = await aiTab(page);
  await tab.getByRole("button", { name: "Add a provider" }).click();
  await tab.getByLabel("For").selectOption("instance");
  await tab.getByLabel("Name", { exact: true }).fill("Team model");
  await tab.getByLabel("Address").fill("http://127.0.0.1:4178/v1");
  await tab.getByLabel("Model").fill("test-model");
  await tab.getByLabel("Key", { exact: true }).fill("sk-team");
  await tab.getByRole("button", { name: "Save" }).click();
  await expect(tab.getByRole("listitem").filter({ hasText: "Team model" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  await tabs.getByRole("button", { name: "Ask" }).click();
  const panel = page.getByRole("region", { name: "Ask your notes" });
  await expect(panel).toContainText(
    "Asks Team model, test-model at 127.0.0.1:4178, through 127.0.0.1:4175",
  );
  await panel.getByRole("textbox", { name: "Your question" }).fill("When do the roses bloom?");
  await page.keyboard.press("Enter");
  const answer = panel.locator(".ask-answer").last();
  await expect(answer).toHaveText("Your notes say: The roses bloom in June. [1]");
  expect(await violations(page)).toEqual([]);
  const heard =
    await ask<{ authorization?: string; body: { messages: { content: string }[] } }[]>("/model");
  const last = heard.at(-1);
  expect(last?.authorization).toBe("Bearer sk-team");
  expect(last?.body.messages.at(-1)?.content).toContain('From "Garden"');
  await answer.getByRole("button", { name: /^\[1\] 1\. Garden/ }).click();
  await expect(page.getByRole("textbox", { name: "Garden, note text" })).toBeVisible();

  // Gone again, so the other tests see no AI.
  const again = await aiTab(page);
  await again.tab.getByRole("button", { name: "Remove Team model" }).click();
  await expect(again.tab.getByText("No provider is set up yet.")).toBeVisible();
  await again.settings.getByRole("button", { name: "Close" }).click();
  expect(problems).toEqual([]);
});

/** Whether the server has stored a note at a path, as publishing it takes, read with the page's session. */
function stored(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (wanted) => {
    const listed = (await (await fetch("/api/v1/workspaces")).json()) as {
      workspaces: { id: string; name: string }[];
    };
    const team = listed.workspaces.find((workspace) => workspace.name === "Team");
    if (team === undefined) return false;
    const notes = (await (await fetch(`/api/v1/workspaces/${team.id}/notes`)).json()) as {
      notes: { path: string }[];
    };
    return notes.notes.some((note) => note.path === wanted);
  }, path);
}

test("a page published from the Share dialog opens for anyone, with no account, until unpublished", async ({
  page,
  browser,
}) => {
  const problems = problemsOf(page);
  const publisher = await person("Publisher");
  await signIn(page, publisher);
  await openTeam(page);
  await newNote(page, "Field guide", "Published for anyone.");
  await expect.poll(() => fileText(page, "Field guide.md")).toBe("Published for anyone.\n");
  await expect.poll(() => stored(page, "Field guide.md"), { timeout: 20_000 }).toBe(true);

  await page.keyboard.press("Control+p");
  await page.keyboard.type("Share this page");
  await page.keyboard.press("Enter");
  const share = page.getByRole("dialog", { name: "Share Field guide" });
  const publishing = share.getByRole("region", { name: "Publish to the web" });
  const name = `field-guide-${String(Date.now())}`;
  await publishing.getByRole("textbox", { name: "Site name" }).fill(name);
  await publishing.getByRole("button", { name: "Publish this page" }).click();
  await expect(share.getByRole("status")).toHaveText(
    "Field guide is published, and its address is copied.",
  );
  const url = await publishing
    .getByRole("textbox", { name: "Address of Field guide" })
    .inputValue();
  expect(url).toBe(`http://127.0.0.1:4175/p/${name}/`);
  expect(await violations(page)).toEqual([]);

  // Someone with no account, in a browser of their own.
  const visitor = await browser.newContext();
  try {
    const reader = await visitor.newPage();
    const readerProblems = problemsOf(reader);
    const opened = await reader.goto(url);
    expect(opened?.status()).toBe(200);
    expect(opened?.headers()["content-security-policy"]).toContain("default-src 'none'");
    await expect(reader).toHaveTitle("Field guide");
    await expect(reader.getByRole("heading", { name: "Field guide", level: 1 })).toBeVisible();
    await expect(reader.getByText("Published for anyone.")).toBeVisible();
    expect(await reader.locator("script").count()).toBe(0);
    expect(await violations(reader)).toEqual([]);

    // Unpublished, its address opens nothing at once.
    await publishing.getByRole("button", { name: "Unpublish Field guide" }).click();
    await expect(share.getByRole("status")).toHaveText(
      "Field guide is unpublished: its address opens nothing now.",
    );
    const gone = await reader.goto(url);
    expect(gone?.status()).toBe(404);
    await expect(reader.getByRole("heading", { name: "Not published" })).toBeVisible();
    expect(readerProblems).toEqual([]);
  } finally {
    await visitor.close();
  }
  expect(problems).toEqual([]);
});

// Phase 4's gate: a published site loads on a custom domain. The domain is
// claimed in the Share dialog and proven by its TXT record, which the test
// server's DNS has once written; a browser of its own resolves the domain
// to this machine, as its DNS would point it at the server.
test("a site published from the Share dialog loads on the custom domain its DNS proves", async ({
  page,
}) => {
  const problems = problemsOf(page);
  const owner = await person("Dora");
  await signIn(page, owner);
  await openTeam(page);
  await newNote(page, "Handbook", "Welcome to the handbook.");
  await expect.poll(() => fileText(page, "Handbook.md")).toBe("Welcome to the handbook.\n");
  await expect.poll(() => stored(page, "Handbook.md"), { timeout: 20_000 }).toBe(true);

  await page.keyboard.press("Control+p");
  await page.keyboard.type("Share this page");
  await page.keyboard.press("Enter");
  const share = page.getByRole("dialog", { name: "Share Handbook" });
  const publishing = share.getByRole("region", { name: "Publish to the web" });
  const stamp = String(Date.now());
  await publishing.getByRole("textbox", { name: "Site name" }).fill(`handbook-${stamp}`);
  await publishing.getByRole("button", { name: "Publish this page" }).click();
  await expect(share.getByRole("status")).toHaveText(
    "Handbook is published, and its address is copied.",
  );

  const domain = `docs-${stamp}.example.test`;
  await publishing.getByRole("textbox", { name: "Custom domain of Handbook" }).fill(domain);
  await publishing.getByRole("button", { name: "Use this domain" }).click();
  await expect(share.getByRole("status")).toHaveText(
    `Add the TXT record shown at the DNS provider of ${domain}, then check it.`,
  );
  await expect(publishing.getByText(`_nether-site.${domain}`)).toBeVisible();
  const value = (await publishing.getByText(/^nether-site=/).textContent()) ?? "";
  expect(value).toMatch(/^nether-site=/);
  expect(await violations(page)).toEqual([]);

  // Checked before the record is there, the server says so.
  await publishing.getByRole("button", { name: `Check the record for ${domain}` }).click();
  await expect(share.getByRole("alert")).toContainText("has no TXT record");
  await ask("/txt", { name: `_nether-site.${domain}`, value });
  await publishing.getByRole("button", { name: `Check the record for ${domain}` }).click();
  await expect(share.getByRole("status")).toHaveText(`${domain} is this site's now.`);
  await expect(publishing.getByRole("textbox", { name: "Address of Handbook" })).toHaveValue(
    `https://${domain}/`,
  );
  // The proxy's on-demand TLS may get the domain a certificate now.
  const asked = await fetch(`http://127.0.0.1:4175/api/sites/domain?domain=${domain}`);
  expect(asked.status).toBe(200);

  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP *.example.test 127.0.0.1"],
  });
  try {
    const reader = await (await browser.newContext()).newPage();
    const readerProblems = problemsOf(reader);
    const opened = await reader.goto(`http://${domain}:4175/`);
    expect(opened?.status()).toBe(200);
    await expect(reader).toHaveTitle("Handbook");
    await expect(reader.getByRole("heading", { name: "Handbook", level: 1 })).toBeVisible();
    await expect(reader.getByText("Welcome to the handbook.")).toBeVisible();
    expect(await reader.locator("script").count()).toBe(0);
    await expect(reader.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://${domain}/`,
    );
    await expect(reader.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "Welcome to the handbook.",
    );
    expect(await violations(reader)).toEqual([]);
    const robots = await reader.goto(`http://${domain}:4175/robots.txt`);
    expect(await robots?.text()).toContain(`Sitemap: https://${domain}/sitemap.xml`);
    // Nothing of the API or the web app answers on the domain.
    const api = await reader.goto(`http://${domain}:4175/api/me`);
    expect(api?.status()).toBe(404);
    await expect(reader.getByRole("heading", { name: "Not published" })).toBeVisible();
    expect(readerProblems).toEqual([]);
  } finally {
    await browser.close();
  }

  // Given up, the domain is no site's, and the proxy gets no certificate for it.
  await publishing.getByRole("button", { name: `Remove ${domain}` }).click();
  await expect(share.getByRole("status")).toHaveText(`${domain} is no longer this site's.`);
  expect((await fetch(`http://127.0.0.1:4175/api/sites/domain?domain=${domain}`)).status).toBe(404);
  expect(problems).toEqual([]);
});

test("the admin console turns a feature on and off, for an instance admin alone", async ({
  page,
  browser,
}) => {
  const problems = problemsOf(page);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin console", level: 1 })).toBeVisible();
  const features = page.getByRole("region", { name: "Features" });
  // A feature this build has no module for is shown, and cannot be turned on.
  await expect(features.getByRole("checkbox", { name: "High availability" })).toBeDisabled();
  await expect(features).toContainText("Not in this server's build of Nether yet.");
  const pages = features.getByRole("checkbox", {
    name: "The console's usage, workspaces and security pages",
  });
  await expect(pages).toBeEnabled();
  await expect(pages).not.toBeChecked();
  await expect(page.getByRole("region", { name: "Usage" })).toHaveCount(0);
  // The server's one node, in every build, marked as the one that answered.
  const nodes = page.getByRole("region", { name: "Nodes" }).getByRole("listitem");
  await expect(nodes).toHaveCount(1);
  await expect(nodes).toContainText("(answered this page)");
  expect(await violations(page)).toEqual([]);

  await pages.check();
  await expect(
    page.getByText("The console's usage, workspaces and security pages: on."),
  ).toBeVisible();
  const usage = page.getByRole("region", { name: "Usage" });
  await expect(usage).toContainText("Accounts");
  await expect(usage).toContainText("The server's version");
  expect(await violations(page)).toEqual([]);
  await pages.uncheck();
  await expect(page.getByRole("region", { name: "Usage" })).toHaveCount(0);

  // Someone who is no instance admin sees nothing of it.
  const bea = await person("Bea");
  const other = await browser.newContext();
  try {
    const theirs = await other.newPage();
    await signIn(theirs, bea);
    await theirs.goto("/admin");
    await expect(theirs.getByRole("alert")).toHaveText(
      "Only an instance admin may see the server's features.",
    );
  } finally {
    await other.close();
  }
  expect(problems).toEqual([]);
});

test("the admin console finds a workspace by a member and sets that member's role", async ({
  page,
}) => {
  const problems = problemsOf(page);
  // A name of its own, so a retry finds one person by it; it goes in an email, so no space.
  const cy = await person(`Cy${String(Date.now() % 100_000)}`);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await page.goto("/admin");
  const pages = page.getByRole("checkbox", {
    name: "The console's usage, workspaces and security pages",
  });
  await pages.check();
  const workspaces = page.getByRole("region", { name: "Workspaces" });
  try {
    await expect(workspaces.getByRole("table")).toContainText("Team");
    await workspaces
      .getByRole("searchbox", {
        name: "Find a workspace by its name, or by a member's name or email",
      })
      .fill(cy.email);
    await workspaces.getByRole("button", { name: "Find", exact: true }).click();
    const rows = workspaces.getByRole("table").getByRole("row");
    // Its header, and Team alone: Cy is in no other workspace.
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Ada");
    expect(await violations(page)).toEqual([]);

    await workspaces.getByRole("button", { name: "Team" }).click();
    await expect(workspaces.getByRole("heading", { name: "Members of Team" })).toBeVisible();
    const role = workspaces.getByRole("combobox", { name: `Role of ${cy.name}` });
    await expect(role).toHaveValue("member");
    await role.selectOption("admin");
    await expect(workspaces.getByRole("status")).toHaveText(`${cy.name}'s role in Team: Admin.`);
    await expect(role).toHaveValue("admin");
    expect(await violations(page)).toEqual([]);

    await workspaces.getByRole("button", { name: "All workspaces" }).click();
    await expect(workspaces.getByRole("table")).toContainText("Team");
  } finally {
    await pages.uncheck();
  }
  expect(problems).toEqual([]);
});

test("the admin console's security page sets how long sessions last, and email codes", async ({
  page,
}) => {
  const problems = problemsOf(page);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await page.goto("/admin");
  const pages = page.getByRole("checkbox", {
    name: "The console's usage, workspaces and security pages",
  });
  await pages.check();
  const security = page.getByRole("region", { name: "Security" });
  const unused = security.getByRole("spinbutton", { name: "Days a session lasts unused" });
  const codes = security.getByRole("checkbox", { name: "Sign in with a code by email" });
  const save = security.getByRole("button", { name: "Save" });
  try {
    await expect(unused).toHaveValue("30");
    await expect(security.getByRole("list", { name: "Ways to sign in now" })).toContainText(
      "A code by email",
    );
    expect(await violations(page)).toEqual([]);

    await unused.fill("0");
    await save.click();
    await expect(security.getByRole("alert")).toHaveText(
      "Days a session lasts unused: a whole number from 1 to 365.",
    );

    await unused.fill("7");
    await codes.uncheck();
    await save.click();
    await expect(security.getByRole("status")).toHaveText("Saved.");
    await expect(unused).toHaveValue("7");
    await expect(security.getByRole("list", { name: "Ways to sign in now" })).not.toContainText(
      "A code by email",
    );
    expect(await violations(page)).toEqual([]);
  } finally {
    // Back as the other tests expect them, however far the test got.
    await unused.fill("30");
    await codes.check();
    await save.click();
    await expect(security.getByRole("status")).toHaveText(/^(Saved|Nothing changed)\.$/);
    await pages.uncheck();
  }
  expect(problems).toEqual([]);
});

test("an instance admin adds a SAML provider in the console, and someone at its domain signs in through it", async ({
  page,
  browser,
}) => {
  const problems = problemsOf(page);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await page.goto("/admin");
  const sso = page
    .getByRole("region", { name: "Features" })
    .getByRole("checkbox", { name: "Single sign-on" });
  await sso.check();
  const section = page.getByRole("region", { name: "Single sign-on" });
  try {
    await expect(section).toContainText("No provider yet.");
    await section.getByRole("button", { name: "Add a provider" }).click();
    await section.getByLabel("Short name").fill("corp");
    await section.getByLabel("Name, as the sign-in button shows it").fill("Corp SSO");
    await section.getByLabel("Email domains").fill("corp.example");
    const { xml } = await ask<{ xml: string }>("/saml-metadata");
    await section.getByLabel("Or its metadata, pasted").fill(xml);
    expect(await violations(page)).toEqual([]);
    await section.getByRole("button", { name: "Add it" }).click();
    await expect(section.getByRole("status")).toHaveText("Corp SSO added.");
    const corp = section.getByRole("listitem").filter({ hasText: "Corp SSO" });
    await corp.getByText("What to give the provider").click();
    await expect(corp).toContainText("http://127.0.0.1:4175/api/sso/corp/saml/acs");
    await expect(corp).toContainText("BEGIN CERTIFICATE");
    expect(await violations(page)).toEqual([]);

    // Someone at corp.example, with no account yet, signs in through it.
    const theirs = await browser.newContext();
    try {
      // The provider's page, which signs them in and posts its answer back, as a browser does.
      await theirs.route("https://idp.example.test/**", async (route) => {
        const { action, fields } = await ask<{ action: string; fields: Record<string, string> }>(
          "/saml-answer",
          { url: route.request().url(), email: "grace@corp.example", name: "Grace Hopper" },
        );
        const inputs = Object.entries(fields)
          .map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`)
          .join("");
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>Corp</title><form method="post" action="${action}">${inputs}</form><script>document.forms[0].submit()</script>`,
        });
      });
      const other = await theirs.newPage();
      const theirProblems = problemsOf(other);
      await other.goto("/");
      await other.getByRole("button", { name: "Sign in" }).click();
      const dialog = other.getByRole("dialog", { name: "Account and encryption" });
      await Promise.all([
        theirs.waitForEvent("page"),
        dialog.getByRole("button", { name: "Sign in with Corp SSO", exact: true }).click(),
      ]);
      await expect(dialog.getByRole("status")).toContainText("Signed in to");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(other.getByText("Signed in as Grace Hopper, grace@corp.example")).toBeVisible();
      expect(theirProblems).toEqual([]);
    } finally {
      await theirs.close();
    }

    // Removed, it is offered no more.
    await corp.getByRole("button", { name: "Remove" }).click();
    await corp.getByRole("button", { name: "Remove" }).click();
    await expect(section.getByRole("status")).toHaveText("Corp SSO removed.");
  } finally {
    await removeProviders(section);
    await sso.uncheck();
  }
  expect(problems).toEqual([]);
});

test("the audit log records sign-ins and its own switch, found and checked in the console", async ({
  page,
}) => {
  const problems = problemsOf(page);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await page.goto("/admin");
  const features = page.getByRole("region", { name: "Features" });
  const audit = features.getByRole("checkbox", { name: "Audit logs" });
  await expect(audit).toBeEnabled();
  await audit.check();
  await expect(page.getByText("Audit logs: on.")).toBeVisible();
  const log = page.getByRole("region", { name: "Audit log" });
  // Turning it on is the log's first event, by the admin.
  await expect(log.getByRole("row").nth(1)).toContainText("instance.feature_changed");
  await expect(log.getByRole("row").nth(1)).toContainText("Ada");

  // A wrong password, from another client: a failure, by the email typed.
  const refused = await fetch("http://127.0.0.1:4175/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "audit-e2e" },
    body: JSON.stringify({ email: "nobody@example.org", password: "not the password" }),
  });
  expect(refused.status).toBe(401);
  const filters = log.getByRole("form", { name: "Find events" });
  await filters.getByRole("combobox", { name: "Outcome" }).selectOption("failure");
  await filters.getByRole("combobox", { name: "Kind" }).selectOption("signIns");
  await filters.getByRole("button", { name: "Search" }).click();
  const failure = log.getByRole("row").filter({ hasText: "nobody@example.org" });
  await expect(failure).toContainText("session.signed_in");
  await expect(failure).toContainText("Failed: no such account");
  await failure.getByText("Details").click();
  await expect(failure).toContainText("audit-e2e");
  expect(await violations(page)).toEqual([]);

  // The chain checks, and the check is recorded.
  await log.getByRole("button", { name: "Check the log" }).click();
  await expect(log.getByRole("status")).toHaveText(/^Checked \d+ events: every one holds\.$/);
  await filters.getByRole("combobox", { name: "Outcome" }).selectOption("");
  await filters.getByRole("combobox", { name: "Kind" }).selectOption("log");
  await filters.getByRole("button", { name: "Search" }).click();
  await expect(log.getByRole("row").nth(1)).toContainText("audit.checked");
  await expect(log).toContainText(
    "Each is chained to the one before under a key from NETHER_SECRET_KEY.",
  );

  // Off again, as the other tests found it.
  await audit.uncheck();
  await expect(page.getByText("Audit logs: off.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Audit log" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("the admin console locks AI to approved endpoints, and the AI tab says so", async ({
  page,
}) => {
  const problems = problemsOf(page);
  await signIn(page, { email: "ada@example.org", password: "a long password" });
  await page.goto("/admin");
  const policies = page.getByRole("checkbox", { name: "Data policies" });
  await policies.check();
  const section = page.getByRole("region", { name: "AI endpoints" });
  const list = section.getByRole("textbox", { name: "Approved addresses, one a line" });
  const save = section.getByRole("button", { name: "Save" });
  try {
    await list.fill("https://LLM.corp.example/v1/");
    await save.click();
    await expect(section.getByRole("status")).toHaveText("Saved: AI goes only to these addresses.");
    await expect(list).toHaveValue("https://llm.corp.example/v1");
    expect(await violations(page)).toEqual([]);

    await page.goto("/");
    await openTeam(page);
    const { settings, tab } = await aiTab(page);
    await expect(tab).toContainText(
      "127.0.0.1:4175 allows AI only through https://llm.corp.example/v1.",
    );
    expect(await violations(page)).toEqual([]);
    await settings.getByRole("button", { name: "Close" }).click();
  } finally {
    // Nothing locked, as the other tests expect.
    await page.goto("/admin");
    await list.fill("");
    await save.click();
    await expect(section.getByRole("status")).toHaveText("Saved: nothing is locked.");
    await policies.uncheck();
  }
  expect(problems).toEqual([]);
});

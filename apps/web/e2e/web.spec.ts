// The web app as its server serves it, in Chromium, against a real server
// (e2e/server.ts): signing in each way the server offers, workspaces as
// vaults kept in the browser and synced, invitations, offline, one tab per
// workspace, and its content security policy kept throughout.
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
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

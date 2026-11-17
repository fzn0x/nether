// The web clipper in a browser (ADR 0066): the unpacked extension in
// Chromium, set up with a real server and a write token, clipping a page
// as a new note, a selection added to a note, and a page as a database
// row; each read back through the server's API.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, chromium, expect, test } from "@playwright/test";

const server = "http://127.0.0.1:4175";
const control = "http://127.0.0.1:4176";
const extension = fileURLToPath(new URL("../dist/test", import.meta.url));

const article = `<!doctype html><html><head><title>How tides work | The Sea Paper</title></head><body>
  <nav><a href="/">Home</a> <a href="/about">About us</a></nav>
  <article>
    <h1>How tides work</h1>
    <p class="byline">By Ada Lovelace</p>
    ${Array.from(
      { length: 8 },
      (_, index) =>
        `<p id="p${String(index + 1)}">The moon pulls the sea toward it, paragraph ${String(index + 1)} of a long article,
        with a <a href="notes/moon.html">link</a> and enough words for a reader view to take it
        for the page's text.</p>`,
    ).join("\n")}
  </article>
  <footer>Cookies and copyright</footer>
</body></html>`;

async function json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

/** Someone in Team with an account of their own, and a write token they made for the clipper. */
async function writer(): Promise<{ readonly token: string; readonly workspace: string }> {
  const email = `clipper-${String(Date.now())}@example.org`;
  const person = await json(`${control}/person`, {
    method: "POST",
    body: JSON.stringify({ name: "Clara", email }),
  });
  const session = await json(`${server}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: person.password }),
  });
  const bearer = { authorization: `Bearer ${String(session.token)}` };
  const token = await json(`${server}/api/tokens`, {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ name: "Clipper", access: "write", password: person.password }),
  });
  const { workspaces } = (await json(`${server}/api/v1/workspaces`, { headers: bearer })) as {
    workspaces: { id: string; name: string }[];
  };
  const team = workspaces.find((item) => item.name === "Team");
  if (team === undefined) throw new Error("Clara is not in Team.");
  return { token: String(token.token), workspace: team.id };
}

function api(token: string) {
  return (path: string, init: RequestInit = {}) =>
    json(`${server}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
}

let context: BrowserContext | undefined;

test.afterEach(async () => {
  await context?.close();
  context = undefined;
});

/** The popup, opened for the tab of the page to clip, as pressing the button opens it. */
async function open(id: string): Promise<Page> {
  if (context === undefined) throw new Error("No browser yet.");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const tab = await popup.evaluate(async () => {
    const tabs = await (
      globalThis as unknown as {
        chrome: { tabs: { query(query: object): Promise<{ id: number }[]> } };
      }
    ).chrome.tabs.query({ url: "https://sea.example/*" });
    return tabs[0]?.id ?? 0;
  });
  await popup.goto(`chrome-extension://${id}/popup.html?tab=${String(tab)}`);
  return popup;
}

test("clips a page as a note, a selection into a note, and a page as a database row", async () => {
  const id = (await readFile(join(extension, "extension-id.txt"), "utf8")).trim();
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "clipper-")), {
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route("https://sea.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: article }),
  );
  const { token, workspace } = await writer();
  const call = api(token);
  // Paths of this run's own, as Team keeps what earlier runs and retries made.
  const run = String(Date.now());
  const reading = await call(`/workspaces/${workspace}/notes`, {
    method: "POST",
    body: JSON.stringify({
      path: `Reading list ${run}.md`,
      markdown: "# Reading list\n\nTo read.\n",
    }),
  });
  const projects = await call(`/workspaces/${workspace}/notes`, {
    method: "POST",
    body: JSON.stringify({
      path: `Projects ${run}.md`,
      markdown: "---\ndatabase:\n  properties:\n    - key: source\n      type: url\n---\n",
    }),
  });

  // Setup: the server and the token, checked with the server.
  const page = await context.newPage();
  await page.goto("https://sea.example/2026/tides.html");
  let popup = await open(id);
  await popup.getByLabel("Server address").fill(server);
  await popup.getByLabel("API token").fill("nether_wrong");
  await popup.getByRole("button", { name: "Connect" }).click();
  await expect(popup.getByRole("alert")).toHaveText(
    "Send a token as Authorization: Bearer <token>, or sign in.",
  );
  await popup.getByLabel("API token").fill(token);
  await popup.getByRole("button", { name: "Connect" }).click();
  await expect(popup.getByText("Signed in to 127.0.0.1:4175 as Clara.")).toBeVisible();

  // The whole page, as a new note: its article, without the menus and footer.
  await expect(popup.getByLabel("The whole page")).toBeChecked();
  await expect(popup.getByLabel("The selection")).toBeDisabled();
  const markdown = popup.getByLabel("Markdown");
  await expect(markdown).toHaveValue(/paragraph 8 of a long article/);
  await expect(markdown).not.toHaveValue(/Cookies and copyright/);
  await expect(popup.getByLabel("Title")).toHaveValue("How tides work");
  await expect(popup.getByLabel("Folder")).toHaveValue("Clips");
  await popup.getByLabel("Folder").fill(`Clips ${run}`);
  await popup.getByRole("button", { name: "Save the clip" }).click();
  await expect(popup.getByRole("status")).toHaveText(
    `Saved to Clips ${run}/How tides work.md in Team.`,
  );
  const { notes } = (await call(
    `/workspaces/${workspace}/notes?folder=${encodeURIComponent(`Clips ${run}`)}`,
  )) as {
    notes: { id: string }[];
  };
  const clipped = await call(`/workspaces/${workspace}/notes/${notes[0]?.id ?? ""}`);
  expect(clipped.properties).toMatchObject({
    source: "https://sea.example/2026/tides.html",
    author: "By Ada Lovelace",
  });
  expect(String(clipped.markdown)).toContain("[link](https://sea.example/2026/notes/moon.html)");
  expect(String(clipped.markdown)).not.toContain("About us");

  // A selection, added to a note found by search, under a heading of the page's title.
  await popup.close();
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p2") ?? document.body);
    window.getSelection()?.addRange(range);
  });
  popup = await open(id);
  await expect(popup.getByLabel("The selection")).toBeChecked();
  await expect(popup.getByLabel("Markdown")).toHaveValue(/paragraph 2 of a long article/);
  await expect(popup.getByLabel("Markdown")).not.toHaveValue(/paragraph 3 of/);
  await popup.getByLabel("Added to a note").check();
  await popup.getByLabel("Find a note").fill(`reading ${run}`);
  await popup.getByRole("button", { name: "Find", exact: true }).click();
  await expect(popup.getByLabel("Note", { exact: true })).toHaveValue(String(reading.id));
  await popup.getByRole("button", { name: "Save the clip" }).click();
  await expect(popup.getByRole("status")).toHaveText(`Saved to Reading list ${run}.md in Team.`);
  const list = await call(`/workspaces/${workspace}/notes/${String(reading.id)}`);
  expect(String(list.markdown)).toMatch(
    /^# Reading list\n\nTo read\.\n\n## \[How tides work\]\(https:\/\/sea\.example\/2026\/tides\.html\)\n\nThe moon pulls the sea toward it, paragraph 2/,
  );

  // The whole page again, as a row of a database.
  await popup.getByLabel("The whole page").check();
  await popup.getByLabel("A database row").check();
  const pick = popup.getByLabel("Database", { exact: true });
  await expect(pick.getByRole("option", { name: `Projects ${run}` })).toHaveCount(1);
  await pick.selectOption({ label: `Projects ${run}` });
  await expect(pick).toHaveValue(String(projects.id));
  await popup.getByRole("button", { name: "Save the clip" }).click();
  await expect(popup.getByRole("status")).toHaveText(
    `Saved to Projects ${run}/How tides work.md in Team.`,
  );
  const { rows } = (await call(
    `/workspaces/${workspace}/databases/${String(projects.id)}/rows`,
  )) as {
    rows: { title: string; properties: Record<string, unknown> }[];
  };
  expect(rows).toEqual([
    expect.objectContaining({
      title: "How tides work",
      properties: expect.objectContaining({ source: "https://sea.example/2026/tides.html" }),
    }),
  ]);
});

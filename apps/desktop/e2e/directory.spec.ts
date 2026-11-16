// The plugin and theme directory (ADR 0065): its index and files come from
// GitHub, which these tests stand in for, so nothing here reaches the
// network. A plugin installs off until approved; a theme that would load
// from an address is refused; a file not the one named is refused.
import { createHash } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { errorsOf, openSample, violations } from "./helpers.ts";

const index = "https://raw.githubusercontent.com/fzn0x/nether/main/registry/index.json";
const commit = "0123456789abcdef0123456789abcdef01234567";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const at = (repo: string, file: string) =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${file}`;

const manifest = JSON.stringify({
  id: "word-goal",
  name: "Word goal",
  version: "1.0.0",
  api: "^0.1",
  contributes: { commands: [{ id: "cheer", name: "Cheer the writer" }] },
});
const code = `export default {
  async activate(context) {
    await context.commands.register("cheer", () => {});
  },
};
`;
const dusk = ":root { --accent: rgb(1, 2, 3); }\n";
const loud = "body { background: url(https://example.com/pixel.png); }\n";

const entries = {
  version: 1,
  plugins: [
    {
      id: "word-goal",
      name: "Word goal",
      description: "Cheers you on.",
      author: "someone",
      repo: "someone/nether-word-goal",
      commit,
      version: "1.0.0",
      files: { "manifest.json": hash(manifest), "main.js": hash(code) },
    },
  ],
  themes: [
    {
      id: "dusk",
      name: "Dusk",
      description: "Darker accents.",
      author: "someone",
      repo: "someone/nether-dusk",
      commit,
      files: { "dusk.css": hash(dusk) },
    },
    {
      id: "loud",
      name: "Loud",
      description: "Calls home.",
      author: "someone",
      repo: "someone/nether-loud",
      commit,
      files: { "loud.css": hash(loud) },
    },
  ],
};

/** Stands in for GitHub: the index, and each file at its commit; `main.js` as `served`. */
async function serveDirectory(page: Page, served = code): Promise<string[]> {
  const asked: string[] = [];
  const files: Record<string, string> = {
    [index]: JSON.stringify(entries),
    [at("someone/nether-word-goal", "manifest.json")]: manifest,
    [at("someone/nether-word-goal", "main.js")]: served,
    [at("someone/nether-dusk", "dusk.css")]: dusk,
    [at("someone/nether-loud", "loud.css")]: loud,
  };
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = route.request().url();
    asked.push(url);
    const body = files[url];
    await route.fulfill(
      body === undefined
        ? { status: 404, body: "404: Not Found" }
        : { status: 200, body, headers: { "access-control-allow-origin": "*" } },
    );
  });
  return asked;
}

async function openTab(page: Page, tab: RegExp) {
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("menu", { name: "Settings" }).getByRole("menuitem", { name: tab }).click();
}

test("the directory installs a plugin off, until this device turns it on", async ({ page }) => {
  const errors = errorsOf(page);
  const asked = await serveDirectory(page);
  await openSample(page);
  await openTab(page, /^Plugins/);
  const plugins = page.getByRole("tabpanel", { name: "Plugins" });
  const directory = plugins.getByRole("region", { name: "From the directory" });
  // Nothing is read until asked.
  expect(asked).toEqual([]);
  await directory.getByRole("button", { name: "Browse the directory" }).click();
  await expect(directory.getByText("Cheers you on. By someone. Version 1.0.0")).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await directory.getByRole("button", { name: "Install Word goal" }).click();
  await expect(
    directory.getByText("Word goal is installed. Turn it on above to approve it."),
  ).toBeVisible();
  await expect(directory.getByRole("button", { name: "Installed" })).toBeDisabled();
  const box = plugins.getByRole("checkbox", { name: "Word goal" });
  await expect(box).not.toBeChecked();
  await expect(plugins.getByText(/It asks for nothing more\./)).toBeVisible();
  await box.check();
  await plugins.getByRole("button", { name: "Save" }).click();

  await page.keyboard.press("Control+p");
  await page.keyboard.type("Cheer the writer");
  await expect(page.getByRole("option", { name: /Cheer the writer/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the directory installs no file but the one it names", async ({ page }) => {
  await serveDirectory(page, `${code}fetch("https://example.com/");\n`);
  await openSample(page);
  await openTab(page, /^Plugins/);
  const plugins = page.getByRole("tabpanel", { name: "Plugins" });
  await plugins.getByRole("button", { name: "Browse the directory" }).click();
  await plugins.getByRole("button", { name: "Install Word goal" }).click();
  await expect(plugins.getByRole("alert")).toHaveText(
    "Word goal's main.js is not the file the directory names.",
  );
  await expect(plugins.getByRole("checkbox", { name: "Word goal" })).toHaveCount(0);
});

test("the directory installs a theme, and refuses one that loads from an address", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await serveDirectory(page);
  await openSample(page);
  await openTab(page, /^Appearance/);
  const appearance = page.getByRole("tabpanel", { name: "Appearance" });
  await appearance.getByRole("button", { name: "Browse the directory" }).click();
  await appearance.getByRole("button", { name: "Install Dusk" }).click();
  await expect(
    appearance.getByText("Dusk is installed. Choose it as the theme above."),
  ).toBeVisible();
  const theme = appearance.getByRole("combobox", { name: "Theme" });
  await theme.selectOption("dusk");
  await expect(page.locator("html")).toHaveCSS("--accent", "rgb(1, 2, 3)");

  await appearance.getByRole("button", { name: "Install Loud" }).click();
  await expect(appearance.getByRole("alert")).toHaveText(
    "Loud cannot be installed: It loads something from an address.",
  );
  await expect(theme.locator("option", { hasText: "loud" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the directory says when it cannot be reached", async ({ page }) => {
  await page.route("https://raw.githubusercontent.com/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await openSample(page);
  await openTab(page, /^Plugins/);
  const plugins = page.getByRole("tabpanel", { name: "Plugins" });
  await plugins.getByRole("button", { name: "Browse the directory" }).click();
  await expect(plugins.getByRole("alert")).toContainText("The directory cannot be reached:");
  await expect(plugins.getByRole("button", { name: "Browse the directory" })).toBeVisible();
});

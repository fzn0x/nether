import { type Page, expect, test } from "@playwright/test";
import { errorsOf, openSample, violations } from "./helpers.ts";

// Nether's calendar (ADR 0090): an ICS feed added in the Connections tab,
// the calendar turned on in the Plugins tab, its events beside a note,
// drawn by the plugin running apart in the sandbox, and added to the note.

const feed = "https://calendar.example.test/private-abc123/basic.ics";

/** A day of the device's calendar as an ICS date, as `20261117`. */
function icsDay(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, at) => String(part).padStart(at === 0 ? 4 : 2, "0"))
    .join("");
}

/** A feed with a floating standup today, at 10:00 where the device is, and one tomorrow. */
function calendar(): string {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:standup@example.test",
    `DTSTART:${icsDay(today)}T100000`,
    `DTEND:${icsDay(today)}T103000`,
    "SUMMARY:Standup",
    "LOCATION:Room 2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:review@example.test",
    `DTSTART:${icsDay(tomorrow)}T140000`,
    `DTEND:${icsDay(tomorrow)}T150000`,
    "SUMMARY:Review",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
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

/** Opens the vault's settings at a tab, from the Settings menu. */
async function openSettings(page: Page, item: RegExp) {
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("menu", { name: "Settings" }).getByRole("menuitem", { name: item }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

test("a feed added on the device shows its events beside a note, and adds them to it", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const asked: (string | null)[] = [];
  // The preview fetches from the page, which a feed must allow; the app's Go fetch needs no CORS.
  await page.route(feed, async (route) => {
    asked.push(route.request().headers().authorization ?? null);
    await route.fulfill({
      status: 200,
      contentType: "text/calendar; charset=utf-8",
      headers: { "access-control-allow-origin": "*" },
      body: calendar(),
    });
  });
  await page.route("https://calendar.example.test/nothing.ics", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "access-control-allow-origin": "*" },
      body: "<html></html>",
    }),
  );
  const notes = await openSample(page);

  // The calendar is off until the vault turns it on.
  await notes.getByRole("button", { name: /Ideas/ }).click();
  const about = page.getByRole("complementary", { name: "About this note" });
  await expect(about.getByRole("region", { name: "Events" })).toHaveCount(0);

  const settings = await openSettings(page, /^Connections/);
  const tab = settings.getByRole("tabpanel", { name: "Connections" });
  await expect(tab.getByText("None yet.")).toBeVisible();
  await tab.getByRole("button", { name: "Add an ICS feed" }).click();
  // A page that is no calendar is refused, with why.
  await tab.getByLabel("Feed address").fill("https://calendar.example.test/nothing.ics");
  await tab.getByRole("button", { name: "Check and add" }).click();
  await expect(tab.getByRole("alert")).toHaveText("That address gives no calendar in iCal format.");
  await tab.getByLabel("Feed address").fill(feed.replace("https://", "webcal://"));
  await tab.getByRole("textbox", { name: "Name", exact: true }).fill("Work");
  expect(await violations(page)).toEqual([]);
  await tab.getByRole("button", { name: "Check and add" }).click();
  await expect(tab.getByRole("status")).toHaveText("Work is added.");
  // Only the feed's host shows; its whole address is its secret.
  await expect(tab.getByText("ICS feed at calendar.example.test.")).toBeVisible();
  await expect(tab).not.toContainText("private-abc123");
  await tab.getByRole("button", { name: "Close" }).click();

  const plugins = await openSettings(page, /^Plugins/);
  const pluginTab = plugins.getByRole("tabpanel", { name: "Plugins" });
  await expect(
    pluginTab.getByText(
      "It asks for reading the vault's notes and files, changing them, and your ICS feeds.",
    ),
  ).toBeVisible();
  await pluginTab.getByRole("checkbox", { name: "Calendar" }).check();
  await pluginTab.getByRole("button", { name: "Save" }).click();
  await expect(plugins).toBeHidden();
  await expect
    .poll(
      async () =>
        (
          JSON.parse((await fileText(page, ".nether/plugins.json")) ?? "{}") as Record<
            string,
            unknown
          >
        ).calendar,
    )
    .toBe(true);

  // Beside a note that is not a daily note, today's events.
  const events = about.getByRole("region", { name: "Events" });
  await expect(events.getByText("10:00-10:30 Standup (Room 2)")).toBeVisible();
  await expect(events).not.toContainText("Review");
  await expect(events.getByText(/^Updated at \d\d:\d\d$/)).toBeVisible();
  await events.getByRole("button", { name: "Add to the note" }).click();
  await expect(events.getByRole("status")).toHaveText("Added the day's events to the note.");
  await expect
    .poll(async () => fileText(page, "Projects/Ideas.md"))
    .toContain("- 10:00-10:30 Standup (Room 2)\n");
  // Checked as it was added, and read once, with no credential: its address is its secret.
  expect(asked).toEqual([null, null]);
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

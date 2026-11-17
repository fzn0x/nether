// The REST API's tokens and the workspace's webhooks, from the app (ADRs
// 0059 and 0060): a token made with the password, shown once, copied and
// another revoked; webhooks added, with the address the server refuses said
// so, tested, their events read, edited, turned off, given a new secret and
// removed; and someone who may not manage them told why. The server here is
// the test's.
import { type Page, type Request, expect, test } from "@playwright/test";
import {
  type Handler,
  errorsOf,
  fakeServer,
  openSample,
  pageErrors,
  violations,
} from "./helpers.ts";

const ada = { id: "u1", name: "Ada", email: "ada@example.org", instanceAdmin: false };

async function command(page: Page, name: string) {
  await page.keyboard.press("Control+p");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

const signInRoutes: Readonly<Record<string, Handler>> = {
  "GET /api/sign-in-methods": () => [200, { password: true, emailCode: false, oidc: null }],
  "POST /api/sessions": () => [201, { token: "session-token", expiresAt: "", user: ada }],
  "GET /api/me": () => [
    200,
    { user: ada, workspaces: [{ id: "w-team", name: "Team", role: "owner", encryption: "none" }] },
  ],
  "GET /api/workspaces/w-team/documents": () => [200, { documents: [], more: false }],
};

async function signIn(page: Page) {
  await command(page, "servers");
  const servers = page.getByRole("dialog", { name: "Servers" });
  await servers.getByRole("textbox", { name: "Server address" }).fill("nether.test");
  await servers.getByRole("button", { name: "Continue" }).click();
  await servers.getByRole("textbox", { name: "Email address" }).fill("ada@example.org");
  await servers.getByLabel("Password").fill("a long password");
  await servers.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(servers.getByRole("status")).toHaveText("Signed in to nether.test as Ada.");
  return servers;
}

async function syncVault(page: Page) {
  await command(page, "sync this vault");
  const sync = page.getByRole("dialog", { name: "Sync" });
  await sync.getByRole("button", { name: "Sync this vault" }).click();
  await expect(sync.getByText("This vault syncs with Team on nether.test.")).toBeVisible();
  await page.keyboard.press("Escape");
}

function asked(sent: readonly Request[], method: string, path: string) {
  return sent.filter(
    (request) => request.method() === method && new URL(request.url()).pathname === path,
  );
}

test("an account's API tokens are made with the password, shown once, and revoked", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = errorsOf(page);
  let tokens: object[] = [
    {
      id: "t1",
      name: "Backups",
      access: "read",
      hint: "x9Qk",
      workspace: null,
      expiresAt: null,
      createdAt: "2026-11-01T09:00:00.000Z",
      usedAt: "2026-11-10T09:00:00.000Z",
    },
  ];
  const sent = await fakeServer(page, {
    ...signInRoutes,
    "GET /api/tokens": () => [200, { tokens }],
    "POST /api/tokens": (request) => {
      const body = request.postDataJSON() as { password?: string };
      if (body.password !== "a long password") {
        return [403, { message: "That password is not this account's." }];
      }
      const made = {
        id: "t2",
        name: "Sync script",
        access: "write",
        hint: "1234",
        workspace: { id: "w-team", name: "Team" },
        expiresAt: "2027-02-15T09:00:00.000Z",
        createdAt: "2026-11-17T09:00:00.000Z",
        usedAt: null,
      };
      tokens = [...tokens, made];
      return [201, { ...made, token: "nether_secret1234" }];
    },
    "DELETE /api/tokens/t1": () => {
      tokens = tokens.filter((token) => (token as { id: string }).id !== "t1");
      return [204];
    },
  });
  await openSample(page);
  const servers = await signIn(page);
  await servers.getByRole("button", { name: "API tokens on nether.test" }).click();

  const dialog = page.getByRole("dialog", { name: "API tokens on nether.test" });
  const list = dialog.getByRole("list", { name: "API tokens" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Reads in every workspace");
  await expect(list).toContainText("Ends in x9Qk");
  await expect(list).toContainText("Never expires");
  await expect(list).toContainText("Last used");

  await dialog.getByRole("textbox", { name: "What it is for" }).fill("Sync script");
  await dialog.getByRole("combobox", { name: "Access" }).selectOption("write");
  await dialog.getByRole("combobox", { name: "Workspace" }).selectOption({ label: "Team" });
  await expect(dialog.getByRole("combobox", { name: "Expires" })).toHaveValue("90");
  await dialog.getByLabel("Your password").fill("not it");
  await dialog.getByRole("button", { name: "Make the token" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That password is not this account's.");

  await dialog.getByLabel("Your password").fill("a long password");
  await dialog.getByRole("button", { name: "Make the token" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Sync script is made. Copy it now: it is not shown again.",
  );
  const secret = dialog.getByRole("textbox", { name: "Your new token" });
  await expect(secret).toHaveValue("nether_secret1234");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("Reads and writes in Team");
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(dialog.getByRole("status")).toHaveText("The token is copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("nether_secret1234");
  expect(asked(sent, "POST", "/api/tokens").at(-1)?.postDataJSON()).toEqual({
    name: "Sync script",
    access: "write",
    workspace: "w-team",
    expiresInDays: 90,
    password: "a long password",
  });

  await dialog.getByRole("button", { name: "Revoke Backups" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Backups is revoked, and works no more.");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  expect(asked(sent, "DELETE", "/api/tokens/t1")).toHaveLength(1);
  expect(pageErrors(errors).filter((error) => !error.includes("WebSocket"))).toEqual([]);
});

test("a workspace's owner adds, tests, edits, turns off and removes its webhooks", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const base = "/api/v1/workspaces/w-team/webhooks";
  const old = "https://hooks.example.org/old";
  let hooks: Record<string, unknown>[] = [
    {
      id: "h1",
      url: old,
      events: ["note.created", "note.updated", "note.deleted"],
      enabled: true,
      failingSince: "2026-11-15T09:00:00.000Z",
      lastError: "The address answered 500.",
      maker: { id: "u1", name: "Ada" },
      createdAt: "2026-11-01T09:00:00.000Z",
    },
  ];
  const patch = (request: Request) => {
    hooks = hooks.map((hook) =>
      hook.id === "h1" ? { ...hook, ...(request.postDataJSON() as object) } : hook,
    );
    return [200, hooks.find((hook) => hook.id === "h1")] as const;
  };
  const sent = await fakeServer(page, {
    ...signInRoutes,
    [`GET ${base}`]: () => [200, { webhooks: hooks }],
    [`POST ${base}`]: (request) => {
      const body = request.postDataJSON() as { url: string; events: string[] };
      if (body.url.startsWith("http://")) {
        return [400, { message: "A webhook's address is https://." }];
      }
      const hook = {
        id: "h2",
        url: body.url,
        events: body.events,
        enabled: true,
        failingSince: null,
        lastError: null,
        maker: { id: "u1", name: "Ada" },
        createdAt: "2026-11-17T09:00:00.000Z",
      };
      hooks = [...hooks, hook];
      return [201, { ...hook, secret: "whsec_first" }];
    },
    [`PATCH ${base}/h1`]: patch,
    [`POST ${base}/h1/secret`]: () => [200, { ...hooks[0], secret: "whsec_second" }],
    [`POST ${base}/h1/test`]: () => [202, { delivery: "d1" }],
    [`GET ${base}/h1/deliveries`]: () => [
      200,
      {
        deliveries: [
          {
            id: "d1",
            type: "webhook.test",
            status: "failed",
            attempts: 8,
            answer: 500,
            error: "The address answered 500.",
            createdAt: "2026-11-15T09:00:00.000Z",
            nextAt: null,
            finishedAt: "2026-11-17T05:00:00.000Z",
          },
        ],
      },
    ],
    [`DELETE ${base}/h2`]: () => {
      hooks = hooks.filter((hook) => hook.id !== "h2");
      return [204];
    },
  });
  await openSample(page);
  await signIn(page);
  await page.keyboard.press("Escape");
  await syncVault(page);
  await command(page, "workspace webhooks");

  const dialog = page.getByRole("dialog", { name: "Webhooks of Team" });
  const list = dialog.getByRole("list", { name: "Webhooks" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText(old);
  await expect(list).toContainText("The address answered 500.");
  await expect(list).toContainText("Made by Ada");

  const address = dialog.getByRole("textbox", { name: "Address" });
  await address.fill("http://hooks.example.org/new");
  await dialog.getByRole("button", { name: "Add the webhook" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A webhook's address is https://.");
  await address.fill("https://hooks.example.org/new");
  await dialog.getByRole("group", { name: "Tell of" }).getByLabel("Notes changed").uncheck();
  await dialog.getByRole("button", { name: "Add the webhook" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "The webhook to https://hooks.example.org/new is added. Copy its secret now: it is not shown again.",
  );
  await expect(dialog.getByRole("textbox", { name: "Its secret" })).toHaveValue("whsec_first");
  expect(asked(sent, "POST", base).at(-1)?.postDataJSON()).toEqual({
    url: "https://hooks.example.org/new",
    events: ["note.created", "note.deleted"],
  });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  expect(await violations(page)).toEqual([]);

  await dialog.getByRole("button", { name: `Send a test event to ${old}` }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    `A test event goes to ${old} within a few seconds.`,
  );
  await dialog.getByRole("button", { name: `Recent events of the webhook to ${old}` }).click();
  const events = dialog.getByRole("list", { name: `Recent events of the webhook to ${old}` });
  await expect(events).toContainText("webhook.test, failed");
  await expect(events).toContainText("Tries: 8. Answered 500. The address answered 500.");
  expect(await violations(page)).toEqual([]);

  await dialog.getByRole("button", { name: `Give the webhook to ${old} a new secret` }).click();
  await expect(dialog.getByRole("textbox", { name: "Its secret" })).toHaveValue("whsec_second");

  await dialog.getByRole("button", { name: `Turn off the webhook to ${old}` }).click();
  await expect(dialog.getByRole("status")).toHaveText(`The webhook to ${old} is off.`);
  await expect(dialog.getByRole("button", { name: `Send a test event to ${old}` })).toBeDisabled();
  expect(asked(sent, "PATCH", `${base}/h1`).at(-1)?.postDataJSON()).toEqual({ enabled: false });

  await dialog.getByRole("button", { name: `Edit the webhook to ${old}` }).click();
  const editing = dialog.getByRole("group", { name: `Edit the webhook to ${old}` });
  await editing.getByRole("textbox", { name: "Address" }).fill("https://hooks.example.org/moved");
  await editing.getByLabel("Notes deleted").uncheck();
  await editing.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "The webhook to https://hooks.example.org/moved is saved.",
  );
  expect(asked(sent, "PATCH", `${base}/h1`).at(-1)?.postDataJSON()).toEqual({
    url: "https://hooks.example.org/moved",
    events: ["note.created", "note.updated"],
  });

  await dialog
    .getByRole("button", { name: "Remove the webhook to https://hooks.example.org/new" })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "The webhook to https://hooks.example.org/new is removed.",
  );
  await expect(list).not.toContainText("https://hooks.example.org/new");
  expect(asked(sent, "DELETE", `${base}/h2`)).toHaveLength(1);
  expect(pageErrors(errors).filter((error) => !error.includes("WebSocket"))).toEqual([]);
});

test("someone who does not manage the workspace's webhooks is told why", async ({ page }) => {
  await fakeServer(page, {
    ...signInRoutes,
    "GET /api/v1/workspaces/w-team/webhooks": () => [
      403,
      { message: "Only a workspace's owners and admins manage its webhooks." },
    ],
  });
  await openSample(page);
  await signIn(page);
  await page.keyboard.press("Escape");
  await syncVault(page);
  await command(page, "workspace webhooks");
  const dialog = page.getByRole("dialog", { name: "Webhooks of Team" });
  await expect(dialog.getByRole("alert")).toHaveText(
    "Only a workspace's owners and admins manage its webhooks.",
  );
  await expect(dialog.getByRole("button", { name: "Add the webhook" })).toHaveCount(0);
});

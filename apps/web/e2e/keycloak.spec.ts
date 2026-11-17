// Single sign-on against a real Keycloak (ADR 0080), as CI runs it in
// Docker with the realm beside this file: an instance admin adds Keycloak
// in the console by SAML, from its metadata's address, gives Keycloak
// Nether's certificate, which it then checks requests with and encrypts
// assertions to, and someone at corp.example signs in on Keycloak's own
// page; then the same through OpenID Connect. It runs when
// NETHER_TEST_KEYCLOAK names Keycloak's address, and is skipped otherwise.
import { type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";

const keycloak = process.env.NETHER_TEST_KEYCLOAK ?? "";
const password = "a long password";

test.skip(keycloak === "", "Set NETHER_TEST_KEYCLOAK to Keycloak's address to run these.");

/** Keycloak's admin API, as the master realm's admin. */
async function keycloakAdmin() {
  const answer = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "admin-cli",
      grant_type: "password",
      username: process.env.NETHER_TEST_KEYCLOAK_ADMIN ?? "admin",
      password: process.env.NETHER_TEST_KEYCLOAK_PASSWORD ?? "admin",
    }),
  });
  if (!answer.ok) throw new Error(`Keycloak's admin token: ${String(answer.status)}`);
  const { access_token: token } = (await answer.json()) as { access_token: string };
  return async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${keycloak}/admin/realms/nether${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!response.ok)
      throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
    return response;
  };
}

/** Gives Keycloak's SAML client Nether's certificate, to check its requests and to encrypt to. */
async function trustNether(certificate: string) {
  const api = await keycloakAdmin();
  const clientId = "http://127.0.0.1:4175/api/sso/keycloak/saml/metadata";
  const [client] = (await (
    await api(`/clients?clientId=${encodeURIComponent(clientId)}`)
  ).json()) as { id: string; attributes: Record<string, string> }[];
  if (client === undefined) throw new Error("The realm has no SAML client for Nether.");
  const base64 = certificate.replace(/-----[^-]+-----|\s+/g, "");
  await api(`/clients/${client.id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...client,
      attributes: {
        ...client.attributes,
        "saml.client.signature": "true",
        "saml.signing.certificate": base64,
        "saml.encrypt": "true",
        "saml.encryption.certificate": base64,
        "saml.encryption.algorithm": "http://www.w3.org/2009/xmlenc11#aes256-gcm",
        "saml.encryption.keyAlgorithm": "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p",
        // SHA-1 with RSA-OAEP, as node-saml 5 decrypts it.
        "saml.encryption.digestMethod": "http://www.w3.org/2000/09/xmldsig#sha1",
      },
    }),
  });
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

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  await dialog.getByRole("textbox", { name: "Email address" }).fill("ada@example.org");
  await dialog.getByLabel("Password").fill(password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Signed in to");
  await dialog.getByRole("button", { name: "Done" }).click();
}

/** Signs in through a provider's button, on Keycloak's own page, as `username`. */
async function throughKeycloak(context: BrowserContext, button: string, username: string) {
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  const dialog = page.getByRole("dialog", { name: "Account and encryption" });
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    dialog.getByRole("button", { name: button, exact: true }).click(),
  ]);
  await popup.waitForURL(`${keycloak}/**`);
  await popup.getByLabel(/Username or email/).fill(username);
  await popup.getByLabel("Password", { exact: true }).fill(password);
  await popup.getByRole("button", { name: "Sign In" }).click();
  // Keycloak's page posts its answer, and then the web app's page that takes it loads.
  await expect(dialog.getByRole("status")).toContainText("Signed in to", { timeout: 20_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  return page;
}

test("Keycloak signs people in by SAML and by OpenID Connect, as the console adds it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto("/admin");
  const sso = page
    .getByRole("region", { name: "Features" })
    .getByRole("checkbox", { name: "Single sign-on" });
  await sso.check();
  const section = page.getByRole("region", { name: "Single sign-on" });
  try {
    // SAML, from the metadata's address, which the server reads.
    await section.getByRole("button", { name: "Add a provider" }).click();
    await section.getByLabel("Short name").fill("keycloak");
    await section.getByLabel("Name, as the sign-in button shows it").fill("Keycloak");
    await section.getByLabel("Email domains").fill("corp.example");
    await section
      .getByLabel("Its metadata's address")
      .fill(`${keycloak}/realms/nether/protocol/saml/descriptor`);
    await section.getByLabel("Require encrypted assertions").check();
    await section.getByRole("button", { name: "Add it" }).click();
    await expect(section.getByRole("status")).toHaveText("Keycloak added.");
    const saml = section.getByRole("listitem").filter({ hasText: "SAML 2.0, keycloak" });
    await saml.getByText("What to give the provider").click();
    await trustNether(await saml.getByLabel(/Nether's certificate/).inputValue());

    // OpenID Connect, from the realm's issuer.
    await section.getByRole("button", { name: "Add a provider" }).click();
    await section.getByLabel("OpenID Connect").check();
    await section.getByLabel("Short name").fill("keycloak-oidc");
    await section.getByLabel("Name, as the sign-in button shows it").fill("Keycloak OIDC");
    await section.getByLabel("Email domains").fill("corp.test");
    await section.getByLabel("Issuer").fill(`${keycloak}/realms/nether`);
    await section.getByLabel("Client ID").fill("nether");
    await section.getByLabel("Client secret").fill("nether-client-secret");
    await section.getByRole("button", { name: "Add it" }).click();
    await expect(section.getByRole("status")).toHaveText("Keycloak OIDC added.");

    const theirs = await browser.newContext();
    try {
      // Grace, by SAML: her account made just in time, the assertion encrypted to Nether.
      const grace = await throughKeycloak(theirs, "Sign in with Keycloak", "grace");
      await expect(grace.getByText("Signed in as Grace Hopper, grace@corp.example")).toBeVisible();
      await grace.close();
    } finally {
      await theirs.close();
    }
    const others = await browser.newContext();
    try {
      // Hal, by OpenID Connect, at its domain: his account made too.
      const hal = await throughKeycloak(others, "Sign in with Keycloak OIDC", "hal");
      await expect(hal.getByText("Signed in as Hal Abelson, hal@corp.test")).toBeVisible();
    } finally {
      await others.close();
    }
  } finally {
    await removeProviders(section);
    await sso.uncheck();
  }
});

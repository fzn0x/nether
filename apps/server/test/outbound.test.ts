// Requests the server sends where it is told (ADR 0060): public addresses
// only unless the admin allows others, checked as sent and connected to as
// checked; no redirects followed; and Standard Webhooks' signatures.
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Resolver,
  addressProblem,
  allowsPrivate,
  checkedFetch,
  isPublicAddress,
  newSecret,
  post,
  signature,
} from "../src/outbound.ts";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly url: string;
}

/** A receiver on the loopback address, answering each request as `answer` says. */
async function receiver(
  answer: (response: import("node:http").ServerResponse) => void = (response) =>
    response.writeHead(204).end(),
): Promise<{ readonly port: number; readonly received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body, url: request.url ?? "" });
      answer(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

/** A resolver that gives each host the addresses named, as DNS a test controls. */
function resolver(addresses: Record<string, string[]>): Resolver {
  return (host) =>
    Promise.resolve(
      (addresses[host] ?? []).map((address) => ({
        address,
        family: address.includes(":") ? (6 as const) : (4 as const),
      })),
    );
}

describe("isPublicAddress", () => {
  it("takes public addresses, and none of the loopback, private and reserved ones", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "::ffff:0:808:808",
      "::ffff:0:7f00:1",
      "2002:7f00:1::",
      "2001::1",
      "2001:db8::1",
      "ff02::1",
      "not an address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("allowsPrivate", () => {
  it("allows every address, none, or the addresses and ranges the admin names", () => {
    const named = ["192.168.1.20", "10.0.0.0/8", "loopback", "fd00::/8"];
    for (const address of ["192.168.1.20", "10.9.9.9", "127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(allowsPrivate(named, address), address).toBe(true);
    }
    expect(allowsPrivate(named, "fd12::1")).toBe(true);
    for (const address of ["192.168.1.21", "169.254.169.254", "172.16.0.1", "fe80::1"]) {
      expect(allowsPrivate(named, address), address).toBe(false);
    }
    expect(allowsPrivate(true, "169.254.169.254")).toBe(true);
    expect(allowsPrivate(false, "127.0.0.1")).toBe(false);
  });
});

describe("addressProblem", () => {
  it("takes https://, and http:// only when the admin allows private addresses", () => {
    expect(addressProblem("https://hooks.example.org/nether", false)).toBeUndefined();
    expect(addressProblem("http://hooks.example.org/nether", false)).toContain("https://");
    expect(addressProblem("http://n8n.lan:5678/hook", ["192.168.1.20"])).toBeUndefined();
    expect(addressProblem("ftp://hooks.example.org", true)).toContain("https://");
    expect(addressProblem("https://user:secret@hooks.example.org", false)).toContain("password");
    expect(addressProblem("not an address", false)).toBe("This is not an address.");
  });

  it("refuses an address that is not public, unless the admin allows it", () => {
    expect(addressProblem("https://127.0.0.1/hook", false)).toContain("not a public one");
    expect(addressProblem("https://[::ffff:169.254.169.254]/", false)).toContain(
      "not a public one",
    );
    expect(addressProblem("https://169.254.169.254/latest", ["loopback"])).toContain(
      "not a public one",
    );
    expect(addressProblem("https://127.0.0.1/hook", ["loopback"])).toBeUndefined();
  });
});

describe("signature", () => {
  it("signs as Standard Webhooks' own tests do", () => {
    expect(
      signature(
        "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        "msg_p5jXN8AQM9LWM0D4loKWxJek",
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("makes secrets of 32 random bytes", () => {
    const secret = newSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(secret.slice("whsec_".length), "base64")).toHaveLength(32);
    expect(newSecret()).not.toBe(secret);
  });
});

describe("post", () => {
  it("connects to the address it checked, whatever the name resolves to later", async () => {
    const { port, received } = await receiver();
    const outcome = await post(
      `http://hooks.example:${String(port)}/nether?from=test`,
      { "webhook-id": "event" },
      '{"type":"webhook.test"}',
      { policy: ["loopback"], resolve: resolver({ "hooks.example": ["127.0.0.1"] }) },
    );
    expect(outcome).toEqual({ ok: true, status: 204 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      url: "/nether?from=test",
      body: '{"type":"webhook.test"}',
      headers: {
        host: `hooks.example:${String(port)}`,
        "webhook-id": "event",
        "content-type": "application/json",
      },
    });
  });

  it("refuses an address that is not public before connecting", async () => {
    const { port, received } = await receiver();
    const url = `http://hooks.example:${String(port)}/`;
    const refused = await post(url, {}, "{}", {
      policy: false,
      resolve: resolver({ "hooks.example": ["127.0.0.1"] }),
    });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toContain("127.0.0.1, which is not a public address");
    // One private address among public ones is enough to refuse.
    const mixed = await post(url, {}, "{}", {
      policy: false,
      resolve: resolver({ "hooks.example": ["8.8.8.8", "10.0.0.1"] }),
    });
    expect(mixed.ok ? "" : mixed.error).toContain("10.0.0.1");
    // http:// goes to an allowed private address only.
    const plain = await post(url, {}, "{}", {
      policy: true,
      resolve: resolver({ "hooks.example": ["8.8.8.8"] }),
    });
    expect(plain.ok ? "" : plain.error).toContain("http://");
    const literal = await post(`http://127.0.0.1:${String(port)}/`, {}, "{}", { policy: false });
    expect(literal.ok).toBe(false);
    const nowhere = await post(url, {}, "{}", { policy: true, resolve: resolver({}) });
    expect(nowhere.ok ? "" : nowhere.error).toContain("resolves to no address");
    expect(received).toHaveLength(0);
  });

  it("delivers on a 2xx answer only, and follows no redirect", async () => {
    const options = { policy: true, resolve: resolver({ "hooks.example": ["127.0.0.1"] }) };
    const moved = await receiver((response) =>
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end(),
    );
    expect(await post(`http://hooks.example:${String(moved.port)}/`, {}, "{}", options)).toEqual({
      ok: false,
      status: 302,
      error: "The address answered 302.",
    });
    expect(moved.received).toHaveLength(1);
    const failing = await receiver((response) => response.writeHead(500).end("broken"));
    expect(
      await post(`http://hooks.example:${String(failing.port)}/`, {}, "{}", options),
    ).toMatchObject({ ok: false, status: 500 });
  });

  it("gives up on an address that does not answer in time", async () => {
    const silent = await receiver(() => {
      // Never answers.
    });
    const outcome = await post(`http://hooks.example:${String(silent.port)}/`, {}, "{}", {
      policy: true,
      resolve: resolver({ "hooks.example": ["127.0.0.1"] }),
      timeout: 200,
    });
    expect(outcome).toEqual({ ok: false, error: "No answer within 0.2 seconds." });
  });
});

describe("checkedFetch", () => {
  it("fetches through the address it checked, and gives the answer as fetch does", async () => {
    const { port, received } = await receiver((response) =>
      response.writeHead(200, { "content-type": "application/xml" }).end("<EntityDescriptor/>"),
    );
    const fetcher = checkedFetch({
      policy: ["loopback"],
      resolve: resolver({ "idp.example": ["127.0.0.1"] }),
    });
    const answer = await fetcher(`http://idp.example:${String(port)}/metadata?x=1`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/xml");
    expect(await answer.text()).toBe("<EntityDescriptor/>");
    const posted = await fetcher(`http://idp.example:${String(port)}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });
    expect(posted.ok).toBe(true);
    expect(received.map(({ url, body }) => [url, body])).toEqual([
      ["/metadata?x=1", ""],
      ["/token", "grant_type=authorization_code"],
    ]);
  });

  it("refuses an address that is not public, follows no redirect, and reads no more than its limit", async () => {
    const { port, received } = await receiver((response) =>
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end(),
    );
    const refuse = checkedFetch({
      policy: false,
      resolve: resolver({ "idp.example": ["127.0.0.1"] }),
      allowedBy: "NETHER_SSO_PRIVATE",
    });
    await expect(refuse(`http://idp.example:${String(port)}/`)).rejects.toThrow(
      "127.0.0.1, which is not a public address: the server's admin can allow it with NETHER_SSO_PRIVATE.",
    );
    expect(received).toHaveLength(0);
    const allow = { policy: true, resolve: resolver({ "idp.example": ["127.0.0.1"] }) };
    const moved = await checkedFetch(allow)(`http://idp.example:${String(port)}/`);
    expect(moved.status).toBe(302);
    expect(received).toHaveLength(1);
    const large = await receiver((response) => response.writeHead(200).end("x".repeat(2000)));
    await expect(
      checkedFetch({ ...allow, limit: 1000 })(`http://idp.example:${String(large.port)}/`),
    ).rejects.toThrow("The answer is larger than 1000 bytes.");
  });
});

// What each built-in role may do (ADR 0089): every route that a role
// decides, asked by an owner, an admin, a member and a guest, as one table.
// The table was written before the server's checks read a role's settings,
// and holds the same after.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskBlobs } from "../src/blobs.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

type Test = TestServer & SetUp;
type Role = "owner" | "admin" | "member" | "guest";
interface Person {
  readonly token: string;
  readonly id: string;
}
type Answer = number | "ok";

const roles: readonly Role[] = ["owner", "admin", "member", "guest"];

let test: Test;
let folder: string;
let people: Record<Role, Person>;
/** A page shared on its own, which the guest has full access to. */
let page: string;
/** Members whose roles the table changes, and those it removes. */
let tom: Person;
const removable: Partial<Record<Role, Person>> = {};

async function join(name: string, role: "admin" | "member" = "member"): Promise<Person> {
  const invited = await test.server.inject({
    method: "POST",
    url: `/api/workspaces/${test.workspaceId}/invitations`,
    headers: bearer(test.token),
    payload: { role },
  });
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: {
      token: invited.json<{ token: string }>().token,
      name,
      email: `${name.toLowerCase()}@example.org`,
      password: `${name}'s long password`,
    },
  });
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { token: body.token, id: body.user.id };
}

function call(
  person: Person,
  method: string,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return test.server.inject({
    method: method as "GET",
    url: path.startsWith("/api/") ? path : `/api/workspaces/${test.workspaceId}${path}`,
    headers: { ...bearer(person.token), ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A success as `ok`, anything else as its status. */
function answer(response: LightMyRequestResponse): Answer {
  return response.statusCode < 300 ? "ok" : response.statusCode;
}

beforeAll(async () => {
  folder = await mkdtemp(joinPath(tmpdir(), "nether-roles-"));
  const running = await startServer({ blobs: new DiskBlobs(folder) });
  test = { ...running, ...(await setUp(running)) };
  const owner = { token: test.token, id: test.userId };
  const admin = await join("Adam", "admin");
  const member = await join("Mia");
  const guest = await join("Gus");
  await test.db.query("UPDATE memberships SET role = 'guest' WHERE user_id = $1", [guest.id]);
  people = { owner, admin, member, guest };
  tom = await join("Tom");
  for (const role of roles) removable[role] = await join(`Rex${role}`);
  const shared = await call(owner, "POST", "/pages", { note: randomUUID() });
  page = shared.json<{ id: string }>().id;
  const granted = await call(owner, "PUT", `/units/${page}/grants/${guest.id}`, { level: "full" });
  expect(granted.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await test.close();
  await rm(folder, { recursive: true, force: true });
});

/** Each row: what it asks, and the answer each role gets. */
const table: readonly {
  readonly does: string;
  readonly ask: (person: Person, role: Role) => Promise<LightMyRequestResponse>;
  readonly answers: Readonly<Record<Role, Answer>>;
}[] = [
  {
    does: "lists the members",
    ask: (person) => call(person, "GET", "/members"),
    answers: { owner: "ok", admin: "ok", member: "ok", guest: 403 },
  },
  {
    does: "invites a member",
    ask: (person) => call(person, "POST", "/invitations", { role: "member" }),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "invites an admin",
    ask: (person) => call(person, "POST", "/invitations", { role: "admin" }),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "lists the invitations",
    ask: (person) => call(person, "GET", "/invitations"),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "invites a guest to a page it has full access to",
    ask: (person) =>
      call(person, "POST", "/invitations", { role: "guest", unit: page, level: "view" }),
    answers: { owner: "ok", admin: "ok", member: "ok", guest: "ok" },
  },
  {
    does: "changes a member's role",
    ask: (person) => call(person, "PATCH", `/members/${tom.id}`, { role: "member" }),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "changes an admin's role",
    ask: (person) => call(person, "PATCH", `/members/${people.admin.id}`, { role: "admin" }),
    answers: { owner: "ok", admin: 403, member: 403, guest: 403 },
  },
  {
    does: "removes a member",
    ask: (person, role) => call(person, "DELETE", `/members/${removable[role]?.id ?? ""}`),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "makes a teamspace",
    ask: (person, role) => call(person, "POST", "/teamspaces", { name: `Team of the ${role}` }),
    answers: { owner: "ok", admin: "ok", member: "ok", guest: 403 },
  },
  {
    does: "has a private space",
    ask: (person) => call(person, "PUT", "/private"),
    answers: { owner: "ok", admin: "ok", member: "ok", guest: 403 },
  },
  {
    does: "changes the workspace's settings",
    ask: (person) => call(person, "PATCH", "", { ai: true }),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "turns publishing on or off",
    ask: (person) => call(person, "PUT", "/publishing", { enabled: true }),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "lists the webhooks",
    ask: (person) => call(person, "GET", `/api/v1/workspaces/${test.workspaceId}/webhooks`),
    answers: { owner: "ok", admin: "ok", member: 403, guest: 403 },
  },
  {
    does: "lists the links of a page it has full access to",
    ask: (person) => call(person, "GET", `/units/${page}/links`),
    answers: { owner: "ok", admin: "ok", member: "ok", guest: "ok" },
  },
  {
    does: "sends an attachment",
    ask: (person, role) => {
      const bytes = Buffer.from(`an image of the ${role}`);
      const hash = createHash("sha256").update(bytes).digest("hex");
      return call(person, "PUT", `/attachments/${hash}`, bytes, {
        "content-type": "application/octet-stream",
      });
    },
    answers: { owner: "ok", admin: "ok", member: "ok", guest: 403 },
  },
];

describe("each built-in role", () => {
  it.each(table)("$does", async ({ ask, answers }) => {
    const got: Partial<Record<Role, Answer>> = {};
    for (const role of roles) got[role] = answer(await ask(people[role], role));
    expect(got).toEqual(answers);
  });

  it("opens General at full access, but for a guest", async () => {
    const general: Partial<Record<Role, string | undefined>> = {};
    for (const role of roles) {
      const { units } = (await call(people[role], "GET", "/units")).json<{
        units: { id: string; level: string }[];
      }>();
      general[role] = units.find((unit) => unit.id === "general")?.level;
    }
    expect(general).toEqual({
      owner: "full",
      admin: "full",
      member: "full",
      guest: undefined,
    });
  });

  it("manages every site as an owner or an admin", async () => {
    const manages: Partial<Record<Role, unknown>> = {};
    for (const role of roles) {
      manages[role] = (await call(people[role], "GET", "/sites")).json<{
        manages: unknown;
      }>().manages;
    }
    expect(manages).toEqual({ owner: true, admin: true, member: false, guest: false });
  });

  it("gives a guest no teamspace", async () => {
    const made = await call(people.owner, "POST", "/teamspaces", { name: "Closed to guests" });
    const id = made.json<{ id: string }>().id;
    const given = await call(people.owner, "PUT", `/units/${id}/grants/${people.guest.id}`, {
      level: "view",
    });
    expect(given.statusCode).toBe(400);
  });
});

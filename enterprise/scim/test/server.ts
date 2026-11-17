// A server with the scim module for a test, its console's directories,
// and SCIM requests as a provider sends them, with the directory's token.
import { policiesModule } from "@nether/enterprise-policies";
import type { ServerEvent } from "@nether/server/src/events.ts";
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  startServer,
} from "@nether/server/test/app.ts";
import { scimModule } from "../src/index.ts";

export const publicUrl = "https://nether.example.org";

export type Test = TestServer & SetUp & { readonly told: ServerEvent[] };

let running: Test | undefined;

/** Closes the server a test started, if one is running. */
export async function stop(): Promise<void> {
  await running?.close();
  running = undefined;
}

/** A server with the feature on, a public address, and every event it tells of kept in order. */
export async function start(env: Record<string, string> = {}): Promise<Test> {
  const told: ServerEvent[] = [];
  const listening: EnterpriseModule = {
    feature: "audit",
    plugin: (_app, { events }) => {
      events.listen((event) => {
        told.push(event);
        return Promise.resolve();
      });
      return Promise.resolve();
    },
  };
  const server = await startServer({
    env: {
      NETHER_PUBLIC_URL: publicUrl,
      NETHER_ENTERPRISE_SCIM: "on",
      NETHER_ENTERPRISE_POLICIES: "on",
      ...env,
    },
    enterpriseModules: [scimModule, policiesModule, listening],
  });
  running = { ...server, ...(await setUp(server)), told };
  return running;
}

/** A request from the console, as the instance admin, or another session. */
export function admin(
  test: Test,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
  token = test.token,
) {
  return test.server.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A directory added on the console, with a token made for it. */
export async function addDirectory(
  test: Test,
  input: { id: string; name?: string; domains: string[]; otherDomains?: boolean },
): Promise<{ readonly id: string; readonly token: string; readonly base: string }> {
  const added = await admin(test, "POST", "/api/admin/directories", {
    name: input.id,
    ...input,
  });
  if (added.statusCode !== 201) throw new Error(`The directory was not added: ${added.body}`);
  const made = await admin(test, "POST", `/api/admin/directories/${input.id}/token`, {});
  if (made.statusCode !== 201) throw new Error(`No token was made: ${made.body}`);
  return {
    id: input.id,
    token: made.json<{ token: string }>().token,
    base: `/api/scim/${input.id}/v2`,
  };
}

/** A SCIM request as a provider sends it: `application/scim+json`, with the directory's bearer token. */
export function scim(
  test: Test,
  directory: { readonly token: string; readonly base: string },
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  contentType = "application/scim+json",
) {
  return test.server.inject({
    method,
    url: `${directory.base}${path}`,
    headers: {
      authorization: `Bearer ${directory.token}`,
      ...(body === undefined ? {} : { "content-type": contentType }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** A query's filter, encoded as a provider sends it. */
export function filtered(filter: string, extra = ""): string {
  return `/Users?filter=${encodeURIComponent(filter)}${extra}`;
}

/** Someone invited to the setup's workspace, with a new account and a password. */
export async function join(test: Test, email: string, name: string) {
  const invited = await admin(test, "POST", `/api/workspaces/${test.workspaceId}/invitations`, {
    role: "member",
  });
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: {
      token: invited.json<{ token: string }>().token,
      name,
      email,
      password: `${name}'s long password`,
    },
  });
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { token: body.token, id: body.user.id, password: `${name}'s long password` };
}

/** The actions told of since `from`, in order. */
export function actions(test: Test, from = 0): string[] {
  return test.told.slice(from).map((event) => event.action);
}

export const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
export const listSchema = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const errorSchema = "urn:ietf:params:scim:api:messages:2.0:Error";
export const enterpriseSchema = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

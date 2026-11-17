// SCIM's answers (RFC 7644): `application/scim+json`, and an error as its
// error schema has it, with `status` as a string, a `scimType` where one
// fits, and a `detail` that says what to change.
import type { FastifyReply } from "fastify";

export const scimJson = "application/scim+json; charset=utf-8";

export const errorSchema = "urn:ietf:params:scim:api:messages:2.0:Error";

/** The `scimType`s Nether answers with (RFC 7644, section 3.12). */
export type ScimType =
  | "invalidFilter"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "mutability"
  | "uniqueness"
  | "tooMany";

/** A request refused, as SCIM answers it. */
export class ScimError extends Error {
  override readonly name = "ScimError";
  readonly status: number;
  readonly scimType: ScimType | undefined;

  constructor(status: number, detail: string, scimType?: ScimType) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

/** Sends a SCIM answer. */
export function sendScim(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply.code(status).type(scimJson).send(body);
}

/** Sends an error as SCIM's error schema has it. */
export function sendError(reply: FastifyReply, error: ScimError): FastifyReply {
  return sendScim(reply, error.status, {
    schemas: [errorSchema],
    status: String(error.status),
    ...(error.scimType === undefined ? {} : { scimType: error.scimType }),
    detail: error.message,
  });
}

// What a SCIM directory's address says of itself (RFC 7643, sections 5 to
// 7): what the server supports, its resource types, and the schemas, with
// the attributes Nether keeps.
import { coreUserSchema } from "./paths.ts";

export const listSchema = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const configSchema = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const resourceTypeSchema = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const schemaSchema = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** Results a page holds at most. */
export const mostResults = 1000;

function meta(resourceType: string, base: string | null, path: string) {
  return { resourceType, ...(base === null ? {} : { location: `${base}${path}` }) };
}

/** What the server supports: PATCH and filters, and a bearer token; no bulk, sort, ETags or password changes. */
export function serviceProviderConfig(base: string | null) {
  return {
    schemas: [configSchema],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: mostResults },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "The token the console's Directories page makes for this directory.",
        primary: true,
      },
    ],
    meta: meta("ServiceProviderConfig", base, "/ServiceProviderConfig"),
  };
}

export function userResourceType(base: string | null) {
  return {
    schemas: [resourceTypeSchema],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "An account on the server",
    schema: coreUserSchema,
    meta: meta("ResourceType", base, "/ResourceTypes/User"),
  };
}

function attribute(
  name: string,
  extra: {
    readonly type?: string;
    readonly multiValued?: boolean;
    readonly required?: boolean;
    readonly mutability?: string;
    readonly uniqueness?: string;
    readonly subAttributes?: readonly object[];
    readonly description: string;
  },
) {
  return {
    name,
    type: extra.type ?? "string",
    multiValued: extra.multiValued ?? false,
    description: extra.description,
    required: extra.required ?? false,
    caseExact: false,
    mutability: extra.mutability ?? "readWrite",
    returned: "default",
    uniqueness: extra.uniqueness ?? "none",
    ...(extra.subAttributes === undefined ? {} : { subAttributes: extra.subAttributes }),
  };
}

/** The core User schema, with the attributes Nether keeps. */
export function userSchema(base: string | null) {
  return {
    schemas: [schemaSchema],
    id: coreUserSchema,
    name: "User",
    description: "An account on the server",
    attributes: [
      attribute("userName", {
        required: true,
        uniqueness: "server",
        description: "Unique within the directory, compared without regard to case.",
      }),
      attribute("name", {
        type: "complex",
        description: "The person's name; the account's comes from it when displayName is empty.",
        subAttributes: [
          "formatted",
          "familyName",
          "givenName",
          "middleName",
          "honorificPrefix",
          "honorificSuffix",
        ].map((part) => attribute(part, { description: `The ${part} part of the name.` })),
      }),
      attribute("displayName", { description: "The account's name." }),
      attribute("emails", {
        type: "complex",
        multiValued: true,
        description:
          "The account's address is the primary one, else the one typed work, else the first.",
        subAttributes: [
          attribute("value", { description: "An email address." }),
          attribute("type", { description: "work, home or other." }),
          attribute("primary", {
            type: "boolean",
            description: "Whether it is the account's address.",
          }),
          attribute("display", { description: "How it is shown." }),
        ],
      }),
      attribute("active", {
        type: "boolean",
        description: "Whether the account signs in; false deactivates it.",
      }),
      attribute("groups", {
        type: "complex",
        multiValued: true,
        mutability: "readOnly",
        description: "The directory's groups the account is in.",
        subAttributes: [
          attribute("value", { mutability: "readOnly", description: "The group's id." }),
          attribute("display", { mutability: "readOnly", description: "The group's name." }),
        ],
      }),
    ],
    meta: meta("Schema", base, `/Schemas/${coreUserSchema}`),
  };
}

/** A list of resources, as SCIM's ListResponse. */
export function listOf(resources: readonly unknown[], total = resources.length, startIndex = 1) {
  return {
    schemas: [listSchema],
    totalResults: total,
    itemsPerPage: resources.length,
    startIndex,
    Resources: resources,
  };
}

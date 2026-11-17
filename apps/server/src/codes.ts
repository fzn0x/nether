// Signing in by email (ADR 0033). Someone names their address; if it has
// an account, the server emails it a code of eight digits, which signs in
// once within 15 minutes. Asking answers the same whether or not the
// address has an account, and as fast, since the code is made and sent
// after the answer. Five wrong tries spend a code, and asking again
// replaces it. Only a code's SHA-256 is kept. A deactivated account is
// sent none, with the answer every address gets (ADR 0085).
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Database, readBoolean, readNumber, readText } from "./db.ts";
import { emailField, emailKey, fail, limitBy, limitByAddress } from "./http.ts";
import type { Mailer } from "./mail.ts";
import { type NewSession, startSession, useProvider } from "./sessions.ts";
import type { SecuritySettings } from "./settings.ts";
import { SignInRefused, signInGuards } from "./signIns.ts";
import { type ServerEvents, accountActor, originOf } from "./events.ts";

/** Minutes a code lasts. */
export const codeMinutes = 15;
/** Wrong tries that spend a code. */
export const codeTries = 5;

/** A new code: eight random digits, shown in two groups of four. */
export function newCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

function codeHash(digits: string): string {
  return createHash("sha256").update(digits).digest("hex");
}

/** The digits of a code as someone types it, with spaces or dashes between. */
function digitsOf(code: string): string | undefined {
  const digits = code.replace(/[\s-]/g, "");
  return /^\d{8}$/.test(digits) ? digits : undefined;
}

interface Ask {
  readonly email: string;
}

const askBody = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: { email: emailField },
} as const;

interface Redeem {
  readonly email: string;
  readonly code: string;
}

const redeemBody = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 1, maxLength: 320 },
    code: { type: "string", minLength: 1, maxLength: 32 },
  },
} as const;

const wrongCode = "That code is not this address's, or has been used or has expired.";

/** Makes a code for an address that has an account, not deactivated, and emails it. */
async function sendCode(
  db: Database,
  mailer: Mailer,
  email: string,
  publicUrl: string | null,
): Promise<void> {
  const { rows } = await db.query(
    "SELECT id, name, email, instance_admin FROM users WHERE email_key = $1 AND deactivated_at IS NULL",
    [emailKey(email)],
  );
  const user = rows[0];
  if (user === undefined) return;
  const userId = readText(user, "id");
  // None for an account whose codes no longer sign it in, as single sign-on
  // may require (ADR 0080); the answer is the same either way.
  const refusal = await signInGuards(db).check(
    {
      userId,
      email: readText(user, "email"),
      instanceAdmin: readBoolean(user, "instance_admin"),
      method: "code",
      provider: null,
    },
    db,
  );
  if (refusal !== undefined) return;
  const code = newCode();
  await db.transaction(async (tx) => {
    // One code at a time, and none kept past its time.
    await tx.query("DELETE FROM sign_in_codes WHERE user_id = $1 OR expires_at < now()", [userId]);
    await tx.query(
      `INSERT INTO sign_in_codes (id, user_id, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + $4 * interval '1 minute')`,
      [randomUUID(), userId, codeHash(code), codeMinutes],
    );
  });
  const shown = `${code.slice(0, 4)} ${code.slice(4)}`;
  await mailer.send({
    to: readText(user, "email"),
    subject: `Nether sign-in code ${shown}`,
    text: [
      `Hello ${readText(user, "name")},`,
      "",
      "Your code to sign in to Nether is",
      "",
      `    ${shown}`,
      "",
      // The web app signs in from the link (ADR 0053); the code is after #, never sent to the server's logs.
      ...(publicUrl === null
        ? []
        : [
            "or open this link:",
            "",
            `    ${publicUrl.replace(/\/+$/, "")}/sign-in#${new URLSearchParams({ email: readText(user, "email"), code }).toString()}`,
            "",
          ]),
      `It works once, within ${String(codeMinutes)} minutes. If you did not ask to sign in,`,
      "ignore this email: no one can sign in without the code.",
      "",
    ].join("\n"),
  });
}

/**
 * The routes of signing in by email, which a server has only when it can
 * send email, and while the security settings let codes sign in (ADR 0084).
 */
export function registerCodes(
  app: FastifyInstance,
  db: Database,
  mailer: Mailer,
  security: SecuritySettings,
  events: ServerEvents,
  publicUrl: string | null = null,
): void {
  const guards = signInGuards(db);
  // Off, they answer as on a server without mail, before any try is counted.
  const whenOn = async (request: FastifyRequest, reply: FastifyReply) => {
    if ((await security.values()).emailCodes) return undefined;
    const path = request.url.split("?")[0] ?? request.url;
    return fail(reply, 404, `Route ${request.method}:${path} not found`);
  };
  const sending = new Set<Promise<void>>();
  app.addHook("onClose", async () => {
    await Promise.allSettled(sending);
  });

  function send(email: string, log: FastifyBaseLogger): void {
    const sent = sendCode(db, mailer, email, publicUrl)
      .catch((error: unknown) => {
        log.error({ err: error }, "Could not email a sign-in code");
      })
      .finally(() => sending.delete(sent));
    sending.add(sent);
  }

  app.post<{ Body: Ask }>(
    "/api/sign-in-codes",
    {
      schema: { body: askBody },
      onRequest: [whenOn, limitByAddress(app, "sign-in-codes", 10, "15 minutes")],
      // A few emails to one address, however many ask for them.
      preHandler: limitBy(app, "sign-in-codes-to", 3, "15 minutes", (request) =>
        emailKey((request.body as Ask).email),
      ),
    },
    async (request, reply) => {
      send(request.body.email, request.log);
      return reply.code(202).send({
        message: "If this address has an account, a code to sign in is on its way to it.",
      });
    },
  );

  app.post<{ Body: Redeem }>(
    "/api/sign-in-codes/redeem",
    {
      schema: { body: redeemBody },
      // Redeeming a code tries it as signing in tries a password: the same limit per address.
      onRequest: [
        whenOn,
        limitByAddress(
          app,
          "sign-in-code-redeem",
          async () => (await security.values()).signInTriesAddress,
          "5 minutes",
        ),
      ],
    },
    async (request, reply) => {
      const required = await guards.requiredFor(request.body.email);
      const digits = digitsOf(request.body.code);
      const outcome = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `SELECT c.id AS code_id, c.code_hash, c.tries, u.id, u.name, u.email, u.instance_admin
             FROM sign_in_codes c JOIN users u ON u.id = c.user_id
            WHERE u.email_key = $1 AND c.expires_at > now()
            FOR UPDATE OF c`,
          [emailKey(request.body.email)],
        );
        const row = rows[0];
        if (row === undefined) return { failed: "no code asked for" } as const;
        const codeId = readText(row, "code_id");
        const matches =
          digits !== undefined &&
          timingSafeEqual(
            Buffer.from(codeHash(digits), "hex"),
            Buffer.from(readText(row, "code_hash"), "hex"),
          );
        if (!matches) {
          await (readNumber(row, "tries") + 1 >= codeTries
            ? tx.query("DELETE FROM sign_in_codes WHERE id = $1", [codeId])
            : tx.query("UPDATE sign_in_codes SET tries = tries + 1 WHERE id = $1", [codeId]));
          return { failed: "wrong code", userId: readText(row, "id") } as const;
        }
        await tx.query("DELETE FROM sign_in_codes WHERE id = $1", [codeId]);
        const id = readText(row, "id");
        let session: NewSession;
        try {
          session = await startSession(tx, id, request, { method: "code", events, guards });
        } catch (error) {
          // Spent, as any try is: the account is deactivated, or signs in through a provider now.
          if (error instanceof SignInRefused) return { failed: error.refusal.reason, userId: id };
          throw error;
        }
        return {
          ...session,
          user: {
            id,
            name: readText(row, "name"),
            email: readText(row, "email"),
            instanceAdmin: readBoolean(row, "instance_admin"),
          },
        };
      });
      if ("failed" in outcome) {
        await events.attempt(
          db,
          {
            action: "session.signed_in",
            outcome: "failure",
            reason: outcome.failed,
            actor:
              "userId" in outcome
                ? accountActor(outcome.userId)
                : { kind: "anonymous", email: request.body.email.slice(0, 320) },
            details: { method: "code" },
          },
          originOf(request),
          request.log,
        );
        return required === undefined
          ? fail(reply, 401, wrongCode)
          : useProvider(reply, request.body.email, required);
      }
      return reply.code(201).send(outcome);
    },
  );
}

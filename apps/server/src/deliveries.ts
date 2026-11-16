// Webhooks' deliveries (ADR 0060): each event a signed POST to its
// webhook's address, one at a time to a webhook, the oldest due first,
// while webhooks are sent to in parallel. A failed one is tried again after
// a minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and a day,
// each a little early or late, then dropped. A webhook failing for three
// days with no success between is turned off, its waiting events dropped,
// and its maker emailed. Every node runs this: a node takes a webhook for a
// minute at a time, so one node sends to it.
import { type Database, readCount, readText } from "./db.ts";
import type { Mailer } from "./mail.ts";
import { type Outcome, type SendOptions, post, signature } from "./outbound.ts";
import { fanOut } from "./outbox.ts";

/** Seconds before each try again, after the first try and each after it. */
export const retryDelays: readonly number[] = [60, 300, 1800, 7200, 21_600, 43_200, 86_400];

/** The most tries an event gets: the first, and one after each delay. */
export const maxAttempts = retryDelays.length + 1;

/** Days a webhook may fail with no success before it is turned off. */
export const failingDays = 3;

/** How many events a webhook gets in one round, before others' turn. */
const perRound = 20;

export interface DeliveryOptions extends SendOptions {
  /** What tells a webhook's maker it was turned off, when the server sends email. */
  readonly mailer?: Mailer;
  readonly log?: { warn(details: object, message: string): void };
  /** A number from 0 to 1, as Math.random gives, for the retries' spread. */
  readonly random?: () => number;
}

/** Seconds before an event's next try, after `attempts` tries: the delay, a tenth either way. */
export function retryDelay(attempts: number, random: () => number = Math.random): number {
  const delay = retryDelays[Math.min(attempts, retryDelays.length) - 1] ?? retryDelays[0] ?? 60;
  return Math.round(delay * (0.9 + random() * 0.2));
}

interface Claimed {
  readonly id: string;
  readonly workspace: string;
  readonly maker: string;
  readonly url: string;
  readonly secret: string;
}

/** Turns a webhook off: its waiting events are dropped, and its maker told, if email goes out. */
async function turnOff(
  db: Database,
  hook: Claimed,
  error: string,
  options: DeliveryOptions,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("UPDATE webhooks SET enabled = false WHERE id = $1", [hook.id]);
    await tx.query(
      `UPDATE webhook_deliveries SET status = 'failed', next_at = NULL, finished_at = now(),
              error = 'The webhook was turned off.'
        WHERE webhook_id = $1 AND status = 'waiting'`,
      [hook.id],
    );
  });
  options.log?.warn({ webhook: hook.id, error }, "Turned off a webhook failing for three days");
  if (options.mailer === undefined) return;
  const { rows } = await db.query(
    `SELECT u.email, u.name, w.name AS workspace
       FROM users u, workspaces w WHERE u.id = $1 AND w.id = $2`,
    [hook.maker, hook.workspace],
  );
  const row = rows[0];
  if (row === undefined) return;
  await options.mailer
    .send({
      to: readText(row, "email"),
      subject: "A Nether webhook was turned off",
      text: [
        `Hello ${readText(row, "name")},`,
        "",
        `Nether turned off the webhook you made in ${readText(row, "workspace")}, to`,
        hook.url,
        `as nothing sent to it has arrived for ${String(failingDays)} days. The last try said:`,
        error,
        "",
        "Turn it on again once the address answers; it then starts afresh.",
      ].join("\n"),
    })
    .catch((mailError: unknown) => {
      options.log?.warn({ err: mailError }, "Could not email that a webhook was turned off");
    });
}

/**
 * Records a try: a delivery sent, or one to try again later or drop; gives
 * whether the webhook was turned off by it.
 */
async function record(
  db: Database,
  hook: Claimed,
  delivery: string,
  attempts: number,
  outcome: Outcome,
  options: DeliveryOptions,
): Promise<boolean> {
  if (outcome.ok) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'sent', attempts = $2, answer = $3, error = NULL,
              next_at = NULL, finished_at = now() WHERE id = $1`,
      [delivery, attempts, outcome.status],
    );
    await db.query("UPDATE webhooks SET failing_since = NULL, last_error = NULL WHERE id = $1", [
      hook.id,
    ]);
    return false;
  }
  const last = attempts >= maxAttempts;
  await db.query(
    `UPDATE webhook_deliveries SET attempts = $2, answer = $3, error = $4,
            status = CASE WHEN $5::boolean THEN 'failed' ELSE 'waiting' END,
            next_at = CASE WHEN $5::boolean THEN NULL ELSE now() + $6::integer * interval '1 second' END,
            finished_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
      WHERE id = $1`,
    [
      delivery,
      attempts,
      outcome.status ?? null,
      outcome.error,
      last,
      last ? 0 : retryDelay(attempts, options.random),
    ],
  );
  const { rows } = await db.query(
    `UPDATE webhooks SET failing_since = COALESCE(failing_since, now()), last_error = $2
      WHERE id = $1
      RETURNING failing_since < now() - $3::integer * interval '1 day' AS stale`,
    [hook.id, outcome.error, failingDays],
  );
  if (rows[0]?.stale !== true) return false;
  await turnOff(db, hook, outcome.error, options);
  return true;
}

/** Sends a webhook its due events, oldest first, one at a time; gives how many it tried. */
async function sendTo(db: Database, hook: Claimed, options: DeliveryOptions): Promise<number> {
  let tried = 0;
  try {
    while (tried < perRound) {
      const { rows } = await db.query(
        `SELECT id, body, attempts FROM webhook_deliveries
          WHERE webhook_id = $1 AND status = 'waiting' AND next_at <= now()
          ORDER BY next_at, created_at LIMIT 1`,
        [hook.id],
      );
      const row = rows[0];
      if (row === undefined) break;
      // Kept for a minute more, longer than a try takes.
      await db.query(
        "UPDATE webhooks SET sending_until = now() + interval '1 minute' WHERE id = $1",
        [hook.id],
      );
      const id = readText(row, "id");
      const body = readText(row, "body");
      const timestamp = Math.floor(Date.now() / 1000);
      const outcome = await post(
        hook.url,
        {
          "user-agent": "Nether webhooks",
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature(hook.secret, id, timestamp, body),
        },
        body,
        options,
      );
      tried += 1;
      if (await record(db, hook, id, readCount(row, "attempts") + 1, outcome, options)) break;
    }
  } finally {
    await db.query("UPDATE webhooks SET sending_until = NULL WHERE id = $1", [hook.id]);
  }
  return tried;
}

/**
 * Sends what is due: each webhook that is on and has a due event, taken
 * for a minute by this node, gets its events one at a time, in parallel
 * with the others. Gives how many it tried.
 */
export async function sendDue(db: Database, options: DeliveryOptions): Promise<number> {
  const { rows } = await db.query(
    `UPDATE webhooks SET sending_until = now() + interval '1 minute'
      WHERE id IN (
        SELECT w.id FROM webhooks w
         WHERE w.enabled AND (w.sending_until IS NULL OR w.sending_until < now())
           AND EXISTS (SELECT 1 FROM webhook_deliveries d
                        WHERE d.webhook_id = w.id AND d.status = 'waiting' AND d.next_at <= now())
         LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING id, workspace_id, maker_id, url, secret`,
  );
  const tried = await Promise.all(
    rows.map((row) =>
      sendTo(
        db,
        {
          id: readText(row, "id"),
          workspace: readText(row, "workspace_id"),
          maker: readText(row, "maker_id"),
          url: readText(row, "url"),
          secret: readText(row, "secret"),
        },
        options,
      ),
    ),
  );
  return tried.reduce((sum, count) => sum + count, 0);
}

/** Deletes the deliveries finished more than seven days ago. */
export async function purgeDeliveries(db: Database): Promise<void> {
  await db.query(
    `DELETE FROM webhook_deliveries
      WHERE status <> 'waiting' AND finished_at < now() - interval '7 days'`,
  );
}

/**
 * The webhooks' worker: every few seconds, the changes due become events,
 * then the events due are sent. A round does not start while the last runs.
 */
export function startWebhooks(
  db: Database,
  options: DeliveryOptions,
  every = 5000,
): { readonly round: () => Promise<void>; stop(): Promise<void> } {
  let running: Promise<void> | undefined;
  const round = (): Promise<void> => {
    running ??= (async () => {
      try {
        await fanOut(db);
        await sendDue(db, options);
      } catch (error) {
        options.log?.warn({ err: error }, "Could not send webhooks' events");
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const timer = setInterval(() => void round(), every);
  timer.unref();
  return {
    round,
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}

// The admin console's pages beyond its features' switches (ADR 0079): the
// `admin` enterprise feature. First the server's usage, counted from its
// database when asked; its workspaces and security settings come next.
// The Features page is the server's own, in every build.
import { serverVersion } from "@nether/server/src/app.ts";
import type { Database } from "@nether/server/src/db.ts";
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { signedIn } from "@nether/server/src/sessions.ts";

/** What the server holds, as the console's Usage page shows it. */
export interface Usage {
  readonly version: string;
  readonly accounts: number;
  /** Accounts with a session used in the last 30 days. */
  readonly activeAccounts: number;
  readonly workspaces: number;
  readonly encryptedWorkspaces: number;
  /** Notes in workspaces the server can read: an encrypted workspace's are not counted. */
  readonly notes: number;
  readonly attachments: number;
  readonly attachmentBytes: number;
}

/** A count from a query's one row, as PostgreSQL gives a bigint: in text. */
async function count(db: Database, sql: string): Promise<number> {
  const { rows } = await db.query(sql);
  return Number(rows[0]?.count ?? 0);
}

/** The server's usage now, counted from its database. */
export async function usage(db: Database): Promise<Usage> {
  const [
    accounts,
    activeAccounts,
    workspaces,
    encryptedWorkspaces,
    notes,
    attachments,
    attachmentBytes,
  ] = await Promise.all([
    count(db, "SELECT count(*) FROM users"),
    count(
      db,
      "SELECT count(DISTINCT user_id) FROM sessions WHERE used_at > now() - interval '30 days'",
    ),
    count(db, "SELECT count(*) FROM workspaces"),
    count(db, "SELECT count(*) FROM workspaces WHERE encryption = 'end-to-end'"),
    // A note's document is named by its ID: the vaults' documents and the
    // notes' comments are not notes.
    count(
      db,
      String.raw`SELECT count(*) FROM documents WHERE name !~ '^vault' AND name !~ '\.comments$'`,
    ),
    count(db, "SELECT count(*) FROM attachments"),
    count(db, "SELECT coalesce(sum(size), 0) AS count FROM attachments"),
  ]);
  return {
    version: serverVersion(),
    accounts,
    activeAccounts,
    workspaces,
    encryptedWorkspaces,
    notes,
    attachments,
    attachmentBytes,
  };
}

/** The `admin` feature's module: its routes answer only while it is on, and to instance admins. */
export const adminModule: EnterpriseModule = {
  feature: "admin",
  plugin: (app, { db, whenOn }) => {
    app.get(
      "/api/admin/usage",
      { preHandler: [whenOn, signedIn(db), instanceAdmin("see the server's usage")] },
      () => usage(db),
    );
    return Promise.resolve();
  },
};

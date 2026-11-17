// Numbers in commit order (ADR 0082). A workspace's documents and
// encrypted updates are numbered from one sequence each time they are
// stored, and a client asks for what came after the last number it saw.
// Drawn plainly, two stores on two connections could commit out of order,
// and a reader could see 11 while 10 was still committing, and read past
// it (#177). So a store draws its numbers under a lock for its workspace,
// held until it commits: the next store of that workspace waits for it,
// and a reader that sees a number sees every smaller one of that
// workspace.
//
// The lock is the last lock a transaction takes: its row locks come
// before it and none after, so two transactions cannot wait on each other
// across it. After it come only the statements that draw its numbers.
import type { Queryable } from "./db.ts";

/**
 * Takes the lock a workspace's stores draw their numbers under, until the
 * transaction ends. A 64-bit hash of the workspace's ID is its key: two
 * workspaces whose keys collide only take turns.
 */
export async function lockNumbers(tx: Queryable, workspaceId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('nether.seq.' || $1, 0))", [
    workspaceId,
  ]);
}

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Dark protocol primitive, NOT an assertion that every lifecycle writer opts in.
// Participating callers must take this company fence before ANY graph/tree/gate
// reads or row locks, on their owning transaction. Acquiring it after a row lock
// can invert another writer's order. Never substitute a session advisory lock.
// Company granularity intentionally avoids multi-issue/cyclic lock ordering;
// hash collisions only serialize unrelated companies, never weaken exclusion.
export async function acquireIssueLifecycleFenceInTransaction(
  tx: Transaction,
  companyId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:issue-lifecycle:${companyId}`}, 0))`);
}

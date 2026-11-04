import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { companies, type Db } from "@paperclipai/db";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { withBudgetSpan } from "./budget-tracing.js";

const heldCompanyLocks = new AsyncLocalStorage<ReadonlyMap<string, { tx: Db; publications: ActivityPublication[] }>>();
const companyQueues = new Map<string, Promise<void>>();
const companyQueueDepths = new Map<string, number>();

export function accountingTransactionQueueDepth(companyId: string): number {
  return companyQueueDepths.get(companyId) ?? 0;
}

async function executeAccountingTransaction<T>(
  db: Db,
  companyId: string,
  work: (tx: Db, publications: ActivityPublication[]) => Promise<T>,
  held: ReadonlyMap<string, { tx: Db; publications: ActivityPublication[] }>,
  parentPublications?: ActivityPublication[],
  onTransactionComplete?: () => void,
): Promise<T> {
  const localPublications: ActivityPublication[] = [];
  const result = await withBudgetSpan("budget.accounting.transaction", () => db.transaction(async (transaction) => {
    try {
      const tx = transaction as unknown as Db;
      const [company] = await withBudgetSpan("budget.accounting.lock_wait", () => tx.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, companyId)).for("no key update"));
      if (!company) throw notFound("Company not found");
      const nextHeld = new Map(held);
      nextHeld.set(companyId, { tx, publications: localPublications });
      return await heldCompanyLocks.run(nextHeld, () => work(tx, localPublications));
    } finally {
      onTransactionComplete?.();
    }
  }));
  if (parentPublications) {
    parentPublications.push(...localPublications);
  } else {
    publishAccountingActivities(companyId, localPublications);
  }
  return result;
}

export async function withAccountingTransaction<T>(db: Db, companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T> {
  const isTx = db instanceof PgTransaction || Boolean((db as any)?.isTransaction);
  const held = heldCompanyLocks.getStore() ?? new Map<string, { tx: Db; publications: ActivityPublication[] }>();
  const activeContext = held.get(companyId);

  if (activeContext || isTx) {
    const targetDb = activeContext?.tx ?? db;
    const targetPublications = activeContext?.publications;
    return executeAccountingTransaction(targetDb, companyId, work, held, targetPublications);
  }

  const previous = companyQueues.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => turn);
  companyQueues.set(companyId, current);
  companyQueueDepths.set(companyId, (companyQueueDepths.get(companyId) ?? 0) + 1);

  let turnReleased = false;
  const releaseTurn = () => {
    if (turnReleased) return;
    turnReleased = true;
    release();
    const remaining = (companyQueueDepths.get(companyId) ?? 1) - 1;
    if (remaining <= 0) companyQueueDepths.delete(companyId);
    else companyQueueDepths.set(companyId, remaining);
    if (companyQueues.get(companyId) === current) {
      companyQueues.delete(companyId);
    }
  };

  try {
    await previous.catch(() => {});
    return await executeAccountingTransaction(db, companyId, work, held, undefined, releaseTurn);
  } finally {
    releaseTurn();
  }
}

/** Consistent operator reports must not wait for or delay accounting writers.
 * Reads see one committed snapshot; repairs still revalidate under the lock. */
export function withAccountingReadSnapshot<T>(db: Db, companyId: string, work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!company) throw notFound("Company not found");
    return work(tx);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Database history is durable even when the live subscriber channel fails. */
export function publishAccountingActivities(companyId: string, publications: ActivityPublication[]) {
  for (const publication of publications) {
    try { publishActivity(publication); }
    catch (error) { logger.warn({ err: error, companyId }, "Accounting committed; live activity publication failed"); }
  }
}

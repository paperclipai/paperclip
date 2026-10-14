import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

/** Serialize ledger and budget mutations in one company. Always acquire this
 * before locking a run or a policy, so concurrent writers use one lock order.
 * NO KEY UPDATE permits FK KEY SHARE locks held by recovery callers. */
export async function withAccountingTransaction<T>(db: Db, companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T> {
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).for("no key update");
    if (!company) throw notFound("Company not found");
    return work(tx, publications);
  });
  publishAccountingActivities(companyId, publications);
  return result;
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

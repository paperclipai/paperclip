import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { withBudgetSpan } from "./budget-tracing.js";

/** Serialize ledger and budget mutations in one company. Always acquire this
 * before locking a run or a policy, so concurrent writers use one lock order.
 * NO KEY UPDATE permits FK KEY SHARE locks held by recovery callers. */
export async function withAccountingTransaction<T>(db: Db, companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T> {
  const publications: ActivityPublication[] = [];
  const result = await withBudgetSpan("budget.accounting.transaction", () => db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [company] = await withBudgetSpan("budget.accounting.lock_wait", () => tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).for("no key update"));
    if (!company) throw notFound("Company not found");
    return work(tx, publications);
  }));
  publishAccountingActivities(companyId, publications);
  return result;
}

/** Independent paid operations share a consistent snapshot, never a company
 * writer mutex. Only retry transactions PostgreSQL proves were rolled back;
 * an uncertain commit must be replayed by its durable operation identity.
 * A writer whose mutable reads are protected by an aggregate row lock can use
 * READ COMMITTED, so unrelated updates before that lock do not invalidate its
 * snapshot. Multi-aggregate readers keep the default consistent snapshot. */
export async function withOperationAccountingTransaction<T>(db: Db, companyId: string,
  work: (tx: Db, publications: ActivityPublication[]) => Promise<T>,
  options: { isolationLevel?: "read committed" } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const publications: ActivityPublication[] = [];
    try {
      const result = await withBudgetSpan("budget.accounting.transaction", () => db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
        if (!company) throw notFound("Company not found");
        return work(tx, publications);
      }, { isolationLevel: options.isolationLevel ?? "repeatable read" }));
      publishAccountingActivities(companyId, publications);
      return result;
    } catch (error) {
      if (!isAccountingRetryable(error)) throw error;
      if (attempt >= 3) {
        const contention = new AccountingContentionError(error, attempt + 1);
        logger.warn({ companyId, sqlState: contention.code, attempts: contention.attempts, err: error },
          "Accounting transaction exhausted its serialization retries");
        throw contention;
      }
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export const ACCOUNTING_CONTENTION_MESSAGE = "Paperclip could not save this run's budget or usage records because other "
  + "updates to the same run kept conflicting with them. Retry the run.";

/** Bounded, SQL-free failure for exhausted serialization retries. `code`
 * keeps the SQLSTATE (40001 or 40P01) for retry classifiers and diagnostics;
 * the database error, with its statement text, stays only in `cause`. */
export class AccountingContentionError extends HttpError {
  readonly code: string;
  constructor(cause: unknown, readonly attempts: number) {
    super(503, ACCOUNTING_CONTENTION_MESSAGE);
    this.name = "AccountingContentionError";
    this.code = accountingRetryCode(cause) ?? "40001";
    this.cause = cause;
  }
}

export function isAccountingContentionError(error: unknown): error is AccountingContentionError {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    if (current instanceof AccountingContentionError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function accountingRetryCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const row = current as { code?: string; cause?: unknown };
    if (row.code === "40001" || row.code === "40P01") return row.code;
    current = row.cause;
  }
  return null;
}

export function isAccountingRetryable(error: unknown): boolean {
  return accountingRetryCode(error) !== null;
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

import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { companies, type Db } from "@paperclipai/db";
import { publishActivity, type ActivityPublication } from "./activity-log.js";
import { HttpError, notFound } from "../errors.js";
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
): Promise<T> {
  const localPublications: ActivityPublication[] = [];
  const result = await withBudgetSpan("budget.accounting.transaction", () => db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [company] = await withBudgetSpan("budget.accounting.lock_wait", () => tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).for("no key update"));
    if (!company) throw notFound("Company not found");
    const nextHeld = new Map(held);
    nextHeld.set(companyId, { tx, publications: localPublications });
    return await heldCompanyLocks.run(nextHeld, () => work(tx, localPublications));
  }));
  if (parentPublications) {
    parentPublications.push(...localPublications);
  } else {
    publishAccountingActivities(companyId, localPublications);
  }
  return result;
}

/** Serialize ledger and budget mutations in one company. Always acquire this
 * before locking a run or a policy, so concurrent writers use one lock order.
 * NO KEY UPDATE permits FK KEY SHARE locks held by recovery callers. */
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
  const current = previous.then(() => turn);
  companyQueues.set(companyId, current);
  companyQueueDepths.set(companyId, (companyQueueDepths.get(companyId) ?? 0) + 1);

  try {
    await previous;
    return await executeAccountingTransaction(db, companyId, work, held);
  } finally {
    release();
    const remaining = (companyQueueDepths.get(companyId) ?? 1) - 1;
    if (remaining <= 0) companyQueueDepths.delete(companyId);
    else companyQueueDepths.set(companyId, remaining);
    if (companyQueues.get(companyId) === current) {
      companyQueues.delete(companyId);
    }
  }
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
      if (attempt + 1 >= ACCOUNTING_TRANSACTION_ATTEMPTS) {
        const contention = new AccountingContentionError(error, attempt + 1);
        logger.warn({ companyId, sqlState: contention.code, attempts: contention.attempts, err: error },
          "Accounting transaction exhausted its serialization retries");
        throw contention;
      }
      await new Promise(resolve => setTimeout(resolve, accountingRetryDelayMs(attempt)));
    }
  }
}

export const ACCOUNTING_TRANSACTION_ATTEMPTS = 8;

const ACCOUNTING_RETRY_BASE_DELAY_MS = 10;
const ACCOUNTING_RETRY_MAX_DELAY_MS = 400;

export function accountingRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(ACCOUNTING_RETRY_MAX_DELAY_MS, ACCOUNTING_RETRY_BASE_DELAY_MS * 2 ** (attempt + 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export const ACCOUNTING_CONTENTION_MESSAGE = "Paperclip could not save this run's budget or usage records because other "
  + "updates to the same run kept conflicting with them. Retry the run.";

export const ACCOUNTING_WRITE_CONTENTION_MESSAGE = "Paperclip could not save these budget or usage changes because other "
  + "updates to the same company kept conflicting with them. Try again.";

/** Bounded, SQL-free failure for exhausted serialization retries. `code`
 * keeps the SQLSTATE (40001 or 40P01) for retry classifiers and diagnostics;
 * the database error, with its statement text, stays only in `cause`. */
export class AccountingContentionError extends HttpError {
  readonly code: string;
  constructor(cause: unknown, readonly attempts: number) {
    super(503, ACCOUNTING_WRITE_CONTENTION_MESSAGE);
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

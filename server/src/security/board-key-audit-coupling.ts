import { AsyncLocalStorage } from "node:async_hooks";
import { boardApiKeyAuthorizationEvents, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Board-key allow dispositions must be atomic with the mutation they authorize.
 *
 * The central gate runs as request middleware, so it cannot see the transaction
 * a controller will open later. Writing the allow row in the middleware leaves
 * an `authorized` record behind whenever the controller rolls back or the
 * process dies mid-request, and gives a committed mutation no durable
 * disposition when the audit insert itself fails after the mutation.
 *
 * Instead the gate *stages* the allow disposition in a request-scoped context
 * and the instrumented database handle flushes it into the first transaction
 * that performs a domain mutation. From that point the disposition and the
 * mutation share one transaction: they commit together or roll back together.
 *
 * Denials are unaffected — they abort the request, so there is no mutation to
 * couple them to and they stay immediately durable.
 */

export type BoardKeyAuditValues = typeof boardApiKeyAuthorizationEvents.$inferInsert;

/**
 * Fixed allowlist for the `details.coupling` audit field. The value records how
 * the durable allow disposition was tied to the request's effects so incident
 * reconstruction can tell an atomic record from a degraded one.
 */
export const BOARD_KEY_AUDIT_COUPLINGS = {
  /** Written inside the same transaction as the first domain mutation. */
  transaction: "transaction",
  /** The authorized request completed without mutating anything. */
  noMutation: "no_mutation",
  /** A mutation ran outside any transaction, so it could not be coupled. */
  untransacted: "untransacted",
  /** No request context was active (direct gate invocation, not a live route). */
  detached: "detached",
} as const;

export type BoardKeyAuditCoupling =
  (typeof BOARD_KEY_AUDIT_COUPLINGS)[keyof typeof BOARD_KEY_AUDIT_COUPLINGS];

export type BoardKeyAuditContext = {
  /** Allow disposition awaiting a domain transaction to commit with. */
  pending: BoardKeyAuditValues | null;
  /** True once the staged disposition committed inside a domain transaction. */
  flushed: boolean;
  /** A domain mutation was issued at least once during this request. */
  mutationAttempted: boolean;
  /** A domain mutation was issued outside any transaction. */
  untransacted: boolean;
  /** Settlement already ran; further mutation marks are gate-owned writes. */
  settled: boolean;
};

const store = new AsyncLocalStorage<BoardKeyAuditContext>();

// Mutating entry points on both the database handle and a transaction client.
// `execute` covers raw SQL, which is also how several services mutate.
const MUTATION_METHODS = ["insert", "update", "delete", "execute"] as const;
const INSTRUMENTED = Symbol.for("paperclip.boardKeyAuditInstrumented");

// Raw SQL is the one entry point that can be read-only, so classify it instead
// of reporting every `execute` as a mutation. Anything unrecognised counts as a
// mutation: over-reporting keeps a disposition attached, under-reporting loses
// one.
const READ_ONLY_STATEMENT = /^\s*(?:select|show|explain|table|values)\b/i;

function rawStatementMutates(args: readonly unknown[]): boolean {
  const chunks = (args[0] as { queryChunks?: unknown[] } | null | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  let text = "";
  for (const chunk of chunks) {
    if (typeof chunk === "string") text += chunk;
    else {
      const parts = (chunk as { value?: unknown } | null)?.value;
      if (Array.isArray(parts)) text += parts.join("");
    }
    if (text.trim().length > 0) break;
  }
  return text.trim().length === 0 ? true : !READ_ONLY_STATEMENT.test(text);
}

export function createBoardKeyAuditContext(): BoardKeyAuditContext {
  return {
    pending: null,
    flushed: false,
    mutationAttempted: false,
    untransacted: false,
    settled: false,
  };
}

export function runWithBoardKeyAuditContext<T>(
  context: BoardKeyAuditContext,
  run: () => T,
): T {
  return store.run(context, run);
}

/**
 * Stage an allow disposition for transactional coupling. Returns false when no
 * request context is active, in which case the caller must fall back to an
 * immediate insert so the disposition is never silently dropped.
 */
export function stageBoardKeyAllowAudit(values: BoardKeyAuditValues): boolean {
  const context = store.getStore();
  if (!context) return false;
  context.pending = values;
  context.flushed = false;
  return true;
}

function markMutation(context: BoardKeyAuditContext | undefined, transactional: boolean) {
  // Only requests carrying an uncoupled allow disposition need tracking, and
  // gate-owned settlement writes must never count as domain mutations.
  if (!context || !context.pending || context.settled) return;
  context.mutationAttempted = true;
  if (!transactional) context.untransacted = true;
}

type MutatingClient = Record<string | symbol, unknown> & {
  transaction?: (fn: (tx: unknown) => unknown, config?: unknown) => unknown;
};

/**
 * Replace a client's mutating methods with hooked versions. The replacements are
 * non-enumerable so the client keeps the shape callers and drizzle expect.
 */
function shadowMutationMethods(
  client: object,
  onMutation: (method: string, args: readonly unknown[]) => void,
) {
  const target = client as MutatingClient;
  for (const method of MUTATION_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    const bound = (original as (...args: unknown[]) => unknown).bind(client);
    Object.defineProperty(target, method, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (...args: unknown[]) => {
        if (method !== "execute" || rawStatementMutates(args)) onMutation(method, args);
        return bound(...args);
      },
    });
  }
}

/**
 * Shadow the mutating methods of a transaction client so the staged allow
 * disposition is dispatched on the same connection immediately before the
 * first domain mutation. The client is created per transaction and discarded
 * afterwards, so in-place instrumentation stays scoped to this request.
 *
 * Nested transactions (savepoints) share the outermost client's flush, so a
 * savepoint never needs a disposition of its own. Residual: a mutation issued
 * only inside a savepoint dispatches the disposition within that savepoint, so
 * rolling the savepoint back while the outer transaction commits would drop it.
 * Nothing in the server opens nested transactions today; a caller that starts
 * doing so must flush at the outer level instead.
 */
function instrumentTransactionClient<T extends object>(
  client: T,
  onMutation: () => void,
): T {
  shadowMutationMethods(client, onMutation);
  const target = client as unknown as MutatingClient;
  const nested = target.transaction;
  if (typeof nested === "function") {
    const boundNested = nested.bind(client);
    Object.defineProperty(target, "transaction", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (fn: (tx: unknown) => unknown, config?: unknown) =>
        boundNested((inner: unknown) => fn(instrumentTransactionClient(inner as object, onMutation)), config),
    });
  }
  return client;
}

/**
 * Shadow `transaction` and the direct mutating methods on the process-wide
 * database handle. The handle object is returned unchanged (same identity, so
 * existing `dbOrTx === db` checks keep working) and every hook is inert unless
 * a board-key request has staged an allow disposition.
 */
export function instrumentDbForBoardKeyAudit<T extends Db>(db: T): T {
  const target = db as unknown as MutatingClient;
  if (target[INSTRUMENTED] === true) return db;
  Object.defineProperty(target, INSTRUMENTED, { value: true, enumerable: false });

  shadowMutationMethods(db, () => markMutation(store.getStore(), false));

  const originalTransaction = target.transaction;
  if (typeof originalTransaction === "function") {
    const boundTransaction = originalTransaction.bind(db);
    Object.defineProperty(target, "transaction", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (fn: (tx: unknown) => unknown, config?: unknown) => {
        const context = store.getStore();
        const pending = context && context.pending && !context.flushed ? context.pending : null;
        if (!context || !pending) return boundTransaction(fn, config);
        return runCoupledTransaction(boundTransaction, fn, config, context, pending);
      },
    });
  }

  return db;
}

async function runCoupledTransaction(
  boundTransaction: (fn: (tx: unknown) => unknown, config?: unknown) => unknown,
  fn: (tx: unknown) => unknown,
  config: unknown,
  context: BoardKeyAuditContext,
  pending: BoardKeyAuditValues,
) {
  let flush: Promise<unknown> | null = null;
  const result = await boundTransaction(async (tx: unknown) => {
    // Captured before instrumentation so the audit insert does not re-enter the
    // mutation hook it is triggered from.
    const rawInsert = (tx as {
      insert: (table: unknown) => {
        values: (values: unknown) => { execute?: () => Promise<unknown> } & PromiseLike<unknown>;
      };
    }).insert.bind(tx);
    const instrumented = instrumentTransactionClient(tx as object, () => {
      markMutation(context, true);
      if (flush) return;
      const query = rawInsert(boardApiKeyAuthorizationEvents).values({
        ...pending,
        details: { ...(pending.details ?? {}), coupling: BOARD_KEY_AUDIT_COUPLINGS.transaction },
      });
      // Dispatched, not awaited, so the audit statement is queued on this
      // transaction's connection ahead of the mutation that triggered it.
      flush = typeof query.execute === "function" ? query.execute() : Promise.resolve(query);
      // The transaction wrapper awaits `flush` before committing; this guard
      // only keeps a rejection from surfacing as an unhandled rejection first.
      flush.catch(() => {});
    });
    const value = await fn(instrumented);
    // A failed audit insert aborts the transaction, so the mutation cannot
    // commit without its disposition.
    if (flush) await flush;
    return value;
  }, config);
  if (flush) context.flushed = true;
  return result;
}

/**
 * Resolve the request's allow disposition once the response is complete.
 *
 * Nothing is written when a transactional mutation rolled back or the request
 * failed: there is no committed effect to attest, and a durable `allow` in that
 * situation is exactly the false association this coupling exists to prevent. A
 * durable allow therefore means "this mutation was authorized and committed";
 * denials remain logged in full regardless of outcome.
 */
export async function settleBoardKeyAuditContext(
  db: Db,
  context: BoardKeyAuditContext,
  statusCode: number,
): Promise<void> {
  if (context.settled) return;
  context.settled = true;
  const pending = context.pending;
  if (!pending || context.flushed) return;

  const succeeded = statusCode >= 200 && statusCode < 400;
  if (!succeeded) return;
  if (context.mutationAttempted && !context.untransacted) return;

  const coupling = context.untransacted
    ? BOARD_KEY_AUDIT_COUPLINGS.untransacted
    : BOARD_KEY_AUDIT_COUPLINGS.noMutation;
  if (context.untransacted) {
    logger.error(
      { boardApiKeyId: pending.boardApiKeyId, action: pending.action },
      "Board-key mutation ran outside a transaction; allow disposition could not be coupled atomically",
    );
  }
  try {
    await db.insert(boardApiKeyAuthorizationEvents).values({
      ...pending,
      details: { ...(pending.details ?? {}), coupling },
    });
  } catch (err) {
    logger.error(
      { err, boardApiKeyId: pending.boardApiKeyId, action: pending.action },
      "Failed to persist settled board-key allow disposition",
    );
  }
}

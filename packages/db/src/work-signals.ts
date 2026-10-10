import { sql } from "drizzle-orm";

// Process-local hints about existing durable queues. No SQL triggers, tables,
// background timers, or driver query replay. Only opted-in transactions fetch
// an XID, so unrelated transactions keep their existing SQL behavior.
type Listener = (event: "intent" | "settled") => void;
type Transaction = { topics: Set<string>; xid?: Promise<string>; uncertain: boolean };
type Scope = { listeners: Map<string, Set<Listener>>; transactions: Set<Transaction>; root: Connection };
type Context = { scope: Scope; transaction?: Transaction };
type Connection = { transaction: (...args: any[]) => Promise<any>; execute: (...args: any[]) => Promise<any> };
const contexts = new WeakMap<object, Context>();

function publish(scope: Scope, topic: string, event: "intent" | "settled" = "settled") {
  for (const listener of scope.listeners.get(topic) ?? []) {
    try { listener(event); }
    catch (error) { process.emitWarning(`Database work listener failed: ${String(error)}`); }
  }
}

/** Installed once by createDb; dedicated child pools share their owner's scope. */
export function installDatabaseWorkSignals<T extends Connection>(db: T, owner?: object): T {
  const scope = (owner && contexts.get(owner)?.scope) || { listeners: new Map(), transactions: new Set(), root: db };
  install(db, { scope });
  return db;
}

function install(connection: Connection, context: Context) {
  contexts.set(connection, context);
  const transaction = connection.transaction;
  connection.transaction = async function (callback, ...options) {
    // Nested savepoints belong to the outermost transaction. Even a released
    // savepoint must not wake a consumer before its parent commits.
    const state = context.transaction ?? { topics: new Set<string>(), uncertain: false };
    try {
      const result = await transaction.call(this, async (tx: Connection) => {
        install(tx, { scope: context.scope, transaction: state });
        return callback(tx);
      }, ...options);
      if (!context.transaction) context.scope.transactions.delete(state);
      return result;
    } catch (error) {
      if (!context.transaction) {
        // An XID is known before the first opted-in write can execute. If
        // acquisition itself failed there cannot be a corresponding write.
        if (state.xid) state.uncertain = true;
        else context.scope.transactions.delete(state);
      }
      throw error;
    } finally {
      if (!context.transaction) for (const topic of state.topics) publish(context.scope, topic);
    }
  };
}

/** Await BEFORE the queue write, on its transaction. Nested transactions work. */
export async function signalDatabaseWork(connection: object, topic: string): Promise<void> {
  const context = contexts.get(connection);
  if (!context) return; // Lightweight service test doubles have no DB lifecycle.
  const state = context.transaction;
  if (!state) throw new Error("Database work must be registered inside a transaction");
  state.topics.add(topic);
  context.scope.transactions.add(state);
  publish(context.scope, topic, "intent");
  if (!state.xid) {
    state.xid = (connection as Connection).execute(sql`select pg_current_xact_id()::text as xid`)
      .then((rows: { xid: string }[]) => rows[0]!.xid);
  }
  // Keep a failed acquisition distinguishable from an uncertain queue write.
  try { await state.xid; }
  catch (error) { state.xid = undefined; throw error; }
}

export function databaseWorkPending(owner: object, topic: string): boolean {
  return [...(contexts.get(owner)?.scope.transactions ?? [])].some(state => state.topics.has(topic));
}

/** Resolve only failed transactions, on a fresh root-pool statement. Call
 * BEFORE the queue scan so rows from a newly confirmed commit are visible.
 * NULL means the XID aged out; it can no longer be in progress, so scanning
 * the durable queue is sufficient even though its outcome is unavailable.
 */
export async function reconcileDatabaseWork(owner: object, topic: string): Promise<void> {
  const scope = contexts.get(owner)?.scope;
  if (!scope) return;
  for (const state of [...scope.transactions]) {
    if (!state.uncertain || !state.topics.has(topic) || !state.xid) continue;
    const xid = await state.xid;
    const rows = await scope.root.execute(sql`select pg_xact_status(${xid}::xid8) as status`);
    if (rows[0]?.status === "in progress") continue;
    if (!rows.length || ![null, "committed", "aborted"].includes(rows[0].status)) {
      throw new Error("Unexpected database transaction status");
    }
    scope.transactions.delete(state);
    for (const affected of state.topics) publish(scope, affected);
  }
}

/** Includes intent, outer settlement, and uncertainty-resolution changes. */
export function subscribeDatabaseWork(owner: object, topic: string, listener: Listener): () => void {
  const context = contexts.get(owner);
  if (!context) throw new Error("Database work subscriptions require createDb");
  let listeners = context.scope.listeners.get(topic);
  if (!listeners) context.scope.listeners.set(topic, listeners = new Set());
  listeners.add(listener);
  if (databaseWorkPending(owner, topic)) {
    try { listener("intent"); } catch (error) { process.emitWarning(`Database work listener failed: ${String(error)}`); }
  }
  return () => { listeners.delete(listener); };
}

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { workSignalDebug } from "./work-signal-debug.js";

// Hints about existing durable queues; process-local by default, with optional
// commit-bound PostgreSQL notifications during controller replacement. No SQL
// triggers, tables, timers, or query replay. Only registered work fetches an XID.
type Listener = (event: "intent" | "settled", hints?: ReadonlySet<string>) => void;
type Transaction = { topics: Set<string>; hints: Map<string, Set<string>>; xid?: Promise<string>; uncertain: boolean };
type Scope = { key: object; listeners: Map<string, Set<Listener>>; transactions: Set<Transaction>; root: Connection; notificationOrigin: string; notify: boolean };
type PendingNotification = { hints: Set<string>; unscoped: boolean };
type Context = { scope: Scope; transaction?: Transaction; pending?: Map<string, PendingNotification>; settled?: Array<[string, string | undefined]>; ended?: boolean };
type Connection = { transaction: (...args: any[]) => Promise<any>; execute: (...args: any[]) => Promise<any> };
const contexts = new WeakMap<object, Context>();

function publish(scope: Scope, topic: string, event: "intent" | "settled" = "settled", hints?: ReadonlySet<string>) {
  for (const listener of scope.listeners.get(topic) ?? []) {
    try { listener(event, hints); }
    catch (error) { process.emitWarning(`Database work listener failed: ${String(error)}`); }
  }
}

/** Installed once by createDb; dedicated child pools share their owner's scope. */
export function installDatabaseWorkSignals<T extends Connection>(db: T, owner?: object): T {
  const scope = (owner && contexts.get(owner)?.scope) || { key: {}, listeners: new Map(), transactions: new Set(), root: db, notificationOrigin: randomUUID(), notify: false };
  install(db, { scope });
  return db;
}

function install(connection: Connection, context: Context) {
  contexts.set(connection, context);
  const transaction = connection.transaction;
  connection.transaction = async function (callback, ...options) {
    // Nested savepoints belong to the outermost transaction. Even a released
    // savepoint must not wake a consumer before its parent commits.
    const state = context.transaction ?? { topics: new Set<string>(), hints: new Map<string, Set<string>>(), uncertain: false };
    try {
      let level: Context | undefined;
      const result = await transaction.call(this, async (tx: Connection) => {
        const current: Context = { scope: context.scope, transaction: state, pending: new Map(), settled: [] };
        level = current;
        install(tx, current);
        try {
          const value = await callback(tx);
          current.ended = true;
          if (!context.transaction) await flushNotifications(tx, context.scope, current.pending!);
          return value;
        } finally { current.ended = true; }
      }, ...options);
      if (context.pending && level?.pending) {
        for (const [topic, notification] of level.pending) mergeNotification(context.pending, topic, notification);
      }
      if (context.transaction) context.settled?.push(...level?.settled ?? []);
      else for (const [topic, hint] of level?.settled ?? []) publish(context.scope, topic, "settled", hint === undefined ? undefined : new Set([hint]));
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
      if (!context.transaction) for (const topic of state.topics) publish(context.scope, topic, "settled", state.hints.get(topic));
    }
  };
}

/** Await BEFORE the queue write, on its transaction. Nested transactions work. */
export async function signalDatabaseWork(connection: object, topic: string, hint?: string): Promise<void> {
  const context = contexts.get(connection);
  if (!context) return; // Lightweight service test doubles have no DB lifecycle.
  const state = context.transaction;
  if (!state) throw new Error("Database work must be registered inside a transaction");
  if (workSignalDebug.enabled) workSignalDebug.signal(topic, hint, signalDatabaseWork);
  state.topics.add(topic);
  if (hint !== undefined) {
    let hints = state.hints.get(topic);
    if (!hints) state.hints.set(topic, hints = new Set());
    hints.add(hint);
  }
  context.scope.transactions.add(state);
  publish(context.scope, topic, "intent", state.hints.get(topic));
  if (!state.xid) {
    state.xid = (connection as Connection).execute(sql`select pg_current_xact_id()::text as xid`)
      .then((rows: { xid: string }[]) => rows[0]!.xid);
  }
  // Keep a failed acquisition distinguishable from an uncertain queue write.
  try { await state.xid; }
  catch (error) { state.xid = undefined; throw error; }
  if (context.scope.notify) notifyAtCommit(context, topic, hint ?? null);
}

export function primeDatabaseWorkTransactionId(connection: object, xid: string): void {
  const state = contexts.get(connection)?.transaction;
  if (state && !state.xid) state.xid = Promise.resolve(xid);
}

function notifyAtCommit(context: Context, topic: string, hint: string | null | undefined): void {
  if (!validTopic(topic)) throw new Error("Invalid database work topic");
  if (context.ended) throw new Error("Database work was signalled after its transaction or savepoint ended");
  let pending = context.pending!.get(topic);
  if (!pending) context.pending!.set(topic, pending = { hints: new Set(), unscoped: false });
  if (hint === undefined) pending.unscoped = true;
  else if (hint !== null) pending.hints.add(hint);
}

function mergeNotification(pending: Map<string, PendingNotification>, topic: string, notification: PendingNotification) {
  const existing = pending.get(topic);
  if (!existing) { pending.set(topic, { hints: new Set(notification.hints), unscoped: notification.unscoped }); return; }
  existing.unscoped ||= notification.unscoped;
  for (const hint of notification.hints) existing.hints.add(hint);
}

async function flushNotifications(connection: Connection, scope: Scope, pending: Map<string, PendingNotification>): Promise<void> {
  if (pending.size === 0) return;
  const payloads = [...pending].flatMap(([topic, { hints, unscoped }]) =>
    unscoped || hints.size === 0 ? [notification(scope, topic)] : hintedNotifications(scope, topic, hints));
  await connection.execute(sql`select pg_notify(${DATABASE_WORK_CHANNEL}, payload)
    from jsonb_array_elements_text(${JSON.stringify(payloads)}::jsonb) as notification(payload)`);
}

export const DATABASE_WORK_NOTIFICATION_MAX_BYTES = 1024;
export const DATABASE_WORK_TOPIC_NOTIFICATIONS_MAX_BYTES = 7000;
const MAX_RECEIVED_NOTIFICATION_LENGTH = 8000;

function hintedNotifications(scope: Scope, topic: string, hints: ReadonlySet<string>): string[] {
  const base = Buffer.byteLength(JSON.stringify({ version: 1, origin: scope.notificationOrigin, topic, hints: [] }));
  const chunks: string[][] = [];
  let chunk: string[] = [], chunkBytes = base, totalBytes = 0;
  for (const hint of hints) {
    const bytes = Buffer.byteLength(JSON.stringify(hint));
    if (chunk.length > 0 && chunkBytes + 1 + bytes > DATABASE_WORK_NOTIFICATION_MAX_BYTES) {
      chunks.push(chunk); totalBytes += chunkBytes;
      chunk = []; chunkBytes = base;
    }
    chunkBytes += chunk.length > 0 ? bytes + 1 : bytes;
    chunk.push(hint);
    if (chunkBytes > DATABASE_WORK_NOTIFICATION_MAX_BYTES || totalBytes + chunkBytes > DATABASE_WORK_TOPIC_NOTIFICATIONS_MAX_BYTES) {
      return [notification(scope, topic)];
    }
  }
  chunks.push(chunk);
  return chunks.map(list => JSON.stringify({ version: 1, origin: scope.notificationOrigin, topic, hints: list }));
}

export const DATABASE_WORK_CHANNEL = "paperclip_work_v1";
const validTopic = (topic: string) => /^[a-zA-Z0-9:_-]{1,200}$/.test(topic);
function notification(scope: Scope, topic: string) {
  if (!validTopic(topic)) throw new Error("Invalid database work topic");
  return JSON.stringify({ version: 1, origin: scope.notificationOrigin, topic });
}
export function enableDatabaseWorkNotifications(owner: object): void {
  const scope = contexts.get(owner)?.scope;
  if (!scope) throw new Error("Database work notifications require createDb");
  scope.notify = true;
}
/**
 * A commit-bound hint to other server processes, sent on the transaction's own connection. Unlike
 * signalDatabaseWork it registers no local intent, so a failed transaction leaves nothing to reconcile
 * on another pool. For writers whose correctness never depends on this hint (best-effort wakes).
 */
export async function notifyDatabaseWorkOnCommit(connection: object, topic: string): Promise<void> {
  const context = contexts.get(connection);
  if (!context?.scope.notify) return;
  if (!context.transaction) throw new Error("Database work must be registered inside a transaction");
  notifyAtCommit(context, topic, undefined);
}

export function databaseWorkCommitNotification(owner: object, topic: string): string | null {
  const scope = contexts.get(owner)?.scope;
  return scope?.notify ? notification(scope, topic) : null;
}

export function publishDatabaseWorkSettled(owner: object, topic: string, hint?: string): void {
  const context = contexts.get(owner);
  if (!context) return;
  if (workSignalDebug.enabled) workSignalDebug.event(topic, "settled_publish", { hint }, "sampled", publishDatabaseWorkSettled);
  if (!context.transaction) {
    publish(context.scope, topic, "settled", hint === undefined ? undefined : new Set([hint]));
    return;
  }
  if (context.ended) throw new Error("Database work was signalled after its transaction or savepoint ended");
  context.settled!.push([topic, hint]);
  if (context.scope.notify) notifyAtCommit(context, topic, hint);
}

/** A post-commit invalidation hint, for already-persisted live UI state. */
export async function publishDatabaseWorkHint(owner: object, topic: string): Promise<void> {
  const scope = contexts.get(owner)?.scope;
  if (scope?.notify) await scope.root.execute(sql`select pg_notify(${DATABASE_WORK_CHANNEL}, ${notification(scope, topic)})`);
}
export function receiveDatabaseWorkNotification(owner: object, payload: string): void {
  const scope = contexts.get(owner)?.scope;
  if (!scope || typeof payload !== "string" || payload.length > MAX_RECEIVED_NOTIFICATION_LENGTH) return;
  let value: { version?: unknown; origin?: unknown; topic?: unknown; hints?: unknown };
  try { value = JSON.parse(payload); } catch { return; }
  if (!value || typeof value !== "object" || typeof value.version !== "number" || !Number.isInteger(value.version)
    || value.version < 1 || typeof value.origin !== "string" || value.origin === scope.notificationOrigin
    || typeof value.topic !== "string" || !validTopic(value.topic)) return;
  const hints = value.version === 1 ? receivedHints(value.hints) : undefined;
  if (workSignalDebug.enabled) {
    workSignalDebug.event(value.topic, "remote_notification", { hints: hints ? JSON.stringify([...hints]) : null });
  }
  publish(scope, value.topic, "settled", hints);
}
function receivedHints(value: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(hint => typeof hint === "string")) return undefined;
  return new Set(value);
}
/** Reconnect can lose hints. Reconstruct existing durable queues once; no poll. */
export function reconcileDatabaseWorkNotifications(owner: object): void {
  const scope = contexts.get(owner)?.scope;
  if (scope) for (const topic of scope.listeners.keys()) {
    if (workSignalDebug.enabled) workSignalDebug.event(topic, "notification_reconnect");
    publish(scope, topic);
  }
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
    for (const affected of state.topics) {
      if (workSignalDebug.enabled) workSignalDebug.event(affected, "uncertain_settled", { status: rows[0]?.status ?? null });
      publish(scope, affected, "settled", state.hints.get(affected));
    }
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

export function databaseWorkScopeKey(connection: object): object {
  return contexts.get(connection)?.scope.key ?? connection;
}

import { notifyLiveRunRecovery } from "./live-run-recovery-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { readNativeEventEvidenceOutcome } from "./native-runtime/evidence-classifier.js";
import { notifyNativeStatusReassessment } from "./native-status-reassessment-notifications.js";
import { isNativeResponseEvidence, notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { isSafeNativeChatProgressEventType } from "./safe-native-chat-progress.js";
import { notifyChatNativeProgress } from "./chat-native-progress-notifications.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { and, asc, eq, getTableColumns, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { isUniqueViolation } from "../db-errors.js";

export const RETRY_EXHAUSTION_MESSAGE_PREFIX = "Bounded retry exhausted";

export interface AppendHeartbeatRunEventInput {
  companyId: string;
  runId: string;
  agentId: string;
  eventType: string;
  stream?: string | null;
  level?: string | null;
  color?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  /** Reuse an existing exhaustion receipt, including receipts from older builds. */
  retryExhaustion?: {
    retryReason: string;
    scheduledRetryAttempt: number;
    maxAttempts: number;
  };
  nativeSource?: {
    sourceInstanceId: string;
    sourceEventId: string;
    sourceSeq: number;
    protocolSchemaVersion: number;
    canonicalPayload: Record<string, unknown>;
  };
  /**
   * Run columns to change in the same UPDATE that reserves the sequence. A
   * second UPDATE of a run row this transaction already changed makes
   * PostgreSQL re-check every foreign key on heartbeat_runs (KEY SHARE on the
   * agent, issue, predecessor run, ...), so it can wait behind, or deadlock
   * with, an unrelated transaction that holds one of those rows FOR UPDATE.
   */
  runUpdate?: HeartbeatRunEventRunUpdate;
  /**
   * Checks that the writer may still write to the run. It runs before the
   * first statement and again before the commit, or after an append that
   * commits in its one statement. When it throws before the commit, the event
   * and its sequence roll back; after it, the append stays and the caller gets
   * the error instead of the receipt. A writer passes its check here instead of
   * wrapping the append in a transaction of its own.
   */
  assertWritable?: () => void;
}

type NativeSourceEventInput = AppendHeartbeatRunEventInput & Required<Pick<AppendHeartbeatRunEventInput, "nativeSource">>;
type RunEventWakes = { recovery: boolean; reassessment: boolean; progress: boolean; response: boolean; retention: boolean };

export type HeartbeatRunEventRunUpdate = Partial<Pick<typeof heartbeatRuns.$inferInsert,
  "legacyProcessSettlement" | "processPid" | "processGroupId" | "processHostHash" | "processStartedAt">>;

export interface AppendHeartbeatRunEventResult {
  row: typeof heartbeatRunEvents.$inferSelect;
  disposition: "committed" | "duplicate";
  highestContiguousSourceSeq: number;
}

export class HeartbeatRunEventConflictError extends Error {
  readonly code = "native_event_replay_conflict" as const;
  constructor() {
    super("native_event_replay_conflict");
    this.name = "HeartbeatRunEventConflictError";
  }
}

/**
 * Atomically reserve the next event sequence on the run row. Both native PRP
 * ingestion and legacy/direct-adapter writers use this allocator so the
 * database uniqueness invariant cannot turn a concurrent log/cancel/recovery
 * race into a failed run.
 */
export async function allocateHeartbeatRunEventSeq(
  db: Db,
  runId: string,
  runUpdate: HeartbeatRunEventRunUpdate = {},
): Promise<number> {
  const [updated] = await db
    .update(heartbeatRuns)
    .set({
      ...runUpdate,
      nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(heartbeatRuns.id, runId))
    .returning({ nextEventSeq: heartbeatRuns.nextEventSeq });
  if (!updated) throw new Error("heartbeat_run_event_binding_mismatch");
  return Number(updated.nextEventSeq) - 1;
}

function runEventWakes(input: AppendHeartbeatRunEventInput): RunEventWakes {
  return {
    // Terminal proof may arrive after controller retirement and a quiet Stop
    // check. Register the scoped wake before writing it, in the same transaction.
    recovery: ["native.process_start_requested", "native.process_identity_recorded", "native.local_process_stopped"].includes(input.eventType)
      || Boolean(input.nativeSource && ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(input.eventType)),
    reassessment: readNativeEventEvidenceOutcome(input.payload?.prpEvent) !== null,
    progress: isSafeNativeChatProgressEventType(input.eventType),
    response: isNativeResponseEvidence(input.eventType, input.payload?.prpEvent),
    retention: input.eventType === "lifecycle" && Boolean(input.message?.startsWith(RETRY_EXHAUSTION_MESSAGE_PREFIX)),
  };
}

export async function appendHeartbeatRunEvent(
  db: Db,
  input: AppendHeartbeatRunEventInput,
): Promise<AppendHeartbeatRunEventResult> {
  // Deduplicated receipts return without allocating, so they cannot carry run changes.
  if (input.runUpdate && (input.nativeSource || input.retryExhaustion)) throw new Error("heartbeat_run_event_run_update_unsupported");
  const wakes = runEventWakes(input);
  if (!input.runUpdate && !input.nativeSource && !input.retryExhaustion && !input.assertWritable && !Object.values(wakes).some(Boolean)) {
    const [appended] = await db.execute<Record<string, unknown>>(sql`
      with allocated_run_event as (
        update heartbeat_runs
        set next_event_seq = next_event_seq + 1,
            updated_at = ${sql.param(new Date(), heartbeatRuns.updatedAt)}
        where id = ${input.runId} and company_id = ${input.companyId} and agent_id = ${input.agentId}
        returning company_id, id as run_id, agent_id, next_event_seq - 1 as seq
      )
      insert into heartbeat_run_events
        (company_id, run_id, agent_id, seq, event_type, stream, level, color, message, payload)
      select company_id, run_id, agent_id, seq,
        ${input.eventType}, ${input.stream ?? null}, ${input.level ?? null},
        ${input.color ?? null}, ${input.message ?? null},
        ${sql.param(input.payload ?? null, heartbeatRunEvents.payload)}
      from allocated_run_event
      returning *
    `);
    if (!appended) throw new Error("heartbeat_run_event_binding_mismatch");
    return { row: decodeRunEventRow(appended), disposition: "committed", highestContiguousSourceSeq: 0 };
  }
  if (input.nativeSource && !input.runUpdate && !input.retryExhaustion && !Object.values(wakes).some(Boolean) && !is(db, PgTransaction)) {
    input.assertWritable?.();
    const receipts = await appendNewNativeSourceEvents(db, [input as NativeSourceEventInput]);
    if (receipts) {
      input.assertWritable?.();
      return receipts[0]!;
    }
  }
  return db.transaction(async (tx) => {
    input.assertWritable?.();
    const receipt = input.nativeSource
      ? await appendNativeSourceEvent(tx as unknown as Db, input as NativeSourceEventInput, wakes)
      : await appendLockedEvent(tx as unknown as Db, input, wakes);
    input.assertWritable?.();
    return receipt;
  });
}

/**
 * Appends native source events of one run and one source atomically, in the
 * given order, and returns one receipt per event. A stream that continues its
 * source's stored cursor with new events takes one statement for the whole
 * batch. Any other batch (a replay, a gap, an event that registers a wake, a
 * run without a cursor, or a run another writer changed meanwhile) appends its
 * events one by one in one transaction, with the checks of a single append.
 */
export async function appendHeartbeatRunEventBatch(
  db: Db,
  inputs: readonly AppendHeartbeatRunEventInput[],
  assertWritable?: () => void,
): Promise<AppendHeartbeatRunEventResult[]> {
  const first = inputs[0];
  if (!first) return [];
  const source = first.nativeSource;
  if (!source || inputs.some(input => !input.nativeSource || input.runUpdate || input.retryExhaustion
    || input.companyId !== first.companyId || input.runId !== first.runId || input.agentId !== first.agentId
    || input.nativeSource.sourceInstanceId !== source.sourceInstanceId)) {
    throw new Error("heartbeat_run_event_batch_unsupported");
  }
  if (inputs.length === 1) return [await appendHeartbeatRunEvent(db, assertWritable ? { ...first, assertWritable } : first)];
  const wakes = inputs.map(runEventWakes);
  if (!wakes.some(wake => Object.values(wake).some(Boolean)) && !is(db, PgTransaction)) {
    assertWritable?.();
    const receipts = await appendNewNativeSourceEvents(db, inputs as NativeSourceEventInput[]);
    if (receipts) return finish(receipts);
  }
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    assertWritable?.();
    const appendOneByOne = async () => {
      const receipts: AppendHeartbeatRunEventResult[] = [];
      for (const [index, input] of inputs.entries()) {
        receipts.push(await appendNativeSourceEvent(tx, input as NativeSourceEventInput, wakes[index]!));
      }
      return receipts;
    };
    if (wakes.some(wake => Object.values(wake).some(Boolean))) return finish(await appendOneByOne());
    const [run] = await tx.execute<{ company_id: string; agent_id: string; source_cursor: string | number | null }>(
      sql`select "company_id", "agent_id", ("native_source_cursors" ->> ${source.sourceInstanceId})::bigint as "source_cursor"
        from "heartbeat_runs" where "id" = ${first.runId} for no key update`);
    if (!run || run.company_id !== first.companyId || run.agent_id !== first.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }
    const cursor = run.source_cursor === null || run.source_cursor === undefined ? null : Number(run.source_cursor);
    const continuesCursor = cursor !== null && inputs.every((input, index) => input.nativeSource!.sourceSeq === cursor + index + 1);
    if (!continuesCursor) return finish(await appendOneByOne());
    const eventIds = JSON.stringify(inputs.map(input => input.nativeSource!.sourceEventId));
    const [replayed] = await tx.execute<{ replayed: boolean }>(sql`select exists (
      select 1 from heartbeat_run_events where run_id = ${first.runId} and (
        source_event_id = any(array(select jsonb_array_elements_text(${eventIds}::jsonb)))
        or (source_instance_id = ${source.sourceInstanceId} and source_seq > ${cursor}::bigint))) as replayed`);
    if (replayed?.replayed) return finish(await appendOneByOne());
    const rows = JSON.stringify(inputs.map(input => ({
      eventType: input.eventType, stream: input.stream ?? null, level: input.level ?? null, color: input.color ?? null,
      message: input.message ?? null,
      payload: input.payload ? heartbeatRunEvents.payload.mapToDriverValue(input.payload) : null,
      sourceEventId: input.nativeSource!.sourceEventId, sourceSeq: input.nativeSource!.sourceSeq,
      sourcePayloadSha256: nativeSha256(input.nativeSource!.canonicalPayload),
      protocolSchemaVersion: input.nativeSource!.protocolSchemaVersion,
    })));
    const lastSeq = cursor + inputs.length;
    const inserted = await tx.execute<Record<string, unknown>>(sql`
      with allocated as (
        update heartbeat_runs
        set next_event_seq = next_event_seq + ${inputs.length}::integer,
            updated_at = ${sql.param(new Date(), heartbeatRuns.updatedAt)},
            native_source_cursors = jsonb_set(coalesce(native_source_cursors, '{}'::jsonb),
              array[${source.sourceInstanceId}::text], to_jsonb(${lastSeq}::bigint))
        where id = ${first.runId}
        returning next_event_seq - ${inputs.length}::integer as first_seq
      )
      insert into heartbeat_run_events
        (company_id, run_id, agent_id, seq, event_type, stream, level, color, message, payload,
          source_instance_id, source_event_id, source_seq, source_payload_sha256, protocol_schema_version)
      select ${first.companyId}::uuid, ${first.runId}::uuid, ${first.agentId}::uuid, allocated.first_seq + event.ordinal - 1,
        event.value ->> 'eventType', event.value ->> 'stream', event.value ->> 'level', event.value ->> 'color',
        event.value ->> 'message', (event.value ->> 'payload')::jsonb,
        ${source.sourceInstanceId}::text, event.value ->> 'sourceEventId', (event.value ->> 'sourceSeq')::bigint,
        event.value ->> 'sourcePayloadSha256', (event.value ->> 'protocolSchemaVersion')::integer
      from allocated cross join jsonb_array_elements(${rows}::jsonb) with ordinality as event(value, ordinal)
      order by event.ordinal
      returning *
    `);
    if (inserted.length !== inputs.length) throw new Error("heartbeat_run_event_not_persisted");
    const bySourceSeq = new Map(inserted.map(raw => [Number(raw.source_seq), decodeRunEventRow(raw)]));
    return finish(inputs.map(input => ({
      row: bySourceSeq.get(input.nativeSource!.sourceSeq)!,
      disposition: "committed" as const,
      highestContiguousSourceSeq: input.nativeSource!.sourceSeq,
    })));
  });

  function finish(receipts: AppendHeartbeatRunEventResult[]) {
    assertWritable?.();
    return receipts;
  }
}

const APPEND_NEW_NATIVE_SOURCE_EVENTS_SQL = `
  with snapshot_run as (
    select next_event_seq from heartbeat_runs where id = $1::uuid
  ), allocated as (
    update heartbeat_runs
    set next_event_seq = next_event_seq + $6::integer,
        updated_at = $7::timestamptz,
        native_source_cursors = jsonb_set(coalesce(native_source_cursors, '{}'::jsonb),
          array[$4::text], to_jsonb($5::bigint + $6::integer - 1))
    where id = $1::uuid and company_id = $2::uuid and agent_id = $3::uuid
      and coalesce((native_source_cursors ->> $4::text)::bigint, 0) = $5::bigint - 1
      and next_event_seq = (select next_event_seq from snapshot_run)
      and not exists (select 1 from heartbeat_run_events where run_id = $1::uuid and (
        source_event_id = any(array(select jsonb_array_elements_text($8::jsonb)))
        or (source_instance_id = $4::text and source_seq >= $5::bigint)))
    returning next_event_seq - $6::integer as first_seq
  )
  insert into heartbeat_run_events
    (company_id, run_id, agent_id, seq, event_type, stream, level, color, message, payload,
      source_instance_id, source_event_id, source_seq, source_payload_sha256, protocol_schema_version)
  select $2::uuid, $1::uuid, $3::uuid, allocated.first_seq + event.ordinal - 1,
    event.value ->> 'eventType', event.value ->> 'stream', event.value ->> 'level', event.value ->> 'color',
    event.value ->> 'message', (event.value ->> 'payload')::jsonb,
    $4::text, event.value ->> 'sourceEventId', $5::bigint - 1 + event.ordinal,
    event.value ->> 'sourcePayloadSha256', (event.value ->> 'protocolSchemaVersion')::integer
  from allocated cross join jsonb_array_elements($9::jsonb) with ordinality as event(value, ordinal)
  order by event.ordinal
  returning *`;

async function appendNewNativeSourceEvents(
  db: Db,
  inputs: readonly NativeSourceEventInput[],
): Promise<AppendHeartbeatRunEventResult[] | null> {
  const first = inputs[0]!;
  const source = first.nativeSource;
  const firstSeq = source.sourceSeq;
  if (typeof db.$client?.unsafe !== "function" || firstSeq < 1
    || inputs.some((input, index) => input.nativeSource.sourceSeq !== firstSeq + index)) return null;
  const eventIds = JSON.stringify(inputs.map(input => input.nativeSource.sourceEventId));
  const rows = JSON.stringify(inputs.map(input => ({
    eventType: input.eventType, stream: input.stream ?? null, level: input.level ?? null, color: input.color ?? null,
    message: input.message ?? null,
    payload: input.payload ? heartbeatRunEvents.payload.mapToDriverValue(input.payload) : null,
    sourceEventId: input.nativeSource.sourceEventId,
    sourcePayloadSha256: nativeSha256(input.nativeSource.canonicalPayload),
    protocolSchemaVersion: input.nativeSource.protocolSchemaVersion,
  })));
  let inserted: Record<string, unknown>[];
  try {
    inserted = await db.$client.unsafe<Record<string, unknown>[]>(APPEND_NEW_NATIVE_SOURCE_EVENTS_SQL, [first.runId, first.companyId,
      first.agentId, source.sourceInstanceId, String(firstSeq), String(inputs.length), new Date().toISOString(), eventIds, rows]);
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  if (inserted.length === 0) return null;
  if (inserted.length !== inputs.length) throw new Error("heartbeat_run_event_not_persisted");
  const bySourceSeq = new Map(inserted.map(raw => [Number(raw.source_seq), decodeRunEventRow(raw)]));
  return inputs.map(input => ({
    row: bySourceSeq.get(input.nativeSource.sourceSeq)!,
    disposition: "committed" as const,
    highestContiguousSourceSeq: input.nativeSource.sourceSeq,
  }));
}

const runEventColumns = Object.entries(getTableColumns(heartbeatRunEvents));

/**
 * Decodes a `returning *` row the way a Drizzle select of the table does. The
 * statements of an event stream are fixed SQL text: building the same
 * statement through the query builder for every event costs more CPU and
 * garbage than running it.
 */
function decodeRunEventRow(raw: Record<string, unknown>): typeof heartbeatRunEvents.$inferSelect {
  const row: Record<string, unknown> = {};
  for (const [key, column] of runEventColumns) {
    const value = raw[column.name];
    row[key] = value === null || value === undefined ? null : column.mapFromDriverValue(value);
  }
  return row as typeof heartbeatRunEvents.$inferSelect;
}

/**
 * A native source event: one lock read, then one statement that finds a
 * replayed event or reserves the sequence and inserts, and reads how much of
 * the source is retained. The lock must stay a statement of its own. A
 * statement that waits for the run lock keeps the snapshot it took before
 * waiting, so it would not see an event the lock holder had just committed.
 */
async function appendNativeSourceEvent(
  tx: Db,
  input: NativeSourceEventInput,
  wakes: RunEventWakes,
): Promise<AppendHeartbeatRunEventResult> {
  const source = input.nativeSource;
  // Appenders, Stop, recovery and deletion still serialize on this row.
  // The append never changes key columns, so it must not block foreign
  // key checks (FOR KEY SHARE) of child rows, such as controller
  // checkpoints, that are written for the same run while events stream.
  // Only progress needs the task binding. Other native/recovery events
  // must not read a potentially large context snapshot to append a log.
  const [run] = await tx.execute<{ company_id: string; agent_id: string; source_cursor: string | number | null;
    runtime_mode?: string | null; issue_id?: string | null }>(
    sql`select "company_id", "agent_id", ("native_source_cursors" ->> ${source.sourceInstanceId})::bigint as "source_cursor"${
      wakes.progress || wakes.response || wakes.reassessment ? sql`, "runtime_mode"` : sql.empty()}${
      wakes.progress ? sql`, ${boundRunIssueIdSql()} as "issue_id"` : sql.empty()
    } from "heartbeat_runs" where "id" = ${input.runId} for no key update`);
  if (!run || run.company_id !== input.companyId || run.agent_id !== input.agentId) {
    throw new Error("heartbeat_run_event_binding_mismatch");
  }
  // The stored cursor says the run holds every event of this source up to it.
  // An event at or just past it moves the cursor without counting the run's
  // events; any other event, or a run without a cursor, recounts them.
  const storedCursor = run.source_cursor === null || run.source_cursor === undefined ? null : Number(run.source_cursor);
  const inOrderCursor = storedCursor !== null && source.sourceSeq <= storedCursor + 1
    ? (source.sourceSeq === storedCursor + 1 ? source.sourceSeq : storedCursor)
    : null;
  if (wakes.recovery) await notifyLiveRunRecovery(tx, input);

  const sourceHash = nativeSha256(source.canonicalPayload);
  const replayed = sql`run_id = ${input.runId} and (source_event_id = ${source.sourceEventId}
    or (source_instance_id = ${source.sourceInstanceId} and source_seq = ${source.sourceSeq}))`;
  const native = run.runtime_mode === "native";
  const reassessment = wakes.reassessment && native, progress = wakes.progress && native && run.issue_id;
  const response = wakes.response && native;
  if (reassessment || progress || response || wakes.retention) {
    // A wake is registered before the write it announces, and a replayed
    // event registers none. So these events look for their replay first.
    const [existing] = await tx.execute<Record<string, unknown>>(sql`select * from heartbeat_run_events where ${replayed} limit 1`);
    if (existing) {
      const row = decodeRunEventRow(existing);
      if (row.sourcePayloadSha256 !== sourceHash) throw new HeartbeatRunEventConflictError();
      return { row, disposition: "duplicate", highestContiguousSourceSeq: inOrderCursor ?? await contiguousCursor(tx, input.runId,
        source.sourceInstanceId, await retainedSourceRange(tx, input.runId, source.sourceInstanceId)) };
    }
    if (reassessment) await notifyNativeStatusReassessment(tx, { companyId: run.company_id, runId: input.runId });
    if (progress) await notifyChatNativeProgress(tx, { companyId: run.company_id, issueId: progress });
    if (response) await notifyNativeResponsePresentation(tx, { companyId: run.company_id, runId: input.runId });
    if (wakes.retention) await notifyAttentionRetentionWork(tx, { companyId: input.companyId, sourceKind: "failed_run" });
  }

  // `existing` and `retained` read the snapshot from before this statement's
  // own insert. A replayed event reserves no sequence and inserts nothing.
  const counted = source.sourceSeq >= 1 ? 1 : 0;
  const cursorKey = sql`array[${source.sourceInstanceId}::text]`;
  // An in-order event keeps the cursor without reading other events. Any
  // other event recounts the source: it stores the cursor when the source has
  // no gap and removes it otherwise, so the event that fills a gap recounts.
  const cursorUpdate = inOrderCursor !== null
    ? (inOrderCursor === storedCursor ? sql.empty() : sql`, native_source_cursors = jsonb_set(
        coalesce(native_source_cursors, '{}'::jsonb), ${cursorKey}, to_jsonb(${inOrderCursor}::bigint))`)
    : sql`, native_source_cursors = case
        when retained.retained_count + ${counted}::integer
          = greatest(coalesce(retained.retained_max, 0), ${counted ? source.sourceSeq : 0}::bigint)
        then jsonb_set(coalesce(native_source_cursors, '{}'::jsonb), ${cursorKey},
          to_jsonb(retained.retained_count + ${counted}::integer))
        else coalesce(native_source_cursors, '{}'::jsonb) - ${source.sourceInstanceId}::text end`;
  const [result] = await tx.execute<Record<string, unknown>>(sql`
    with existing as (
      select * from heartbeat_run_events where ${replayed} limit 1
    )${inOrderCursor !== null ? sql.empty() : sql`, retained as (
      select count(*) as retained_count, max(source_seq) as retained_max
      from heartbeat_run_events
      where run_id = ${input.runId} and source_instance_id = ${source.sourceInstanceId} and source_seq >= 1
    )`}, allocated as (
      update heartbeat_runs
      set next_event_seq = next_event_seq + 1,
          updated_at = ${sql.param(new Date(), heartbeatRuns.updatedAt)}${cursorUpdate}
      ${inOrderCursor !== null ? sql.empty() : sql`from retained`}
      where id = ${input.runId} and not exists (select 1 from existing)
      returning next_event_seq - 1 as seq
    ), appended as (
      insert into heartbeat_run_events
        (company_id, run_id, agent_id, seq, event_type, stream, level, color, message, payload,
          source_instance_id, source_event_id, source_seq, source_payload_sha256, protocol_schema_version)
      select ${input.companyId}::uuid, ${input.runId}::uuid, ${input.agentId}::uuid, seq,
        ${input.eventType}::text, ${input.stream ?? null}::text, ${input.level ?? null}::text,
        ${input.color ?? null}::text, ${input.message ?? null}::text,
        ${sql.param(input.payload ?? null, heartbeatRunEvents.payload)}::jsonb,
        ${source.sourceInstanceId}::text, ${source.sourceEventId}::text, ${source.sourceSeq}::bigint,
        ${sourceHash}::text, ${source.protocolSchemaVersion}::integer
      from allocated
      returning *
    )${inOrderCursor !== null ? sql`
    select true as appended, event.* from appended event
    union all
    select false as appended, event.* from existing event` : sql`
    select true as appended, event.*, retained.* from appended event cross join retained
    union all
    select false as appended, event.*, retained.* from existing event cross join retained`}
  `);
  if (!result) throw new Error("heartbeat_run_event_not_persisted");
  const row = decodeRunEventRow(result);
  const appended = result.appended === true;
  if (!appended && row.sourcePayloadSha256 !== sourceHash) throw new HeartbeatRunEventConflictError();
  if (inOrderCursor !== null) {
    return { row, disposition: appended ? "committed" : "duplicate", highestContiguousSourceSeq: inOrderCursor };
  }
  const countedHere = appended && counted === 1;
  return {
    row,
    disposition: appended ? "committed" : "duplicate",
    highestContiguousSourceSeq: await contiguousCursor(tx, input.runId, source.sourceInstanceId, {
      count: Number(result.retained_count) + (countedHere ? 1 : 0),
      max: Math.max(Number(result.retained_max ?? 0), countedHere ? source.sourceSeq : 0),
    }),
  };
}

/** Every other event that needs the run lock: receipts, run changes and wakes. */
async function appendLockedEvent(
  tx: Db,
  input: AppendHeartbeatRunEventInput,
  wakes: RunEventWakes,
): Promise<AppendHeartbeatRunEventResult> {
  const run = await tx
    .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      // Only progress needs the task binding. Other native/recovery events
      // must not read a potentially large context snapshot to append a log.
      ...(wakes.progress || wakes.response || wakes.reassessment ? { runtimeMode: heartbeatRuns.runtimeMode } : {}),
      ...(wakes.progress ? { issueId: boundRunIssueIdSql() } : {}) })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    // Appenders, Stop, recovery and deletion still serialize on this row.
    // The append never changes key columns, so it must not block foreign
    // key checks (FOR KEY SHARE) of child rows, such as controller
    // checkpoints, that are written for the same run while events stream.
    .for("no key update")
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
    throw new Error("heartbeat_run_event_binding_mismatch");
  }

  if (wakes.recovery) await notifyLiveRunRecovery(tx, input);

  if (input.retryExhaustion) {
    // The run lock also serializes concurrent recovery checks across server
    // instances. Reusing the receipt must not allocate a sequence or publish
    // another live event on each scheduler tick.
    const existing = await tx
      .select()
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.runId, input.runId),
        eq(heartbeatRunEvents.agentId, input.agentId),
        eq(heartbeatRunEvents.eventType, "lifecycle"),
        sql`${heartbeatRunEvents.message} like ${`${RETRY_EXHAUSTION_MESSAGE_PREFIX}%`}`,
        sql`${heartbeatRunEvents.payload} @> ${JSON.stringify(input.retryExhaustion)}::jsonb`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      return {
        row: existing,
        disposition: "duplicate" as const,
        highestContiguousSourceSeq: 0,
      };
    }
  }

  if (wakes.reassessment && run.runtimeMode === "native") {
    await notifyNativeStatusReassessment(tx, { companyId: run.companyId, runId: input.runId });
  }
  if (wakes.progress && run.runtimeMode === "native" && run.issueId) {
    await notifyChatNativeProgress(tx, { companyId: run.companyId, issueId: run.issueId });
  }
  if (wakes.response && run.runtimeMode === "native") {
    await notifyNativeResponsePresentation(tx, { companyId: run.companyId, runId: input.runId });
  }
  if (wakes.retention) await notifyAttentionRetentionWork(tx, { companyId: input.companyId, sourceKind: "failed_run" });
  const seq = await allocateHeartbeatRunEventSeq(tx, input.runId, input.runUpdate);
  const [row] = await tx.insert(heartbeatRunEvents).values({
    companyId: input.companyId,
    runId: input.runId,
    agentId: input.agentId,
    seq,
    eventType: input.eventType,
    stream: input.stream ?? null,
    level: input.level ?? null,
    color: input.color ?? null,
    message: input.message ?? null,
    payload: input.payload ?? null,
  }).returning();
  if (!row) throw new Error("heartbeat_run_event_not_persisted");
  return { row, disposition: "committed" as const, highestContiguousSourceSeq: 0 };
}

const sourceEvents = (runId: string, sourceInstanceId: string) => and(
  eq(heartbeatRunEvents.runId, runId),
  eq(heartbeatRunEvents.sourceInstanceId, sourceInstanceId),
  sql`${heartbeatRunEvents.sourceSeq} >= 1`,
);

/** How many events of one source a run retains, and the highest source sequence among them. */
async function retainedSourceRange(db: Db, runId: string, sourceInstanceId: string) {
  const [range] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      max: sql<number | null>`max(${heartbeatRunEvents.sourceSeq})`.mapWith(Number),
    })
    .from(heartbeatRunEvents)
    .where(sourceEvents(runId, sourceInstanceId));
  return { count: range?.count ?? 0, max: range?.max ?? 0 };
}

/**
 * The highest source sequence retained without a gap before it. A stream that
 * arrives in order needs no read: its count equals its highest sequence.
 */
async function contiguousCursor(
  db: Db,
  runId: string,
  sourceInstanceId: string,
  range: { count: number; max: number },
): Promise<number> {
  if (!range.count) return 0;
  if (range.max === range.count) return range.count;
  const scope = sourceEvents(runId, sourceInstanceId);
  const [first] = await db
    .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
    .from(heartbeatRunEvents)
    .where(and(scope, eq(heartbeatRunEvents.sourceSeq, 1)))
    .limit(1);
  if (!first) return 0;
  const [last] = await db
    .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
    .from(heartbeatRunEvents)
    .where(and(scope, sql`not exists (
      select 1 from heartbeat_run_events next_event
      where next_event.run_id = heartbeat_run_events.run_id
        and next_event.source_instance_id = heartbeat_run_events.source_instance_id
        and next_event.source_seq = heartbeat_run_events.source_seq + 1
    )`))
    .orderBy(asc(heartbeatRunEvents.sourceSeq))
    .limit(1);
  return last?.sourceSeq ?? 0;
}

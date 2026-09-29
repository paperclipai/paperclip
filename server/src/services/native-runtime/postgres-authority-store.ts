import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeAuthorityRecords, nativeAuthorityWork, nativeSessionAuthorities, type Db } from "@paperclipai/db";
import {
  validatePrpEvent, authorityInteger, authorityGeneration, authorityJson, validateAuthorityCommit, validateAuthorityPage, DurableAuthorityStoreError,
  type AuthorityCommit, type AuthorityPage, type AuthorityRecord, type AuthoritySnapshot, type DurableAuthorityStore,
  type AuthorityWorkRecord, type AuthorityWorkPage, validateAuthorityWorkKey, validateAuthorityWorkPage,
  materializeCurrentAuthority,
} from "../../vendor/paperclip-runner/index.js";
import { createHistoryPayloadStore, type HistoryPayloadStore } from "./history-payload-store.js";
import { classifyNativeAuthorityStorageError } from "./native-authority-storage-error.js";

export type AuthorityTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface PostgresAuthorityBinding {
  companyId: string;
  issueId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
}

const digest = (body: string) => createHash("sha256").update(body).digest("hex");

async function retryRolledBackTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      let cause = error;
      let aborted = false;
      for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
        const detail = cause as { code?: unknown; cause?: unknown };
        if (detail.code === "40P01" || detail.code === "40001") { aborted = true; break; }
        cause = detail.cause;
      }
      // PostgreSQL explicitly rolls back these transactions. A connection
      // loss/unknown commit result is different and must retain the write fence.
      if (!aborted || attempt >= 3) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * 2 ** attempt + Math.floor(Math.random() * 10)));
    }
  }
}

/** All queries include company and normalized session. Database foreign keys
 * additionally bind records to that company's issue and heartbeat run. */
export class PostgresAuthorityStore implements DurableAuthorityStore {
  readonly unorderedEffectReceipts = true;
  readonly commandEpochs = true;
  readonly eventEpochs = true;
  readonly binding: string;
  private epoch: string;
  constructor(
    private readonly db: Db,
    private readonly owner: PostgresAuthorityBinding,
    /** Additional transaction-local binding/ingestion checks for the embedding runtime. */
    private readonly commitEvents: (tx: AuthorityTransaction, events: readonly AuthorityRecord[]) => Promise<void>,
    /** A migration or maintenance owner must still hold its lease in the
     * transaction that publishes authority, not merely before starting I/O. */
    private readonly assertWriteFence?: (tx: AuthorityTransaction) => Promise<void>,
    private readonly payloadStore: () => HistoryPayloadStore = createHistoryPayloadStore,
  ) {
    const { runId, ...session } = owner;
    this.binding = authorityJson(session);
    this.epoch = runId;
  }

  get location(): import("../../vendor/paperclip-runner/index.js").AuthorityLocation {
    return { kind: "postgres", binding: this.binding, epoch: this.epoch };
  }

  private authorityScope() {
    return and(eq(nativeSessionAuthorities.companyId, this.owner.companyId), eq(nativeSessionAuthorities.normalizedSessionId, this.owner.normalizedSessionId), eq(nativeSessionAuthorities.runId, this.epoch));
  }

  private recordScope(epoch: string, kind: AuthorityRecord["kind"]) {
    return and(eq(nativeAuthorityRecords.companyId, this.owner.companyId), eq(nativeAuthorityRecords.issueId, this.owner.issueId), eq(nativeAuthorityRecords.normalizedSessionId, this.owner.normalizedSessionId), eq(nativeAuthorityRecords.runId, epoch), eq(nativeAuthorityRecords.kind, kind));
  }

  private workScope(collection: string) {
    return and(eq(nativeAuthorityWork.companyId, this.owner.companyId), eq(nativeAuthorityWork.issueId, this.owner.issueId),
      eq(nativeAuthorityWork.normalizedSessionId, this.owner.normalizedSessionId), eq(nativeAuthorityWork.collection, collection));
  }
  private decodeWork(row: typeof nativeAuthorityWork.$inferSelect): AuthorityWorkRecord {
    if (row.bodySha256 !== digest(row.body)) throw new DurableAuthorityStoreError("invalid_authority", "outstanding-work digest mismatch");
    return { collection: row.collection as AuthorityWorkRecord["collection"], id: row.workId, body: JSON.parse(row.body), sha256: row.bodySha256 };
  }
  async getWork(collection: AuthorityWorkRecord["collection"], id: string): Promise<AuthorityWorkRecord | null> {
    validateAuthorityWorkKey(collection, id);
    const [row] = await this.db.select().from(nativeAuthorityWork).where(and(this.workScope(collection), eq(nativeAuthorityWork.workId, id)));
    return row ? this.decodeWork(row) : null;
  }
  async readWorkPage(collection: AuthorityWorkRecord["collection"], after: string, limit: number, expectedGeneration: string): Promise<AuthorityWorkPage> {
    validateAuthorityWorkPage(collection, after, limit, expectedGeneration);
    return this.db.transaction(async tx => {
      const [authority] = await tx.select().from(nativeSessionAuthorities).where(this.authorityScope()).for("share");
      if (!authority || authority.stateSha256 !== digest(authority.state) || authority.binding !== this.binding || authority.successorRunId !== null || String(authority.generation) !== expectedGeneration) throw new DurableAuthorityStoreError("stale_authority", "outstanding-work page generation changed");
      const rows = await tx.select().from(nativeAuthorityWork).where(and(this.workScope(collection), gt(nativeAuthorityWork.workId, after)))
        .orderBy(asc(nativeAuthorityWork.workId)).limit(limit);
      return { records: rows.map(row => this.decodeWork(row)), nextAfter: rows.at(-1)?.workId ?? null };
    });
  }

  async load(): Promise<AuthoritySnapshot | null> {
    const [row] = await this.db.select().from(nativeSessionAuthorities).where(this.authorityScope());
    if (!row) return null;
    if (row.successorRunId !== null) throw new DurableAuthorityStoreError("stale_authority", "authority epoch has a successor");
    if (row.binding !== this.binding || row.issueId !== this.owner.issueId || row.stateSha256 !== digest(row.state)) throw new DurableAuthorityStoreError("invalid_authority", "current authority binding/digest mismatch");
    authorityGeneration(row.generation);
    if (row.committedFrom !== null) authorityGeneration(row.committedFrom);
    if (row.generation.startsWith("r:") && row.committedFrom === null) throw new DurableAuthorityStoreError("invalid_authority", "opaque authority commit has no predecessor");
    return { generation: row.generation, ...(row.committedFrom === null ? {} : { committedFrom: row.committedFrom }), state: JSON.parse(row.state) };
  }

  async commit(input: AuthorityCommit): Promise<string> {
    try { return await this.commitOnce(input); }
    catch (error) { throw classifyNativeAuthorityStorageError(error); }
  }

  private async commitOnce(input: AuthorityCommit): Promise<string> {
    validateAuthorityCommit(input);
    const expected = authorityGeneration(input.expectedGeneration), generation = `r:${randomUUID()}`;
    if (generation === expected) throw new DurableAuthorityStoreError("storage_unavailable", "fresh authority revision unavailable");
    const state = authorityJson(input.state);
    const identity = input.state.identity as { runId?: string } | undefined;
    const nextEpoch = identity?.runId ?? this.epoch;
    if (input.records.some((record) => record.epoch !== nextEpoch)) throw new DurableAuthorityStoreError("invalid_authority", "receipt epoch differs from current authority");
    const prepared = new Map<AuthorityRecord, { body: string; bodySha256: string; bodyEncoding: string; bodyBytes: number | null }>();
    // Upload outside the authority transaction. No database lock is held across
    // object-store I/O. The transaction below still validates every owner/fence.
    for (const record of input.records) {
      const body = authorityJson(record.body), bytes = Buffer.byteLength(body), bodySha256 = digest(body);
      if (bytes <= 16 * 1024) prepared.set(record, { body, bodySha256, bodyEncoding: "json", bodyBytes: null });
      else {
        const [run] = await this.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, this.owner.companyId), eq(heartbeatRuns.nativeIssueId, this.owner.issueId),
          eq(heartbeatRuns.nativeSessionId, this.owner.normalizedSessionId), eq(heartbeatRuns.runnerInstanceId, this.owner.runnerInstanceId),
          eq(heartbeatRuns.id, record.epoch), eq(heartbeatRuns.runtimeMode, "native"),
        ));
        if (!run) throw new DurableAuthorityStoreError("invalid_authority", "payload run is not authorized");
        const ref = await this.payloadStore().put({ companyId: this.owner.companyId, runId: record.epoch }, Buffer.from(body), "application/json");
        prepared.set(record, { body: authorityJson(ref), bodySha256, bodyEncoding: "object.v1", bodyBytes: bytes });
      }
    }
    const committed = await retryRolledBackTransaction(() => this.db.transaction(async (tx) => {
      // Take parent locks before touching authority rows or inserting their
      // foreign-key references. Otherwise a raw-event writer can hold an
      // authority lock / run KEY SHARE while upgrading to the run UPDATE lock
      // held by a concurrent event or lifecycle transaction.
      const [issue] = await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, this.owner.companyId), eq(issues.id, this.owner.issueId))).for("key share");
      if (!issue) throw new DurableAuthorityStoreError("invalid_authority", "authority issue is not authorized");
      const epochs = [...new Set([this.epoch, nextEpoch])].sort();
      const runs = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, this.owner.companyId), eq(heartbeatRuns.nativeIssueId, this.owner.issueId),
        eq(heartbeatRuns.nativeSessionId, this.owner.normalizedSessionId), eq(heartbeatRuns.runnerInstanceId, this.owner.runnerInstanceId),
        eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.id, epochs),
      )).orderBy(asc(heartbeatRuns.id)).for("update");
      if (runs.length !== epochs.length) throw new DurableAuthorityStoreError("invalid_authority", "authority run is not authorized");
      await this.assertWriteFence?.(tx);
      const patch = { generation, committedFrom: expected, state, stateSha256: digest(state), updatedAt: new Date() };
      if (nextEpoch !== this.epoch) {
        const sealed = await tx.update(nativeSessionAuthorities).set({ generation, committedFrom: expected, successorRunId: nextEpoch, updatedAt: new Date() })
          .where(and(this.authorityScope(), eq(nativeSessionAuthorities.binding, this.binding), eq(nativeSessionAuthorities.generation, expected), isNull(nativeSessionAuthorities.successorRunId))).returning({ generation: nativeSessionAuthorities.generation });
        if (sealed.length !== 1) throw new DurableAuthorityStoreError("stale_authority", "authority generation or epoch changed");
        await tx.insert(nativeSessionAuthorities).values({ ...this.owner, runId: nextEpoch, binding: this.binding, ...patch });
      } else {
        const changed = expected === "0"
          ? await tx.insert(nativeSessionAuthorities).values({ ...this.owner, runId: this.epoch, binding: this.binding, ...patch }).onConflictDoNothing().returning({ generation: nativeSessionAuthorities.generation })
          : await tx.update(nativeSessionAuthorities).set(patch).where(and(this.authorityScope(), eq(nativeSessionAuthorities.issueId, this.owner.issueId), eq(nativeSessionAuthorities.binding, this.binding), eq(nativeSessionAuthorities.generation, expected), isNull(nativeSessionAuthorities.successorRunId))).returning({ generation: nativeSessionAuthorities.generation });
        if (changed.length !== 1) throw new DurableAuthorityStoreError("stale_authority", "authority generation or owner changed");
      }
      for (const change of input.work ?? []) {
        const scope = and(this.workScope(change.collection), eq(nativeAuthorityWork.workId, change.id));
        const [existing] = await tx.select().from(nativeAuthorityWork).where(scope).for("update");
        if (existing && existing.bodySha256 !== digest(existing.body)) throw new DurableAuthorityStoreError("invalid_authority", "outstanding-work digest mismatch");
        if ((existing?.bodySha256 ?? null) !== change.expectedSha256) throw new DurableAuthorityStoreError("stale_authority", "outstanding-work digest changed");
        if (change.body === null) await tx.delete(nativeAuthorityWork).where(scope);
        else {
          const body = authorityJson(change.body), bodySha256 = digest(body);
          if (existing) await tx.update(nativeAuthorityWork).set({ body, bodySha256 }).where(scope);
          else await tx.insert(nativeAuthorityWork).values({ companyId: this.owner.companyId, issueId: this.owner.issueId,
            normalizedSessionId: this.owner.normalizedSessionId, runId: nextEpoch, collection: change.collection, workId: change.id, body, bodySha256 });
        }
      }
      for (const record of input.records) {
        const stored = prepared.get(record)!;
        const [existing] = await tx.select().from(nativeAuthorityRecords).where(and(this.recordScope(record.epoch, record.kind), eq(nativeAuthorityRecords.recordId, record.id)));
        if (existing) {
          // Retained inline receipts and object-backed receipts have the same
          // canonical digest. A storage-format change cannot alter replay.
          if (existing.sequenceEpoch !== (record.sequenceEpoch ?? "") || String(existing.sequence) !== record.sequence || existing.bodySha256 !== stored.bodySha256 ||
            (existing.bodyEncoding === "json" && existing.body !== authorityJson(record.body)) ||
            (existing.bodyEncoding === "object.v1" && (existing.body !== stored.body || existing.bodyBytes !== stored.bodyBytes)) ||
            !["json", "object.v1"].includes(existing.bodyEncoding)) throw new DurableAuthorityStoreError("receipt_conflict", "exact receipt differs");
        } else {
          if (record.kind !== "effect") {
            const [sequenceOwner] = await tx.select({ id: nativeAuthorityRecords.recordId }).from(nativeAuthorityRecords)
              .where(and(this.recordScope(record.epoch, record.kind), eq(nativeAuthorityRecords.sequenceEpoch, record.sequenceEpoch ?? ""), eq(nativeAuthorityRecords.sequence, authorityInteger(record.sequence))));
            if (sequenceOwner) throw new DurableAuthorityStoreError("receipt_conflict", "receipt sequence already belongs to another identity");
          }
          await tx.insert(nativeAuthorityRecords).values({
            companyId: this.owner.companyId, issueId: this.owner.issueId, normalizedSessionId: this.owner.normalizedSessionId,
            runId: record.epoch, kind: record.kind, recordId: record.id, sequence: authorityInteger(record.sequence), sequenceEpoch: record.sequenceEpoch ?? "", ...stored,
          });
        }
      }
      // The immutable raw event inbox and current cursor commit together.
      // Paperclip's provider driver translates this stream into a separate
      // run-log sequence. Original frames remain available for exact replay.
      const events = input.records.filter((record) => record.kind === "event");
      if (events.length) await this.commitEvents(tx, events);
      return String(generation);
    }));
    this.epoch = nextEpoch;
    return committed;
  }

  private async decode(row: typeof nativeAuthorityRecords.$inferSelect): Promise<AuthorityRecord> {
    let body = row.body;
    if (row.bodyEncoding === "object.v1") {
      const ref = JSON.parse(body);
      if (ref.mediaType !== "application/json" || ref.sha256 !== row.bodySha256 || ref.byteLength !== row.bodyBytes) throw new DurableAuthorityStoreError("invalid_authority", "receipt reference mismatch");
      body = (await this.payloadStore().read({ companyId: row.companyId, runId: row.runId }, ref, 1024 * 1024)).toString("utf8");
    } else if (row.bodyEncoding !== "json") throw new DurableAuthorityStoreError("invalid_authority", "receipt encoding is unsupported");
    if (row.bodySha256 !== digest(body)) throw new DurableAuthorityStoreError("invalid_authority", "receipt digest mismatch");
    return { epoch: row.runId, kind: row.kind as AuthorityRecord["kind"], id: row.recordId, sequence: String(row.sequence), ...(row.sequenceEpoch ? { sequenceEpoch: row.sequenceEpoch } : {}), body: JSON.parse(body) };
  }

  async getRecord(epoch: string, kind: AuthorityRecord["kind"], id: string): Promise<AuthorityRecord | null> {
    const [row] = await this.db.select().from(nativeAuthorityRecords).where(and(this.recordScope(epoch, kind), eq(nativeAuthorityRecords.recordId, id)));
    return row ? this.decode(row) : null;
  }

  async getSessionEffect(id: string): Promise<AuthorityRecord | null> {
    const [row] = await this.db.select().from(nativeAuthorityRecords).where(and(
      eq(nativeAuthorityRecords.companyId, this.owner.companyId), eq(nativeAuthorityRecords.issueId, this.owner.issueId),
      eq(nativeAuthorityRecords.normalizedSessionId, this.owner.normalizedSessionId),
      eq(nativeAuthorityRecords.kind, "effect"), eq(nativeAuthorityRecords.recordId, id),
    ));
    return row ? this.decode(row) : null;
  }

  async readEvents(epoch: string, after: string, limit: number, byteBudget: number, sequenceEpoch?: string): Promise<AuthorityPage> {
    validateAuthorityPage(after, limit, byteBudget, sequenceEpoch);
    // Fetch bounded metadata first, so a page cannot allocate limit * maximum
    // payload size before enforcing its byte budget. Immutable rows cannot
    // change between these two queries.
    const metadata = await this.db.select({ id: nativeAuthorityRecords.recordId, bytes: sql<number>`coalesce(${nativeAuthorityRecords.bodyBytes}, octet_length(${nativeAuthorityRecords.body}))::integer` }).from(nativeAuthorityRecords)
      .where(and(this.recordScope(epoch, "event"), eq(nativeAuthorityRecords.sequenceEpoch, sequenceEpoch ?? ""), gt(nativeAuthorityRecords.sequence, authorityInteger(after)))).orderBy(asc(nativeAuthorityRecords.sequence)).limit(limit);
    const ids: string[] = [];
    let bytes = 0;
    for (const row of metadata) { bytes += row.bytes; if (bytes > byteBudget) break; ids.push(row.id); }
    if (!ids.length) return { records: [], nextAfter: null };
    const rows = await this.db.select().from(nativeAuthorityRecords).where(and(this.recordScope(epoch, "event"), inArray(nativeAuthorityRecords.recordId, ids))).orderBy(asc(nativeAuthorityRecords.sequence));
    const records: AuthorityRecord[] = [];
    for (const row of rows) records.push(await this.decode(row));
    return { records, nextAfter: records.at(-1)?.sequence ?? null };
  }

  async close(): Promise<void> { /* The application owns the shared pool. */ }
}

/** Read-only recovery can inspect a sealed epoch, but can never reopen it for writes. */
export async function readPostgresAuthority(db: Db, location: import("../../vendor/paperclip-runner/index.js").AuthorityLocation): Promise<AuthoritySnapshot> {
  if (location.kind !== "postgres" || !location.epoch) throw new DurableAuthorityStoreError("invalid_authority", "Postgres locator required");
  const owner = JSON.parse(location.binding) as PostgresAuthorityBinding;
  if (![owner.companyId, owner.issueId, owner.normalizedSessionId, owner.runnerInstanceId, owner.environmentLeaseId].every((value) => typeof value === "string" && value.length > 0)) throw new DurableAuthorityStoreError("invalid_authority", "invalid owner locator");
  const [row] = await db.select().from(nativeSessionAuthorities).where(and(
    eq(nativeSessionAuthorities.companyId, owner.companyId), eq(nativeSessionAuthorities.issueId, owner.issueId),
    eq(nativeSessionAuthorities.normalizedSessionId, owner.normalizedSessionId), eq(nativeSessionAuthorities.runId, location.epoch),
    eq(nativeSessionAuthorities.binding, location.binding),
  ));
  if (!row || row.stateSha256 !== digest(row.state)) throw new DurableAuthorityStoreError("storage_unavailable", "authority snapshot missing or changed");
  const store = new PostgresAuthorityStore(db, { ...owner, runId: location.epoch }, async () => {});
  const state = await materializeCurrentAuthority(JSON.parse(row.state), store.getRecord.bind(store));
  const [current] = await db.select({ generation: nativeSessionAuthorities.generation, stateSha256: nativeSessionAuthorities.stateSha256 }).from(nativeSessionAuthorities).where(and(
    eq(nativeSessionAuthorities.companyId, owner.companyId), eq(nativeSessionAuthorities.normalizedSessionId, owner.normalizedSessionId), eq(nativeSessionAuthorities.runId, location.epoch),
  ));
  if (current?.generation !== row.generation || current.stateSha256 !== row.stateSha256) throw new DurableAuthorityStoreError("stale_authority", "authority changed while resolving current evidence");
  authorityGeneration(row.generation);
  if (row.committedFrom !== null) authorityGeneration(row.committedFrom);
  if (row.generation.startsWith("r:") && row.committedFrom === null) throw new DurableAuthorityStoreError("invalid_authority", "opaque authority commit has no predecessor");
  return { generation: row.generation, ...(row.committedFrom === null ? {} : { committedFrom: row.committedFrom }), state };
}

export function createNativePostgresAuthorityStore(db: Db, owner: PostgresAuthorityBinding, agentId: string, assertWriteFence?: (tx: AuthorityTransaction) => Promise<void>): PostgresAuthorityStore {
  return new PostgresAuthorityStore(db, owner, async (tx, records) => {
    for (const record of records) {
      const envelope = record.body.envelope as { payload?: unknown } | undefined;
      const parsed = validatePrpEvent(envelope?.payload);
      if (!parsed.ok) throw new DurableAuthorityStoreError("invalid_authority", "invalid native event record");
      const event = parsed.event;
      if (event.sourceKind !== "runner" || event.sourceInstanceId !== owner.runnerInstanceId || event.normalizedSessionId !== owner.normalizedSessionId || event.runId !== record.epoch || event.sourceEventId !== record.id || String(event.sourceSeq) !== record.sequence) throw new DurableAuthorityStoreError("invalid_authority", "native event binding mismatch");
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, event.runId), eq(heartbeatRuns.companyId, owner.companyId), eq(heartbeatRuns.nativeIssueId, owner.issueId),
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.nativeSessionId, owner.normalizedSessionId),
        eq(heartbeatRuns.runnerInstanceId, owner.runnerInstanceId), eq(heartbeatRuns.runtimeMode, "native"),
      )).for("update");
      if (!run) throw new DurableAuthorityStoreError("invalid_authority", "native event run is not authorized");
    }
  }, assertWriteFence);
}

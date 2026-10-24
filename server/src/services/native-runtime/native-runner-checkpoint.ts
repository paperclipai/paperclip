import { and, eq, exists, gt, isNull, lte, inArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import { decodeDurablePrpCheckpoint, type DurablePrpCheckpoint, type DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { localEncryptedProvider } from "../../secrets/local-encrypted-provider.js";

type Binding = { companyId: string; issueId: string; runId: string };
type Owner = Binding & { bootId: string; leaseOwner: string; generation: number; authorityRunId: string };
async function encryptPart(binding: Binding, part: string, contents: string) {
  return (await localEncryptedProvider.createVersion({ value: JSON.stringify({ ...binding, part, contents }) })).material;
}

async function decryptPart(binding: Binding, part: string, material: Record<string, unknown>): Promise<string> {
  const envelope = JSON.parse(await localEncryptedProvider.resolveVersion({ material, externalRef: null }));
  if (envelope.companyId !== binding.companyId || envelope.issueId !== binding.issueId
    || envelope.runId !== binding.runId || envelope.part !== part || typeof envelope.contents !== "string") {
    throw new Error("native_runner_checkpoint_binding_mismatch");
  }
  return envelope.contents;
}

export function nativeRunnerCheckpointWriter(db: Db, owner: Owner) {
  let previousWork = new Set<string>();
  return async (checkpoint: DurablePrpCheckpoint): Promise<void> => {
    if (checkpoint.runId !== owner.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
    const changed = await Promise.all([...checkpoint.changedRecords]
      .map(async ([part, value]) => ({ companyId: owner.companyId, issueId: owner.issueId,
        runId: owner.runId, part, material: await encryptPart(owner, part, value) })));
    await db.transaction(async tx => {
      const [owned] = await tx.select({ current: nativeRunFinalizations, now: sql<Date>`clock_timestamp()` }).from(nativeRunFinalizations)
        .where(and(eq(nativeRunFinalizations.companyId, owner.companyId),
          eq(nativeRunFinalizations.issueId, owner.issueId), eq(nativeRunFinalizations.runId, owner.authorityRunId),
          eq(nativeRunFinalizations.controllerBootId, owner.bootId),
          eq(nativeRunFinalizations.controllerGeneration, owner.generation))).for("update");
      if (!owned) throw new Error("native_runner_checkpoint_owner_lost");
      const { current } = owned;
      const activeOwner = current.leaseOwner === owner.leaseOwner
        && current.leaseExpiresAt !== null && current.leaseExpiresAt > new Date(owned.now);
      if (!activeOwner) {
        const newWork = checkpoint.workCommandIds.some(id => !previousWork.has(id));
        const [task] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
          .where(and(eq(issues.companyId, owner.companyId), eq(issues.id, owner.issueId)));
        const [successor] = task?.executionRunId && task.executionRunId !== owner.runId
          ? await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
              eq(nativeRunFinalizations.runId, task.executionRunId), eq(nativeRunFinalizations.companyId, owner.companyId),
              eq(nativeRunFinalizations.issueId, owner.issueId), eq(nativeRunFinalizations.controllerBootId, owner.bootId),
              gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))) : [];
        if (!current.resultId || newWork || !task || (task.executionRunId && task.executionRunId !== owner.runId && !successor)) {
          throw new Error("native_runner_checkpoint_owner_lost");
        }
      }
      if (checkpoint.predecessor) {
        const [prior] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, checkpoint.predecessor.runId), eq(heartbeatRuns.companyId, owner.companyId),
          eq(heartbeatRuns.nativeIssueId, owner.issueId),
          eq(heartbeatRuns.nativeSessionId, checkpoint.predecessor.normalizedSessionId)));
        if (!prior) throw new Error("native_runner_checkpoint_binding_mismatch");
      }
      if (checkpoint.reset) await tx.delete(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.companyId, owner.companyId), eq(nativeRunnerCheckpoints.runId, owner.runId)));
      else if (checkpoint.removedRecords.length) await tx.delete(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.companyId, owner.companyId), eq(nativeRunnerCheckpoints.runId, owner.runId),
        inArray(nativeRunnerCheckpoints.part, [...checkpoint.removedRecords])));
      if (changed.length) await tx.insert(nativeRunnerCheckpoints).values(changed)
        .onConflictDoUpdate({ target: [nativeRunnerCheckpoints.runId, nativeRunnerCheckpoints.part],
          set: { material: sql`excluded.material`, updatedAt: sql`now()` } });
    });
    previousWork = new Set(checkpoint.workCommandIds);
  };
}

const authorities = new WeakMap<DurablePrpControlPlane, Map<string, ReturnType<typeof nativeRunnerCheckpointWriter>>>();

export function nativeRunnerCheckpointPersistence(db: Db, bootId: string, authorityRunId: string,
  detach: (runIds: readonly string[], leaseOwner?: string) => Promise<unknown>) {
  return { db, bootId, authorityRunId, onFailure: async (runId: string, leaseOwner: string) => {
    try { await detach([runId], leaseOwner); }
    finally {
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp()` })
        .where(and(eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.controllerBootId, bootId), eq(nativeRunFinalizations.leaseOwner, leaseOwner),
          isNull(nativeRunFinalizations.resultId)));
    }
  } };
}

export async function registerNativeRunnerCheckpoint(input: {
  db: Db; binding: Binding; bootId: string; authority: DurablePrpControlPlane;
  authorityRunId?: string;
  onFailure?: (runId: string, leaseOwner: string) => Promise<void>;
}): Promise<void> {
  const authorityRunId = input.authorityRunId ?? input.binding.runId;
  const [owner] = await input.db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.binding.companyId),
    eq(nativeRunFinalizations.issueId, input.binding.issueId),
    eq(nativeRunFinalizations.runId, authorityRunId),
    eq(nativeRunFinalizations.controllerBootId, input.bootId),
    gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`)));
  if (!owner?.leaseOwner) throw new Error("native_runner_checkpoint_owner_lost");
  let writers = authorities.get(input.authority);
  if (!writers) {
    writers = new Map();
    const boundWriters = writers;
    input.authority.setCheckpointPersistence(async snapshot => {
      const writer = boundWriters.get(snapshot.runId);
      if (!writer) throw new Error("native_runner_checkpoint_owner_lost");
      await writer(snapshot);
    });
    authorities.set(input.authority, writers);
  }
  if (!writers.has(input.binding.runId)) {
    const write = nativeRunnerCheckpointWriter(input.db, {
      ...input.binding, authorityRunId, bootId: input.bootId, generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner,
    });
    writers.set(input.binding.runId, async checkpoint => {
      try { await write(checkpoint); }
      catch (error) {
        void input.onFailure?.(authorityRunId, owner.leaseOwner!).catch(() => undefined);
        throw error;
      }
    });
  }
  await input.authority.flushCheckpoint();
}

export async function loadNativeRunnerCheckpoint(db: Db, binding: Binding): Promise<DurablePrpCheckpoint | null> {
  const rows = await db.select().from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
    eq(nativeRunnerCheckpoints.runId, binding.runId)));
  if (!rows.length) return null;
  const parts = new Map(await Promise.all(rows.map(async row =>
    [row.part, await decryptPart(binding, row.part, row.material)] as const)));
  const checkpoint = decodeDurablePrpCheckpoint(parts);
  if (checkpoint.runId !== binding.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
  return checkpoint;
}

export async function restoreNativeRunnerCheckpoint(db: Db, binding: Binding, root: string) {
  const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
  if (!checkpoint) return null;
  checkpoint.restoreSessionDirectory(root);
  return checkpoint;
}

export async function hasNativeRunnerCheckpoint(db: Pick<Db, "select">, binding: Binding): Promise<boolean> {
  const [row] = await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
    eq(nativeRunnerCheckpoints.runId, binding.runId))).limit(1);
  return row !== undefined;
}

export async function listExpiredNativeRunnerAuthorities(db: Db, now: Date, runIds: string[]): Promise<string[]> {
  if (!runIds.length) return [];
  const rows = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
    .where(and(inArray(nativeRunFinalizations.runId, runIds),
      eq(heartbeatRuns.status, "running"), eq(nativeRunFinalizations.phase, "observed"),
      isNull(nativeRunFinalizations.resultId),
      or(isNull(nativeRunFinalizations.leaseExpiresAt), lte(nativeRunFinalizations.leaseExpiresAt, now)),
      exists(db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.runId, nativeRunFinalizations.runId),
        eq(nativeRunnerCheckpoints.issueId, nativeRunFinalizations.issueId),
        eq(nativeRunnerCheckpoints.companyId, nativeRunFinalizations.companyId))))))
    .limit(100);
  return rows.map(row => row.runId);
}

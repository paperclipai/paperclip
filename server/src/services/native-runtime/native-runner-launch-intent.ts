import { and, eq, gt, sql } from "drizzle-orm";
import { checkpointDb, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { assertNativeRunnerCheckpointOwner, readNativePreparationPublication } from "./native-runner-checkpoint.js";
import type { NativePreparationPublication } from "./native-preparation-checkpoint.js";
import { inspectPendingBootstrapTicket } from "../../vendor/paperclip-runner/index.js";
import { isDeepStrictEqual } from "node:util";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { assertNativeRemoteLaunchIntent, createNativeRemoteLaunchIntent, NativeRemoteLaunchHandoffError,
  launchNativeRemoteRunnerOnce, readNativeRemoteLaunchReceipt, type NativeRemoteLaunchIntent } from "./native-remote-launch-handoff.js";
import { NATIVE_PREPARATION_HANDOFF_VERSION } from "./native-active-runs.js";

type Scope = { companyId: string; issueId: string; runId: string };
export type NativeRunnerLaunchIntent = Scope & {
  schema: "paperclip.native-runner-launch-intent.v1";
  bootId: string;
  generation: number;
  leaseOwner: string;
  environmentLeaseId: string;
  taskId: string;
  operation: Extract<PluginEnvironmentTaskOperation, { kind: "submit" }>;
};

export function nativeRunnerLaunchMatchesPublication(intent: NativeRunnerLaunchIntent, proof: NativePreparationPublication) {
  const runner = intent.operation.runner, identity = proof.identity;
  return intent.bootId === proof.bootId && intent.generation === proof.generation && intent.leaseOwner === proof.leaseOwner
    && intent.operation.preparedLaunchId === proof.configurationId && intent.runId === identity.runId
    && intent.environmentLeaseId === identity.environmentLeaseId && runner.leaseId === identity.environmentLeaseId
    && runner.runnerId === identity.runnerInstanceId && runner.runId === identity.runId
    && runner.sessionId === identity.normalizedSessionId && runner.turnId === identity.turnId && runner.itemId === identity.itemId;
}

export async function recordNativeRunnerLaunchIntent(db: Db, input: Scope & {
  bootId: string; environmentLeaseId: string; taskId: string; operation: PluginEnvironmentTaskOperation;
}) {
  const operation = environmentTaskOperationSchema.parse(input.operation);
  if (operation.kind !== "submit") throw new Error("native_runner_launch_intent_invalid");
  const [run] = await db.select({ version: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffVersion'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  if (run?.version !== NATIVE_PREPARATION_HANDOFF_VERSION) return;
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.controllerBootId, input.bootId),
    gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
  if (!owner?.leaseOwner) throw new Error("native_runner_checkpoint_owner_lost");
  const intent: NativeRunnerLaunchIntent = { schema: "paperclip.native-runner-launch-intent.v1",
    companyId: input.companyId, issueId: input.issueId, runId: input.runId, bootId: input.bootId,
    generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner,
    environmentLeaseId: input.environmentLeaseId, taskId: input.taskId, operation };
  await checkpointDb(db).transaction(async tx => {
    await assertNativeRunnerCheckpointOwner(tx, { ...input, authorityRunId: input.runId,
      generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner! }, true);
    const publication = await readNativePreparationPublication(tx as unknown as Db, input);
    const prior = await readNativeRunnerLaunchIntent(tx as unknown as Db, input);
    const replay = prior?.environmentLeaseId === input.environmentLeaseId && prior.taskId === input.taskId
      && isDeepStrictEqual(prior.operation, operation);
    if (publication?.kind !== "published" || publication.publication.kind !== "launching"
      || !nativeRunnerLaunchMatchesPublication(intent, publication.publication)
      || !replay && !inspectPendingBootstrapTicket(publication.header, operation.bootstrapTicket)) throw new Error("native_runner_launch_authority_unproven");
    const material = createLocalEncryptedCipher("write").encrypt(JSON.stringify(intent));
    await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeRunnerLaunchIntent: material })}::jsonb` })
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.nativeIssueId, input.issueId)));
  });
}

export async function readNativeRunnerLaunchIntent(db: Pick<Db, "select">, scope: Scope) {
  const [row] = await db.select({ material: sql<Record<string, unknown> | null>`case
    when pg_column_size(${heartbeatRuns.runnerProfileJson}->'nativeRunnerLaunchIntent') <= 1048576
    then ${heartbeatRuns.runnerProfileJson}->'nativeRunnerLaunchIntent' else null end` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
      eq(heartbeatRuns.nativeIssueId, scope.issueId))).limit(1);
  if (!row?.material) return null;
  try {
    const intent = JSON.parse(createLocalEncryptedCipher("read").decrypt(row.material)) as NativeRunnerLaunchIntent;
    if (intent.schema !== "paperclip.native-runner-launch-intent.v1" || intent.companyId !== scope.companyId
      || intent.issueId !== scope.issueId || intent.runId !== scope.runId || !intent.taskId || !intent.environmentLeaseId) return null;
    const operation = environmentTaskOperationSchema.parse(intent.operation);
    if (operation.kind !== "submit") return null;
    return { ...intent, operation };
  } catch { return null; }
}

export async function reconcileNativeRunnerLaunchIntent(db: Db, input: Scope & {
  leaseOwner: string; controllerGeneration: number; environmentLeaseId: string;
  submit: (operation: PluginEnvironmentTaskOperation, options: { expectedTaskId: string }) => Promise<unknown>;
}) {
  const publication = await readNativePreparationPublication(db, input);
  if (publication?.kind !== "published" || publication.publication.kind !== "launching") return;
  const intent = await readNativeRunnerLaunchIntent(db, input);
  if (!intent || intent.environmentLeaseId !== input.environmentLeaseId
    || !nativeRunnerLaunchMatchesPublication(intent, publication.publication)) throw new Error("native_runner_launch_intent_unavailable");
  const [owner] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
    eq(nativeRunFinalizations.controllerGeneration, input.controllerGeneration),
    gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
  if (!owner) throw new Error("native_runner_checkpoint_owner_lost");
  await input.submit(intent.operation, { expectedTaskId: intent.taskId });
}

export type NativeRemoteRunnerLaunchIntent = Scope & {
  schema: "paperclip.native-remote-runner-launch.v1";
  bootId: string; generation: number; leaseOwner: string;
  environmentLeaseId: string; providerLeaseId: string;
  intent: NativeRemoteLaunchIntent; bootstrapTicket: string;
  launchSpec?: RunnerProcessLaunchSpec;
  publication?: { headerSha256: string; cursorSha256: string; partsSha256: string };
};

export async function readNativeRemoteRunnerLaunchIntent(db: Pick<Db, "select">, scope: Scope) {
  const [row] = await db.select({ material: sql<Record<string, unknown> | null>`case
    when pg_column_size(${heartbeatRuns.runnerProfileJson}->'nativeRemoteRunnerLaunchIntent') <= 1048576
    then ${heartbeatRuns.runnerProfileJson}->'nativeRemoteRunnerLaunchIntent' else null end` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
      eq(heartbeatRuns.nativeIssueId, scope.issueId))).limit(1);
  if (!row?.material) return null;
  try {
    const saved = JSON.parse(createLocalEncryptedCipher("read").decrypt(row.material)) as NativeRemoteRunnerLaunchIntent;
    if (saved.schema !== "paperclip.native-remote-runner-launch.v1" || saved.companyId !== scope.companyId
      || saved.issueId !== scope.issueId || saved.runId !== scope.runId || !saved.environmentLeaseId || !saved.providerLeaseId
      || typeof saved.bootstrapTicket !== "string") return null;
    assertNativeRemoteLaunchIntent(saved.intent);
    if (saved.intent.identity.runId !== scope.runId) return null;
    return saved;
  } catch { return null; }
}

export function nativeRemoteLaunchMatchesPublication(saved: NativeRemoteRunnerLaunchIntent, proof: NativePreparationPublication) {
  const publication = saved.publication ?? saved.intent.checkpoint;
  return saved.bootId === proof.bootId && saved.generation === proof.generation && saved.leaseOwner === proof.leaseOwner
    && isDeepStrictEqual(saved.intent.identity, proof.identity)
    && publication.headerSha256 === proof.headerSha256
    && publication.cursorSha256 === proof.cursorSha256
    && publication.partsSha256 === proof.partsSha256;
}

export async function reconcileNativeRemoteRunnerLaunchIntent(db: Db, input: Scope & {
  leaseOwner: string; controllerGeneration: number; environmentLeaseId: string; providerLeaseId: string | undefined;
  remoteCwd: string; identity: Record<string, unknown>; runner: CommandManagedRuntimeRunner; deadline: number;
}) {
  const saved = await readNativeRemoteRunnerLaunchIntent(db, input);
  const publication = await readNativePreparationPublication(db, input);
  if (!saved || saved.environmentLeaseId !== input.environmentLeaseId || saved.providerLeaseId !== input.providerLeaseId
    || saved.intent.remoteCwd !== input.remoteCwd || !isDeepStrictEqual(saved.intent.identity, input.identity)
    || publication?.kind !== "published" || publication.publication.kind !== "launching"
    || !nativeRemoteLaunchMatchesPublication(saved, publication.publication)) {
    throw new NativeRemoteLaunchHandoffError("native_remote_launch_identity_mismatch");
  }
  const [owner] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.controllerBootId, saved.bootId),
    eq(nativeRunFinalizations.leaseOwner, input.leaseOwner), eq(nativeRunFinalizations.controllerGeneration, input.controllerGeneration),
    eq(nativeRunFinalizations.phase, "observed"), sql`${nativeRunFinalizations.resultId} is null`,
    sql`${nativeRunFinalizations.failureCode} is null`, gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
  if (!owner) throw new Error("native_runner_checkpoint_owner_lost");
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, saved.environmentLeaseId),
    eq(environmentLeases.issueId, input.issueId), eq(environmentLeases.heartbeatRunId, input.runId),
    eq(environmentLeases.providerLeaseId, saved.providerLeaseId), eq(environmentLeases.status, "active"),
    sql`${environmentLeases.releasedAt} is null`, sql`${environmentLeases.cleanupStatus} is null`)).limit(1);
  if (!lease) throw new NativeRemoteLaunchHandoffError("native_remote_launch_identity_mismatch");
  const launch = { runner: input.runner, intent: saved.intent, deadline: input.deadline };
  return saved.launchSpec ? launchNativeRemoteRunnerOnce({ ...launch, spec: saved.launchSpec })
    : readNativeRemoteLaunchReceipt(launch);
}

export async function recordNativeRemoteRunnerLaunchIntent(db: Db, input: Scope & {
  bootId: string; environmentLeaseId: string; providerLeaseId?: string;
  remoteCwd: string; remoteBinary: string; processIdentityPath: string; stateDirectory: string; diagnosticsDirectory: string;
  spec: RunnerProcessLaunchSpec;
}): Promise<NativeRemoteLaunchIntent | null> {
  const [run] = await db.select({ version: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffVersion'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  if (run?.version !== NATIVE_PREPARATION_HANDOFF_VERSION) return null;
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.runId, input.runId),
    eq(nativeRunFinalizations.controllerBootId, input.bootId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
  if (!owner?.leaseOwner) throw new Error("native_runner_checkpoint_owner_lost");
  return checkpointDb(db).transaction(async tx => {
    await assertNativeRunnerCheckpointOwner(tx, { ...input, authorityRunId: input.runId,
      generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner! }, true);
    if (await readNativeRemoteRunnerLaunchIntent(tx as unknown as Db, input)) throw new Error("native_remote_launch_requires_exact_adoption");
    const [physical] = await tx.select({ providerLeaseId: environmentLeases.providerLeaseId }).from(environmentLeases).where(and(
      eq(environmentLeases.id, input.environmentLeaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.issueId, input.issueId), eq(environmentLeases.heartbeatRunId, input.runId),
      eq(environmentLeases.status, "active"), sql`${environmentLeases.releasedAt} is null`,
      sql`${environmentLeases.cleanupStatus} is null`)).for("share").limit(1);
    if (!physical?.providerLeaseId || input.providerLeaseId && input.providerLeaseId !== physical.providerLeaseId) {
      throw new Error("native_remote_launch_physical_lease_mismatch");
    }
    const publication = await readNativePreparationPublication(tx as unknown as Db, input), native = input.spec.nativeRunner;
    if (publication?.kind !== "published" || publication.publication.kind !== "launching" || !native
      || !isDeepStrictEqual(publication.publication.identity, native.identity)
      || !inspectPendingBootstrapTicket(publication.header, native.ticket)) throw new Error("native_runner_launch_authority_unproven");
    const proof = publication.publication;
    const intent = createNativeRemoteLaunchIntent({ identity: native.identity,
      checkpoint: { headerSha256: proof.headerSha256, cursorSha256: proof.cursorSha256, partsSha256: proof.partsSha256 },
      remoteCwd: input.remoteCwd, remoteBinary: input.remoteBinary, processIdentityPath: input.processIdentityPath,
      stateDirectory: input.stateDirectory, diagnosticsDirectory: input.diagnosticsDirectory,
      runnerVersion: native.runnerVersion, runnerDigest: native.runnerDigest, spec: input.spec });
    const saved: NativeRemoteRunnerLaunchIntent = { schema: "paperclip.native-remote-runner-launch.v1",
      companyId: input.companyId, issueId: input.issueId, runId: input.runId, bootId: input.bootId,
      generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner!, environmentLeaseId: input.environmentLeaseId,
      providerLeaseId: physical.providerLeaseId, intent, bootstrapTicket: native.ticket,
      launchSpec: { command: input.spec.command, args: [...input.spec.args], cwd: input.spec.cwd,
        environment: { ...input.spec.environment } } };
    const material = createLocalEncryptedCipher("write").encrypt(JSON.stringify(saved));
    await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeRemoteRunnerLaunchIntent: material })}::jsonb` })
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.nativeIssueId, input.issueId)));
    return intent;
  });
}

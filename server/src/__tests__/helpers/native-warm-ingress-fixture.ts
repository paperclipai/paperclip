import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as tables from "@paperclipai/db";
import type { NativeExecutionInputV1, NativeExecutionInputV3 } from "@paperclipai/paperclip-runner";
import { startRecoveryPostgres } from "./recovery-postgres.js";
import { prepareNativeHeartbeatRun } from "../../services/native-runtime/prepare-native-run.js";
import { buildNativeCompletionContract } from "../../services/native-runtime/completion-contracts.js";
import { nativeRuntimeContextFixture } from "../../services/native-runtime/runtime-context.test-fixture.js";

export async function createNativeWarmIngressFixture(base: NativeExecutionInputV1, cwd: string) {
  const database = await startRecoveryPostgres("shared-ingress-owner-");
  const db = tables.createDb(database.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const providerLeaseId = `allocation-${randomUUID()}`;
  await db.insert(tables.companies).values({ id: companyId, name: "Shared ingress", issuePrefix: `I${companyId.slice(0, 7)}` });
  await db.insert(tables.agents).values({ id: agentId, companyId, name: "Shared worker", adapterType: "paperclip_runner" });
  await db.insert(tables.environments).values({ id: environmentId, name: "Shared allocation", driver: "sandbox" });
  await db.insert(tables.executionWorkspaces).values({ id: workspaceId, companyId, name: "Shared workspace", mode: "shared_workspace",
    strategyType: "project_primary", providerType: "cloud_sandbox", cwd });
  const defaultCompanyId = companyId, defaultAgentId = agentId, defaultWorkspaceId = workspaceId, defaultProviderLeaseId = providerLeaseId;
  let epoch = 0;
  async function admit(options?: { companyId?: string; agentId?: string; workspaceId?: string; providerLeaseId?: string }) {
    const ownerCompanyId = options?.companyId ?? defaultCompanyId, ownerAgentId = options?.agentId ?? defaultAgentId;
    const ownerWorkspaceId = options?.workspaceId ?? defaultWorkspaceId, ownerProviderLeaseId = options?.providerLeaseId ?? defaultProviderLeaseId;
    const companyId = ownerCompanyId, agentId = ownerAgentId, workspaceId = ownerWorkspaceId, providerLeaseId = ownerProviderLeaseId;
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    const [issue] = await db.insert(tables.issues).values({ id: issueId, companyId, title: "Shared handoff", status: "in_progress",
      assigneeAgentId: agentId, executionWorkspaceId: workspaceId }).returning();
    const [run] = await db.insert(tables.heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId } }).returning();
    await db.update(tables.issues).set({ executionRunId: runId }).where(eq(tables.issues.id, issueId));
    await db.insert(tables.environmentLeases).values({ id: leaseId, companyId, environmentId, executionWorkspaceId: workspaceId,
      issueId, heartbeatRunId: runId, provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment" });
    await db.insert(tables.nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: leaseId });
    const [contract] = await db.select().from(tables.completionContracts).where(eq(tables.completionContracts.issueId, issueId));
    const execution: NativeExecutionInputV3 = { ...base, schema: "paperclip.native-execution-input.v3", executionMode: "default", planningContext: null,
      runtimeContext: nativeRuntimeContextFixture(), binding: { companyId, agentId, issueId, runId, executionWorkspaceId: workspaceId },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      workspace: { cwd, repoUrl: null, repoRef: null, branchName: null },
      session: { ...base.session, normalizedSessionId: `logical-${issueId}`, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } } };
    await db.update(tables.executionWorkspaces).set({ metadata: { remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: ++epoch, snapshotId: null, source: { kind: "empty" }, writerRunId: runId, dirty: true,
      location: { environmentId, leaseId, providerLeaseId, remoteCwd: cwd },
    } } }).where(eq(tables.executionWorkspaces.id, workspaceId));
    const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", environmentId, leaseId, remoteCwd: cwd,
      effectiveCapabilities: { runnerWebSocketIngress: true } as never,
      sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId } };
    return { execution, target, issueId, runId, leaseId };
  }
  async function settle(owner: Awaited<ReturnType<typeof admit>>, result: Record<string, unknown>) {
    const resultId = randomUUID();
    await db.insert(tables.nativeRunResults).values({ id: resultId, companyId, issueId: owner.issueId, runId: owner.runId,
      completionContractId: owner.execution.completionContract.id, schemaStatus: "accepted", resultJson: result,
      serverFingerprint: randomUUID(), canonicalSha256: randomUUID() });
    await db.update(tables.nativeRunFinalizations).set({ phase: "committed", resultId, leaseOwner: null, leaseExpiresAt: null }).where(eq(tables.nativeRunFinalizations.runId, owner.runId));
    await db.update(tables.heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), nativePhase: "committed", costAccountingPending: false }).where(eq(tables.heartbeatRuns.id, owner.runId));
    await db.update(tables.issues).set({ status: "done", executionRunId: null, checkoutRunId: null }).where(eq(tables.issues.id, owner.issueId));
    await db.update(tables.environmentLeases).set({ status: "expired", cleanupStatus: "success", releasedAt: new Date() }).where(eq(tables.environmentLeases.id, owner.leaseId));
    return resultId;
  }
  return { db, companyId, agentId, environmentId, workspaceId, providerLeaseId, admit, settle, cleanup: () => database.cleanup() };
}

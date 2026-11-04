import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, chatActions, chatConversations, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  chatGitHubReviews, companies, completionContracts, createDb, environmentLeases, environments, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, runIdentityContexts,
  statusDecisionEffects, statusDecisions, toolConnections, workspaceOperations } from "@paperclipai/db";
import { defaultGitHubReviewPolicy, readRemoteWorkspaceAuthority, type EnvironmentLease } from "@paperclipai/shared";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { seedBoundChatAuthorization } from "../../__tests__/helpers/bound-chat-authorization.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "../environment-runtime.js";
import { issueService } from "../issues.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { resumePreservedResultFinalization } from "../preserved-result-finalization.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery } from "../workspace-recovery.js";
import { readSystemRecovery } from "../system-recovery-state.js";
import { readPublishedGitHubReviewCompletionContinuation, resolveExternalChatResponseWaitAuthorization } from "./chat-attachment-reuse.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";
import { prepareNativeWorkspaceSync } from "./native-workspace-sync.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { readPreservedNativeResultFinalization } from "./preserved-native-result-finalization.js";
import { pendingNativeRecoveryNotices, resolveCommittedNativeRecoveryNotices } from "./native-recovery-notices.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
const commitRace = vi.hoisted(() => ({ before: null as null | ((input:
  Parameters<typeof import("./status-decision-committer.js").commitNativeStatusDecision>[0]) => Promise<void>), rejected: [] as string[] }));
vi.mock("./status-decision-committer.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./status-decision-committer.js")>();
  return { ...actual, commitNativeStatusDecision: async (input: Parameters<typeof actual.commitNativeStatusDecision>[0]) => {
    const before = commitRace.before;
    commitRace.before = null;
    await before?.(input);
    try { return await actual.commitNativeStatusDecision(input); }
    catch (error) {
      if (before) commitRace.rejected.push(error instanceof Error ? error.name : "unknown");
      throw error;
    }
  } };
});
vi.mock("../environment-execution-target.js", async importOriginal => ({
  ...await importOriginal<typeof import("../environment-execution-target.js")>(),
  resolveEnvironmentExecutionTarget: async (input: { leaseId?: string }) => targets.get(input.leaseId!)!,
}));

describe("preserved native response wait", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "preserved-native-wait-"));
    temporary = await startEmbeddedPostgresTestDatabase("preserved-native-wait-db-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterEach(() => { commitRace.before = null; commitRace.rejected.length = 0; vi.restoreAllMocks(); });

  type Scenario = "valid" | "legacy" | "blocked_reasserted" | "principal_revoked" | "resource_disabled"
    | "connection_disabled" | "review_head_changed" | "stop" | "cancelled_run" | "cancelled_task"
    | "owner_changed" | "newer_cancelled" | "newer_active" | "incomplete_preservation" | "missing_receipt"
    | "defer_notice" | "http_reconcile" | "existing_assessment" | "commit_stop" | "commit_status" | "commit_identity"
    | "commit_newer" | "commit_principal" | "commit_preservation" | "commit_head" | "commit_cancelled";
  async function recovered(scenario: Scenario = "valid") {
    const f = await seedBoundChatAuthorization(db);
    const prefix = `PW${randomUUID().slice(0, 6)}`;
    await db.update(companies).set({ issuePrefix: prefix }).where(eq(companies.id, f.companyId));
    await db.update(issues).set({ identifier: `${prefix}-1` }).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ identifier: `${prefix}-2` }).where(eq(issues.id, f.otherIssueId));
    const context = { ...f.context, source: "chat:github", issueId: f.issueId,
      wakeCommentId: f.commentId, paperclipWake: { checkedOutByHarness: true,
        externalChatProvider: "github", issue: { id: f.issueId }, commentIds: [f.commentId] } };
    await db.update(chatEndpoints).set({ provider: "github" }).where(eq(chatEndpoints.id, f.endpointId));
    await db.update(chatExternalPrincipals).set({ provider: "github" }).where(eq(chatExternalPrincipals.id, f.principalId));
    await db.update(chatEndpointResources).set({ type: "repository", providerResourceId: "example/repository",
      metadata: { providerRepositoryId: "101" } }).where(eq(chatEndpointResources.id, f.resourceId));
    await db.update(chatConversations).set({ externalThreadId: "github:example/repository:42" })
      .where(eq(chatConversations.id, f.conversationId));
    const contractId = randomUUID(), sourceInstanceId = randomUUID(), identityId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "preserved-wait-test",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        objective: "Review the requested change", criteria: [{ id: "objective", requirement: "Review the change" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, issueId: f.issueId, runtimeMode: "native", status: "running",
      nativeSessionId: f.runId, runnerInstanceId: sourceInstanceId, responsibleUserId: f.userId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: context });
    await db.insert(runIdentityContexts).values({ id: identityId, companyId: f.companyId, runId: f.runId,
      revision: 1, responsibleUserId: f.userId, messageId: f.commentId, cause: "run_admission",
      correlationId: f.runId, status: "accepted", acceptedAt: new Date() });
    await db.update(heartbeatRuns).set({ activeIdentityContextId: identityId }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "in_progress", executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    const head = "b".repeat(40), reviewId = randomUUID();
    await db.insert(chatGitHubReviews).values({ id: reviewId, companyId: f.companyId, endpointId: f.endpointId,
      issueId: f.issueId, runId: f.runId, repositoryId: "101", repository: "example/repository", pullNumber: 42,
      headSha: head, deliveryId: f.deliveryId, configurationRevision: 1, policySnapshot: defaultGitHubReviewPolicy(),
      event: { event: "mention", deliveryId: f.deliveryId, repositoryId: "101", repository: "example/repository",
        pullNumber: 42, title: "Review this change", body: "Review request", baseSha: "a".repeat(40),
        headSha: head, baseBranch: "master", author: { id: "user-1", login: "author", isBot: false },
        sender: { id: "user-1", login: "author" }, draft: false, labels: [] },
      state: "completed", assessment: { reviewedCommit: head, score: 3, complete: true,
        summary: "Review delivered", rationale: "Reviewed the change", findings: [],
        coverage: { reviewedPaths: ["src/example.ts"], omittedPaths: [], limitations: [] } } });
    await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: f.conversationId, kind: "github_review_publication", status: "processed",
      providerActionId: `github_publication:${f.issueId}:assessment:${createHash("sha256").update(JSON.stringify(reviewId)).digest("hex")}` });
    const continuation = await readPublishedGitHubReviewCompletionContinuation({ db, binding: f.binding });
    expect(continuation?.kind).toBe("response_wake");
    expect(await resolveExternalChatResponseWaitAuthorization({ db, binding: f.binding })).toBe("authorized");
    const binding = { ...f.binding, sessionId: f.runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "preserved-wait-test" };
    await new PaperclipControlPlanePort(db, binding).completeRun({
      result: { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "yielded", continuation: continuation! },
      terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "yielded" },
      callerResultId: `${f.runId}:result` });
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    expect(accepted.schemaStatus).toBe("accepted");
    if (scenario === "existing_assessment") {
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, contractId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const assessment = await recordNativeWorkAssessment({ db, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        turnId: accepted.turnId, contractId, contractCanonicalSha256: contract.canonicalSha256,
        resultId: accepted.id, resultCanonicalSha256: accepted.canonicalSha256,
        priorIssueStatus: issue.status, priorStatusVersion: Number(issue.statusVersion), priorDecisionId: issue.lastStatusDecisionId,
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessment: await classifyNativeEvidence({ db,
          companyId: f.companyId, issueId: f.issueId, runId: f.runId, contract: contract.contractJson,
          result: accepted.resultJson.result as Record<string, unknown> }) });
      await db.update(nativeRunFinalizations).set({ assessmentId: assessment.id }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    const host = path.join(root, f.runId, "host"), remote = path.join(root, f.runId, "remote");
    await mkdir(host, { recursive: true }); await writeFile(path.join(host, "existing.txt"), "base\n");
    const [environment] = await db.insert(environments).values({ name: f.runId, driver: "sandbox" }).returning();
    const providerLeaseId = randomUUID();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, environmentId: environment.id, provider: "daytona", providerLeaseId,
      status: "released", cleanupStatus: "success", releasedAt: new Date(), leasePolicy: "retain_on_failure",
      metadata: { remoteCwd: remote, driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true } }).returning();
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test",
      leaseId: lease.id, remoteCwd: remote, timeoutMs: 30_000, runner: { execute: input => new Promise(resolve => {
        const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
          timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
            exitCode: error ? 1 : 0, signal: error?.signal ?? null, timedOut: error?.killed ?? false,
            stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() }));
        child.stdin?.on("error", () => undefined); child.stdin?.end(input.stdin ?? "");
      }) } };
    targets.set(lease.id, target);
    await prepareNativeWorkspaceSync({ db, companyId: f.companyId, workspaceId: f.issueId,
      workspaceLocalDir: host, runId: f.runId, lease: lease as EnvironmentLease, target, resourceDisposition: "keep_running" });
    await writeFile(path.join(remote, "review.txt"), "Original reviewed work\n");
    await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, lease.id));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await recordNativeWorkspaceFinalizationFailure(db, f.runId, { stderrExcerpt: "workspace_sync_out_failed" });
    }
    await issueService(db).clearExecutionRunIfTerminal(f.issueId);
    await issueService(db).clearCheckoutRunIfTerminal(f.issueId);
    const [action] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.status, "active")));
    expect(action).toMatchObject({ status: "active", cause: "native_workspace_sync_out_retry_exhausted", wakePolicy: null });
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", acquireRunLease: vi.fn(),
      releaseRunLease: vi.fn(), resumeRunLease: vi.fn(async () => ({ providerLeaseId, metadata: { remoteCwd: remote } })),
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" as const })) }] });
    const input = { ...f.binding, actionId: action.id, db, environmentRuntime: runtime };
    let replayRecovery: (() => Promise<void>) | undefined;
    if (scenario === "http_reconcile") {
      const [{ default: express }, { default: request }, { issueRoutes }, { errorHandler }] = await Promise.all([
        import("express"), import("supertest"), import("../../routes/issues.js"), import("../../middleware/error-handler.js"),
      ]);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: f.userId, source: "local_implicit", companyIds: [f.companyId], isInstanceAdmin: false };
        next();
      });
      app.use("/api", issueRoutes(db, { provider: "local_disk", putFile: async () => { throw new Error("unused"); },
        getObject: async () => { throw new Error("unused"); }, headObject: async () => ({ exists: false }), deleteObject: async () => {} }));
      app.use(errorHandler);
      const body = { actionId: action.id, runId: f.runId, idempotencyKey: randomUUID() };
      expect((await request(app).post(`/api/issues/${f.issueId}/recovery-actions/recover-workspace`).send(body)).status).toBe(202);
      replayRecovery = async () => {
        const response = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/recover-workspace`).send(body);
        expect(response.status).toBe(202);
        expect(response.body).toMatchObject({ actionId: action.id, status: "recovered" });
      };
    } else await requestWorkspaceRecovery({ ...input, idempotencyKey: randomUUID(), actorId: f.userId });
    await recoverRetainedWorkspace(input);
    const [preserved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(readSystemRecovery(preserved.evidence)?.state).toBe("complete");
    expect(await readFile(path.join(host, "review.txt"), "utf8")).toBe("Original reviewed work\n");
    if (scenario === "legacy") {
      const { workspaceFinalizationBlock: _block, ...evidence } = preserved.evidence;
      await db.update(issueRecoveryActions).set({ evidence }).where(eq(issueRecoveryActions.id, action.id));
    }
    if (scenario === "blocked_reasserted") await issueService(db).update(f.issueId, { status: "blocked" });
    if (scenario === "principal_revoked") await db.update(chatIdentityLinks).set({ status: "revoked" })
      .where(eq(chatIdentityLinks.endpointId, f.endpointId));
    if (scenario === "resource_disabled") await db.update(chatEndpointResources).set({ enabled: false })
      .where(eq(chatEndpointResources.id, f.resourceId));
    if (scenario === "connection_disabled") {
      const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
      await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, endpoint.connectionId));
    }
    if (scenario === "review_head_changed") await db.update(chatGitHubReviews).set({ headSha: "c".repeat(40) })
      .where(eq(chatGitHubReviews.id, reviewId));
    if (scenario === "stop") {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...current.resultJson,
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId: f.companyId,
          issueId: f.issueId, runId: f.runId, scope: "run", dispatchState: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    }
    if (scenario === "cancelled_run") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    if (scenario === "cancelled_task") await issueService(db).update(f.issueId, { status: "cancelled" });
    if (scenario === "owner_changed") {
      const peerId = randomUUID();
      await db.insert(agents).values({ id: peerId, companyId: f.companyId, name: "New owner", adapterType: "paperclip_runner" });
      await db.update(issues).set({ assigneeAgentId: peerId }).where(eq(issues.id, f.issueId));
    }
    if (scenario === "newer_cancelled" || scenario === "newer_active") {
      const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const newerId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: newerId, companyId: f.companyId, issueId: f.issueId,
        agentId: f.agentId, runtimeMode: "legacy", status: scenario === "newer_cancelled" ? "cancelled" : "running",
        createdAt: new Date(original.createdAt.getTime() + 1), contextSnapshot: { issueId: f.issueId } });
      if (scenario === "newer_active") await db.update(issues).set({ executionRunId: newerId }).where(eq(issues.id, f.issueId));
    }
    if (scenario === "incomplete_preservation") await db.update(issueRecoveryActions).set({ evidence: {
      ...preserved.evidence, workspaceRecovery: { ...preserved.evidence.workspaceRecovery as Record<string, unknown>, status: "recovering" },
    } }).where(eq(issueRecoveryActions.id, action.id));
    if (scenario === "missing_receipt") await db.delete(workspaceOperations).where(eq(workspaceOperations.id,
      readSystemRecovery(preserved.evidence)!.preservationOperationIds[0]));
    const denied = ["stop", "cancelled_run", "cancelled_task", "owner_changed", "newer_cancelled", "newer_active",
      "incomplete_preservation", "missing_receipt"].includes(scenario);
    const [beforeIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(!denied);
    if (denied) {
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(beforeIssue);
      expect(await readPreservedNativeResultFinalization(db, f.binding)).toBeNull();
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([accepted]);
      return { ...f, actionId: action.id };
    }
    expect((await readPreservedNativeResultFinalization(db, f.binding))?.statusRestoration)
      .toBe(["legacy", "blocked_reasserted"].includes(scenario) ? "unproven" : "owned");
    let injected = false;
    if (scenario.startsWith("commit_")) commitRace.before = async value => {
      injected = true;
      expect(value.requirePreservedResultFinalization?.statusRestoration).toBe("owned");
      if (scenario === "commit_stop") await db.update(heartbeatRuns).set({ resultJson: { nativeCancellation: { dispatchState: "requested" } } })
        .where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "commit_cancelled") await db.update(heartbeatRuns).set({ status: "cancelled" })
        .where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "commit_status") await issueService(db).update(f.issueId, { status: "blocked" });
      if (scenario === "commit_identity") await db.update(heartbeatRuns).set({ activeIdentityContextId: null }).where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "commit_newer") {
        const newerId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: newerId, companyId: f.companyId, nativeIssueId: f.issueId,
          agentId: f.agentId, runtimeMode: "native", status: "running" });
        await db.update(issues).set({ status: "in_progress", executionRunId: newerId }).where(eq(issues.id, f.issueId));
      }
      if (scenario === "commit_principal") await db.update(chatIdentityLinks).set({ status: "revoked" })
        .where(eq(chatIdentityLinks.endpointId, f.endpointId));
      if (scenario === "commit_preservation") await db.delete(workspaceOperations).where(eq(workspaceOperations.id,
        readSystemRecovery(preserved.evidence)!.preservationOperationIds[0]));
      if (scenario === "commit_head") await db.update(chatGitHubReviews).set({ headSha: "d".repeat(40) })
        .where(eq(chatGitHubReviews.id, reviewId));
    };
    const finalized = ["http_reconcile", "existing_assessment"].includes(scenario)
      ? (await reconcileNativeFinalizations(db, [f.runId], { environmentRuntime: runtime })).find(row => row.runId === f.runId)!
      : await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
          skipNativeRecoveryNotices: scenario === "defer_notice" });
    const [afterFinalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario.startsWith("commit_")) expect(injected).toBe(true);
    expect(finalized.phase, JSON.stringify(afterFinalization.failureDetail)).toBe("committed");
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([accepted]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(scenario === "commit_newer" ? 2 : 1);
    expect(await db.select().from(chatActions).where(eq(chatActions.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    if (scenario.startsWith("commit_")) {
      expect(commitRace.rejected).toEqual(["NativeStatusRaceError"]);
      const [currentIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(currentIssue.status).toBe(scenario === "commit_newer" ? "in_progress" : "blocked");
      expect(currentIssue.lastStatusDecisionId).toBe(beforeIssue.lastStatusDecisionId);
      const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
      expect(decisions).toHaveLength(1);
      expect(decisions[0].reasonCode).not.toBe("external_chat_response_waiting");
      expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decisions[0].id))).toHaveLength(0);
      if (scenario === "commit_newer") expect(currentIssue.executionRunId).not.toBeNull();
      if (scenario === "commit_cancelled") expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("cancelled");
      if (scenario === "commit_stop") expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson?.nativeCancellation)
        .toEqual({ dispatchState: "requested" });
    }
    if (replayRecovery) {
      const [settledIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await replayRecovery();
      await reconcileNativeFinalizations(db, [f.runId], { environmentRuntime: runtime });
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(settledIssue);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual([accepted]);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    }
    return { ...f, actionId: action.id };
  }

  it("restores the same accepted published wait after normal file recovery", async () => {
    const f = await recovered();
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, coordinator.decisionId!));
    expect(decision).toMatchObject({ reasonCode: "external_chat_response_waiting", toStatus: "in_review" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_review");
  }, 60_000);

  it("resolves the exact obsolete exhausted export notice after normal file recovery", async () => {
    const f = await recovered();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0])
      .toMatchObject({ status: "resolved", outcome: "restored" });
  }, 60_000);

  it("accepts HTTP Recover and background finalization once across a repeated receipt", async () => {
    const f = await recovered("http_reconcile");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_review");
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].status).toBe("resolved");
  }, 60_000);

  it("reconciles the failure-owned block after an earlier work assessment", async () => {
    const f = await recovered("existing_assessment");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_review");
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].status).toBe("resolved");
  }, 60_000);

  it.each(["commit_stop", "commit_status", "commit_identity", "commit_newer", "commit_principal", "commit_preservation", "commit_head", "commit_cancelled"] as const)(
    "rechecks %s at the actual status commit", async scenario => { await recovered(scenario); }, 60_000);

  it.each(["legacy", "blocked_reasserted"] as const)("preserves %s status without claiming connector revocation", async scenario => {
    const f = await recovered(scenario);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, coordinator.decisionId!));
    expect(decision).toMatchObject({ reasonCode: "preserved_result_status_unproven", toStatus: "blocked" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
  }, 60_000);

  it.each(["principal_revoked", "resource_disabled", "connection_disabled", "review_head_changed"] as const)(
    "retains the actual current %s gate", async scenario => {
      const f = await recovered(scenario);
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, coordinator.decisionId!));
      expect(decision).toMatchObject({ reasonCode: "external_chat_response_wait_authorization_lost", toStatus: "blocked" });
    }, 60_000);

  it.each(["stop", "cancelled_run", "cancelled_task", "owner_changed", "newer_cancelled", "newer_active",
    "incomplete_preservation", "missing_receipt"] as const)("does not re-enter old finalization with %s", async scenario => {
      await recovered(scenario);
    }, 60_000);

  it("settles only the old notice while newer authorized work owns the task and files", async () => {
    const f = await recovered("defer_notice");
    const newerId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newerId, companyId: f.companyId, nativeIssueId: f.issueId,
      agentId: f.agentId, runtimeMode: "native", status: "running", nativePhase: "observed" });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: newerId,
      phase: "observed", leaseOwner: "current-native-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await db.update(issues).set({ status: "in_progress", executionRunId: newerId, checkoutRunId: newerId })
      .where(eq(issues.id, f.issueId));
    const currentPath = path.join(root, f.runId, "host", "review.txt");
    await writeFile(currentPath, "Newer authorized work\n");
    const [currentIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newerId));
    const [currentOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, newerId));
    expect(await pendingNativeRecoveryNotices(db, f.binding)).toHaveLength(1);
    await resolveCommittedNativeRecoveryNotices(db, f.binding, true);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0])
      .toMatchObject({ status: "resolved", outcome: "restored" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(currentIssue);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newerId)))[0]).toEqual(currentRun);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, newerId)))[0]).toEqual(currentOwner);
    expect(await readFile(currentPath, "utf8")).toBe("Newer authorized work\n");
  }, 60_000);

  it("settles the old notice without changing an explicit later Done decision", async () => {
    const f = await recovered("defer_notice");
    await issueService(db).update(f.issueId, { status: "done" });
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    expect(before.status).toBe("done");
    expect(await pendingNativeRecoveryNotices(db, f.binding)).toHaveLength(1);
    await resolveCommittedNativeRecoveryNotices(db, f.binding, true);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].status).toBe("resolved");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(before);
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId)))[0]).toEqual(result);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 60_000);

  it("settles the old notice when newer committed work supersedes its saved snapshot", async () => {
    const f = await recovered("defer_notice");
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const operationId = readSystemRecovery(action.evidence)!.preservationOperationIds[0];
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operationId));
    const newerId = randomUUID(), snapshotId = randomUUID(), currentSnapshotId = randomUUID();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
    const location = { environmentId: lease.environmentId, leaseId: lease.id, providerLeaseId: lease.providerLeaseId!,
      remoteCwd: path.join(root, f.runId, "remote") };
    await db.insert(heartbeatRuns).values({ id: newerId, companyId: f.companyId, nativeIssueId: f.issueId,
      agentId: f.agentId, runtimeMode: "native", status: "running", nativePhase: "observed" });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      mode: "task", strategyType: "isolated", name: "Retained generations", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId: currentSnapshotId,
        source: { kind: "empty" }, location, writerRunId: newerId, dirty: true } } }).returning();
    expect(readRemoteWorkspaceAuthority(workspace.metadata)?.writerRunId).toBe(newerId);
    const [oldSave, newSave] = await db.insert(workspaceOperations).values([
      { companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId, executionWorkspaceId: workspace.id,
        phase: "workspace_snapshot", status: "succeeded", metadata: { boundary: "final", epoch: 1, generation: 2, snapshotId, sha256: "a".repeat(64) } },
      { companyId: f.companyId, issueId: f.issueId, heartbeatRunId: newerId, executionWorkspaceId: workspace.id,
        phase: "workspace_snapshot", status: "succeeded", metadata: { boundary: "final", epoch: 2, generation: 3,
          snapshotId: currentSnapshotId, sha256: "b".repeat(64) } },
    ]).returning();
    await db.insert(executionWorkspaceSnapshots).values([
      { id: snapshotId, companyId: f.companyId, executionWorkspaceId: workspace.id, sourceOperationId: oldSave.id,
        sourceRunId: f.runId, generation: 2, epoch: 1, status: "superseded", sha256: "a".repeat(64), byteSize: 10 },
      { id: currentSnapshotId, companyId: f.companyId, executionWorkspaceId: workspace.id, sourceOperationId: newSave.id,
        sourceRunId: newerId, parentSnapshotId: snapshotId, generation: 3, epoch: 2, status: "committed", sha256: "b".repeat(64), byteSize: 20 },
    ]);
    await db.update(workspaceOperations).set({ executionWorkspaceId: workspace.id, metadata: { ...operation.metadata,
      storage: "remote_workspace", snapshotId, generation: 2, epoch: 1, sha256: "a".repeat(64) } })
      .where(eq(workspaceOperations.id, operationId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: {
      schema: "paperclip.remote-workspace-run.v1", workspaceId: workspace.id, ...location,
      epoch: 1, state: "saved", snapshotId } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "in_progress", executionRunId: newerId }).where(eq(issues.id, f.issueId));
    const [beforeIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const beforeSnapshots = await db.select().from(executionWorkspaceSnapshots)
      .where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id));
    expect(await pendingNativeRecoveryNotices(db, f.binding)).toHaveLength(1);
    await resolveCommittedNativeRecoveryNotices(db, f.binding, true);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0].status).toBe("resolved");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(beforeIssue);
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id)))[0]).toEqual(workspace);
    expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id)))
      .toEqual(beforeSnapshots);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 60_000);

  it.each(["missing_operation", "foreign_issue", "different_action", "wrong_barrier", "failed_operation",
    "nonarray_operations", "empty_operations"] as const)("retains a notice with %s preservation proof", async scenario => {
      const f = await recovered("defer_notice");
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
      const policy = readSystemRecovery(action.evidence)!;
      const operationId = policy.preservationOperationIds[0];
      if (scenario === "missing_operation") await db.delete(workspaceOperations).where(eq(workspaceOperations.id, operationId));
      if (scenario === "foreign_issue") await db.update(workspaceOperations).set({ issueId: f.otherIssueId })
        .where(eq(workspaceOperations.id, operationId));
      if (scenario === "different_action") {
        const [op] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operationId));
        await db.update(workspaceOperations).set({ metadata: { ...op.metadata, recoveryActionId: randomUUID() } })
          .where(eq(workspaceOperations.id, operationId));
      }
      if (scenario === "wrong_barrier") await db.update(workspaceOperations).set({ metadata: { owningService: "another_service" } })
        .where(and(eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_finalize")));
      if (scenario === "failed_operation") await db.update(workspaceOperations).set({ status: "failed" })
        .where(eq(workspaceOperations.id, operationId));
      if (scenario === "nonarray_operations" || scenario === "empty_operations") await db.update(issueRecoveryActions).set({
        evidence: { ...action.evidence, systemRecovery: { ...policy, preservationOperationIds: scenario === "empty_operations" ? [] : {} } },
      }).where(eq(issueRecoveryActions.id, action.id));
      const [before] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
      expect(await pendingNativeRecoveryNotices(db, f.binding)).toHaveLength(0);
      await resolveCommittedNativeRecoveryNotices(db, f.binding);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0]).toEqual(before);
    }, 60_000);

  it.each(["pending_effect", "failed_effect", "pending_projection", "unknown_old_owner"] as const)(
    "retains the old notice with its own %s", async scenario => {
      const f = await recovered("defer_notice");
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      if (scenario === "pending_effect" || scenario === "failed_effect") await db.insert(statusDecisionEffects).values({
        companyId: f.companyId, issueId: f.issueId, decisionId: coordinator.decisionId!, ordinal: 0,
        effectKind: "release_checkout", targetType: "issue", targetId: f.issueId,
        idempotencyKey: randomUUID(), payload: {}, deliveryState: scenario === "pending_effect" ? "pending" : "failed",
      });
      if (scenario === "pending_projection") await db.update(heartbeatRuns).set({ nativePhase: "workspace_finalizing" })
        .where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "unknown_old_owner") await db.update(heartbeatRuns).set({ status: "running",
        nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" }).where(eq(heartbeatRuns.id, f.runId));
      const [before] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
      expect(await pendingNativeRecoveryNotices(db, f.binding)).toHaveLength(0);
      await resolveCommittedNativeRecoveryNotices(db, f.binding, true);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0]).toEqual(before);
    }, 60_000);
});

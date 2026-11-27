import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatGitHubReviews,
  chatIdentityLinks,
  companies,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { registerGitHubReviewProjectionWork } from "../../services/chat-channels/github/review-projection-work.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { createSystemRecovery } from "../../services/system-recovery-state.js";
import { remoteTerminationReceipt } from "../../services/remote-execution-termination.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { githubReviewCheckService } from "../../services/chat-github-checks.js";
import { githubAutomaticReviewEvent } from "../../services/chat-github-events.js";
import { extractWakeCommentIds, heartbeatService } from "../../services/heartbeat.js";
import { runningProcesses } from "../../adapters/index.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createGitHubReviewHarness } from "./github-review-harness.js";

describeEmbeddedPostgres("chat channels: github review workflow", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rev = createGitHubReviewHarness(h, gh);
  const {
    readIssueCommentsByIssueId,
    readHeartbeatRunsByCompanyId,
    readChatEndpointsById,
    createService,
    deliverMessage,
  } = h;
  const {
    subscribedGitHubFixture,
    reviewBotFixture,
    reviewCheckWorkerFixture,
    reviewProjectionFixture,
  } = rev;

  describe("GitHub agent review workflow", () => {
    it("keeps GitHub review check history quiet and wakes from the real enqueue producer", async () => {
      const f = await reviewCheckWorkerFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        await f.enqueue();
        await expect.poll(async () => (await f.action())?.status, { timeout: 5000 }).toBe("processed");
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }),
          { timeout: 5000 }).toEqual({ active: 0, next: null });
        expect(f.writes).toEqual([expect.objectContaining({ status: "completed" })]);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction");
        onTestFinished(() => { reads.mockRestore(); transactions.mockRestore(); });
        const count = f.requests.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled();
        expect(f.requests).toHaveLength(count);
        reads.mockRestore(); transactions.mockRestore();
        expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("wakes stale GitHub review projection repair from real admission and leaves settled history quiet", async () => {
      const f = await reviewProjectionFixture();
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await registerGitHubReviewProjectionWork(db, coordinator, () => true).ready;
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
          .toEqual({ active: 0, next: null });
        const review = await f.admit();
        await expect.poll(async () => (await f.read(review.id)).state, { timeout: 5000 }).toBe("superseded");
        await f.service.shutdown();
        const [manual] = await db.insert(chatGitHubReviews).values({ ...review, id: randomUUID(),
          deliveryId: "run:" + randomUUID() + ":" + review.headSha, state: "queued" }).returning();
        await expect.poll(() => ({ active: idleWorkSnapshot().active, next: coordinator.nextWakeAt() }), { timeout: 5000 })
          .toEqual({ active: 0, next: null });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update");
        try {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
        } finally { reads.mockRestore(); writes.mockRestore(); vi.useRealTimers(); }
        expect((await f.read(manual.id)).state).toBe("queued"); expect(errors).toEqual([]);
      } finally { await coordinator.stop(); vi.useRealTimers(); }
    });

    it("completes the superseded head's open Paperclip Review check when the pull head moves", async () => {
      const f = await reviewBotFixture();
      const oldHead = "b".repeat(40), newHead = "c".repeat(40);
      const event = githubAutomaticReviewEvent({
        action: "synchronize", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        pull_request: {
          number: 84, title: "Stale check", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" }, head: { sha: oldHead },
          user: { id: 42, login: "octocat", type: "User" }, labels: [],
        },
      }, randomUUID())!;
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Reviewed task", status: "in_progress" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId: f.companyId, agentId: f.assignedAgentId, status: "running",
      }).returning();
      const [review] = await db.insert(chatGitHubReviews).values({
        companyId: f.companyId, endpointId: f.endpoint.id, issueId: issue.id, runId: run.id,
        repositoryId: String(event.repositoryId), repository: event.repository, pullNumber: 84, headSha: oldHead,
        deliveryId: event.deliveryId, configurationRevision: config.revision + 1,
        policySnapshot: config.configuration.defaults, event, state: "running",
      }).returning();
      const externalId = `${f.endpoint.id}:84:${oldHead}`;
      const patches: { id: number; body: Record<string, unknown> }[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/84")) return Response.json({ head: { sha: newHead } });
        if (url.includes(`/commits/${oldHead}/check-runs?`))
          return Response.json({ check_runs: [
            { id: 841, status: "in_progress", external_id: externalId, app: { id: Number(f.endpoint.botExternalId) } },
            { id: 842, status: "completed", external_id: externalId, app: { id: Number(f.endpoint.botExternalId) } },
            { id: 843, status: "in_progress", external_id: externalId, app: { id: 9999 } },
          ] });
        const match = url.match(/\/check-runs\/(\d+)$/);
        if (match && init?.method === "PATCH") {
          patches.push({ id: Number(match[1]), body: JSON.parse(String(init.body)) });
          return Response.json({ id: Number(match[1]) });
        }
        return undefined;
      });
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [activeEndpoint] = await readChatEndpointsById(f.endpoint.id);
      await checks.enqueue(activeEndpoint, event, true, "authorized");
      await checks.processPending();
      const [action] = await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_check"),
      ));
      expect(action).toMatchObject({ status: "cancelled", result: { code: "stale_head" } });
      expect(patches).toEqual([expect.objectContaining({
        id: 841,
        body: expect.objectContaining({
          status: "completed", conclusion: "neutral",
          output: expect.objectContaining({ title: "Superseded by a newer commit" }),
        }),
      })]);
      expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id)))[0].state).toBe("superseded");
    });
    it("leaves a superseded head's open check alone when an assessment lands during the head read", async () => {
      const f = await reviewBotFixture();
      const oldHead = "b".repeat(40), newHead = "c".repeat(40);
      const event = githubAutomaticReviewEvent({
        action: "synchronize", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        pull_request: {
          number: 85, title: "Assessment race", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" }, head: { sha: oldHead },
          user: { id: 42, login: "octocat", type: "User" }, labels: [],
        },
      }, randomUUID())!;
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Reviewed task", status: "in_progress" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId: f.companyId, agentId: f.assignedAgentId, status: "running",
      }).returning();
      const [review] = await db.insert(chatGitHubReviews).values({
        companyId: f.companyId, endpointId: f.endpoint.id, issueId: issue.id, runId: run.id,
        repositoryId: String(event.repositoryId), repository: event.repository, pullNumber: 85, headSha: oldHead,
        deliveryId: event.deliveryId, configurationRevision: config.revision + 1,
        policySnapshot: config.configuration.defaults, event, state: "running",
      }).returning();
      let patches = 0;
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/85")) {
          await db.update(chatGitHubReviews).set({ assessment: {
            reviewedCommit: oldHead, score: 4, complete: true, summary: "Reviewed",
            rationale: "Covered changes", coverage: { reviewedPaths: ["src/a.ts"], omittedPaths: [], limitations: [] }, findings: [],
          } }).where(eq(chatGitHubReviews.id, review.id));
          return Response.json({ head: { sha: newHead } });
        }
        if (url.includes(`/commits/${oldHead}/check-runs?`))
          return Response.json({ check_runs: [
            { id: 851, status: "in_progress", external_id: `${f.endpoint.id}:85:${oldHead}`, app: { id: Number(f.endpoint.botExternalId) } },
          ] });
        const match = url.match(/\/check-runs\/(\d+)$/);
        if (match && init?.method === "PATCH") {
          patches++;
          return Response.json({ id: Number(match[1]) });
        }
        return undefined;
      });
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [activeEndpoint] = await readChatEndpointsById(f.endpoint.id);
      await checks.enqueue(activeEndpoint, event, true, "authorized");
      await checks.processPending();
      expect(patches).toBe(0);
      const [action] = await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_check"),
      ));
      expect(action).toMatchObject({ status: "cancelled", result: { code: "stale_head" } });
      expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id)))[0].state).toBe("running");
    });
    it.each(["snapshot_callback", "snapshot_restart", "snapshot_race", "snapshot_unknown_stop", "snapshot_wrong_allocation", "snapshot_revoked_principal", "snapshot_changed_generation", "snapshot_changed_source", "callback", "restart", "race", "unknown_stop", "wrong_allocation", "paused_endpoint", "revoked_principal", "deleted_comment", "changed_generation", "foreign_scope", "changed_source", "revoked_before_valid"])(
      "reconsiders the same GitHub reply after stopped native workspace cleanup (%s)", async scenario => {
        const snapshotScenario = scenario.startsWith("snapshot_");
        const safetyScenario = snapshotScenario ? scenario.slice("snapshot_".length) : scenario;
        const f = await subscribedGitHubFixture("github:paperclipai/paperclip:419");
        const issueId = f.conversation.issueId!;
        const heartbeat = heartbeatService(db);
        const sourceRunId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
        const capacityRunId = randomUUID(), stoppedAt = new Date(Date.now() - 10_000);
        const initial = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.assignedAgentId)))[0];
        await db.update(agentWakeupRequests).set({ status: "completed", runId: sourceRunId, finishedAt: stoppedAt })
          .where(eq(agentWakeupRequests.id, initial.id));
        await db.update(companies).set({ defaultResponsibleUserId: "owner-user" }).where(eq(companies.id, f.companyId));
        await db.update(agents).set({ adapterType: "paperclip_runner", status: "running",
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.assignedAgentId));
        await db.insert(heartbeatRuns).values({ id: capacityRunId, companyId: f.companyId, agentId: f.assignedAgentId,
          status: "running", contextSnapshot: { issueId: randomUUID() } });
        runningProcesses.set(capacityRunId, { child: {} as never, graceSec: 0, processGroupId: null });
        onTestFinished(() => { runningProcesses.delete(capacityRunId); });
        await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.assignedAgentId,
          status: "cancelled", startedAt: new Date(stoppedAt.getTime() - 1000), finishedAt: stoppedAt,
          runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed",
          contextSnapshot: { issueId, source: "chat:github", wakeCommentIds: [initial.payload?.commentId] },
          resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [leaseId] } },
        });
        await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId,
          runId: sourceRunId, phase: "terminal_failure" });
        await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, issueId,
          heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
          status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "ephemeral" });
        await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId,
          kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
          cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Retained workspace repair",
          evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" },
            workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [leaseId] },
            workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: sourceRunId,
              status: "recovered", stage: "saving_receipts", attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] },
            systemRecovery: { ...createSystemRecovery(sourceRunId), state: "complete", phase: "reconcile_effects" },
          },
        });
        if (snapshotScenario) {
          const { workspaceOperations } = await import("@paperclipai/db");
          await db.update(heartbeatRuns).set({ status: "failed", errorCode: "execution_finalization_deadline_exceeded",
            runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
              descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
              workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/workspace", resourceDisposition: "destroy" } },
          }).where(eq(heartbeatRuns.id, sourceRunId));
          const [recovery] = await db.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
            eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation"),
          ));
          const prefix = `${f.companyId}/workspace-recovery/${sourceRunId}/${leaseId}/`;
          const [snapshot] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId, heartbeatRunId: sourceRunId,
            phase: "workspace_recovery_snapshot", status: "succeeded", finishedAt: new Date(), metadata: {
              schema: "paperclip.workspace-recovery-snapshot.v1", recoveryActionId: recovery.id, leaseId, providerLeaseId,
              archive: { objectKey: `${prefix}${"c".repeat(64)}.tar`, sha256: "c".repeat(64), byteSize: 1024 },
              manifest: { objectKey: `${prefix}${"d".repeat(64)}.jsonl`, sha256: "d".repeat(64), byteSize: 512 },
            } }).returning();
          await db.update(issueRecoveryActions).set({ evidence: { ...recovery.evidence, systemRecovery: {
            ...recovery.evidence.systemRecovery as Record<string, unknown>, preservationOperationIds: [snapshot.id],
          } } }).where(eq(issueRecoveryActions.id, recovery.id));
          await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId,
            kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
            cause: "execution_finalization_deadline_exceeded", fingerprint: randomUUID(), nextAction: "Inspect prior failure",
            evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" } },
          });
          const previousLease = { id: randomUUID(), companyId: f.companyId, issueId, heartbeatRunId: sourceRunId,
            provider: "daytona", providerLeaseId: randomUUID(), status: "expired", cleanupStatus: "success",
            releasedAt: new Date(), leasePolicy: "ephemeral" };
          await db.insert(environmentLeases).values({ ...previousLease, metadata: { remoteExecutionTermination:
            remoteTerminationReceipt(previousLease, { providerLeaseId: previousLease.providerLeaseId, state: "destroyed" }) } });
        }
        f.wakeup.mockImplementation(heartbeat.wakeup);
        await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
          trigger: "subscribed_message", message: makeMessage({ id: "41903", text: "A genuinely new author reply after Stop",
            userId: "42", userName: "octocat" }) });
        const comment = (await readIssueCommentsByIssueId(issueId)).find(row => row.body.includes("genuinely new author reply"))!;
        const [receipt] = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.assignedAgentId)))
          .filter(row => row.id !== initial.id);
        expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null,
          payload: { executionWait: { reason: "remote_cleanup" } } });
        if (snapshotScenario) await db.update(heartbeatRuns).set({
          resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
            schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } },
        }).where(eq(heartbeatRuns.id, sourceRunId));
        let nextReceipt: typeof receipt | undefined;
        let nextCommentId: string | undefined;
        if (safetyScenario === "revoked_before_valid") {
          const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:419:rc:4332012267" }).thread;
          const { id: _id, ...conversation } = f.conversation;
          await db.insert(chatConversations).values({ ...conversation, externalThreadId: thread.id });
          await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
            trigger: "subscribed_message", message: makeMessage({ id: "41904", text: "A live source behind the deleted source",
              userId: "42", userName: "octocat" }) });
          nextCommentId = (await readIssueCommentsByIssueId(issueId)).find(row => row.body.includes("live source behind"))!.id;
          nextReceipt = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.assignedAgentId)))
            .find(row => row.id !== initial.id && row.id !== receipt.id);
          expect(nextReceipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
          await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
        }
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        if (safetyScenario !== "unknown_stop") await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success",
          releasedAt: new Date(), metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease,
            { providerLeaseId: safetyScenario === "wrong_allocation" ? randomUUID() : providerLeaseId, state: "destroyed" }) } })
          .where(eq(environmentLeases.id, leaseId));
        if (safetyScenario === "paused_endpoint") await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpoint.id));
        if (safetyScenario === "revoked_principal") await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() })
          .where(eq(chatIdentityLinks.principalId, f.principal.id));
        if (safetyScenario === "deleted_comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));
        if (safetyScenario === "changed_generation") await db.update(chatConversations).set({ sessionGeneration: 2 }).where(eq(chatConversations.id, f.conversation.id));
        if (safetyScenario === "changed_source") {
          const [action] = await db.select().from(chatActions).where(eq(chatActions.id, receipt.id));
          await db.update(chatActions).set({ payload: { ...action.payload, commentId: initial.payload?.commentId } })
            .where(eq(chatActions.id, action.id));
        }
        if (safetyScenario === "restart") {
          await f.service.shutdown();
          // Fresh application owner and scheduler must recover from saved data,
          // with no in-memory request object left in the retired chat service.
          createService(new FakeChatSdkRuntime(), f.providerFetch, { wakeup: heartbeatService(db).wakeup });
        }
        const source = (await readHeartbeatRunsByCompanyId(f.companyId)).find(row => row.id === sourceRunId)!;
        const { resumeDeferredChatWake } = await import("../../services/durable-chat-wakeup.js");
        if (safetyScenario === "foreign_scope") await resumeDeferredChatWake(db, { companyId: randomUUID(), agentId: f.assignedAgentId,
          issueId, requestId: receipt.id });
        else if (safetyScenario === "callback" || safetyScenario === "revoked_before_valid") await heartbeat.resumeRemoteStopComments(source);
        else if (safetyScenario === "race") await Promise.all([heartbeat.resumeRemoteStopComments(source), heartbeat.resumeQueuedRuns()]);
        else await heartbeatService(db).resumeQueuedRuns();
        const [settled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
        const successors = (await readHeartbeatRunsByCompanyId(f.companyId)).filter(row => row.wakeupRequestId === receipt.id);
        const admitted = ["callback", "restart", "race"].includes(safetyScenario);
        const sourceGone = { deleted_comment: "authority_source_comment", changed_generation: "authority_conversation_binding",
          changed_source: "authority_source_shape" }[safetyScenario as "deleted_comment" | "changed_generation" | "changed_source"];
        expect(successors).toHaveLength(admitted ? 1 : 0);
        expect(settled).toMatchObject({ id: receipt.id, idempotencyKey: receipt.idempotencyKey,
          requestedByActorId: receipt.requestedByActorId, requestedAt: receipt.requestedAt,
          status: admitted ? "queued" : sourceGone ? "skipped" : "deferred_issue_execution",
          ...(sourceGone ? { error: sourceGone, runId: null } : {}) });
        if (admitted) {
          expect(extractWakeCommentIds(successors[0].contextSnapshot)).toEqual([comment.id]);
          expect(successors[0].contextSnapshot?.chatConversationId).toBe(f.conversation.id);
          expect(successors[0].retryOfRunId).toBeNull();
          if (snapshotScenario) expect(successors[0].contextSnapshot?.explicitUserContinuation).toMatchObject({
            previousRunId: sourceRunId, commentId: comment.id,
            readiness: { mode: "fresh_isolated_workspace", retryIntentId: receipt.id, sourceRunId },
          });
          await heartbeat.resumeRemoteStopComments(source);
          await heartbeat.resumeQueuedRuns();
          expect((await readHeartbeatRunsByCompanyId(f.companyId)).filter(row => row.wakeupRequestId === receipt.id)).toHaveLength(1);
        }
        if (nextReceipt) {
          const admittedBehindRevoked = (await readHeartbeatRunsByCompanyId(f.companyId)).filter(row => row.wakeupRequestId === nextReceipt.id);
          expect(admittedBehindRevoked).toHaveLength(1);
          expect(extractWakeCommentIds(admittedBehindRevoked[0].contextSnapshot)).toEqual([nextCommentId]);
        }
        expect((await readHeartbeatRunsByCompanyId(f.companyId)).find(row => row.id === sourceRunId))
          .toMatchObject({ status: snapshotScenario ? "failed" : "cancelled", resultJson: { workspaceRestoreFailure: "restore_failed" } });
      }, 40_000,
    );

    it("stops GitHub review check HTTP after shutdown admission and recovers its durable action", async () => {
      const f = await reviewCheckWorkerFixture();
      await f.enqueue();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
      const guardedProvider: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/pulls/418")) { entered(); await hold; }
        return f.providerFetch(input, init);
      };
      const errors: unknown[] = [];
      let coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        const starting = githubReviewCheckService(db, guardedProvider).registerCheckWork(coordinator, () => true).ready;
        await ready;
        const stopped = coordinator.stop(); release(); await stopped; await starting;
        expect(f.writes).toEqual([]); expect((await f.action()).status).toBe("received");
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
        await f.checks.registerCheckWork(coordinator, () => true).ready;
        await expect.poll(async () => (await f.action()).status, { timeout: 5000 }).toBe("processed");
        expect(f.writes).toHaveLength(1); expect(errors).toEqual([]);
      } finally { release(); await coordinator.stop(); }
    });
  });
});

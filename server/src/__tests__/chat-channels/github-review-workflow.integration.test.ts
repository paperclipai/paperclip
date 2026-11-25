import { chatHistoryActionBlocks } from "../helpers/chat-history-proof.js";
import { registerGitHubReviewProjectionWork } from "../../services/chat-channels/github/review-projection-work.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { createSystemRecovery } from "../../services/system-recovery-state.js";
import { remoteTerminationReceipt } from "../../services/remote-execution-termination.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { toolInvocations, toolPolicies } from "@paperclipai/db";
import { githubChatManagementService } from "../../services/chat-github-management.js";
import { githubChatReviewService } from "../../services/chat-github-reviews.js";
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
import { githubReviewCheckService } from "../../services/chat-github-checks.js";
import { githubAutomaticReviewEvent } from "../../services/chat-github-events.js";
import { githubBotToolsForSession } from "../../services/chat-github-tools.js";
import { buildPaperclipRuntimeMcpServers } from "../../services/heartbeat/run-preparation.js";
import { createAssignedMcpTools } from "../../services/native-runtime/assigned-mcp-tools.js";
import { createToolGatewayService } from "../../services/tool-gateway.js";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { chatGitHubReviews } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { and, asc, eq, or } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatPublications, companies, companySkills, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, environmentLeases, workspaceOperations } from "@paperclipai/db";
import type { Thread } from "chat";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { enqueueChatRunMilestones, githubRunReplyState } from "../../services/chat-run-publications.js";
import { extractWakeCommentIds, heartbeatService } from "../../services/heartbeat.js";
import { resolveRunScopedMentionedSkillKeys } from "../../services/heartbeat/run-preparation.js";
import { registerServerAdapter, runningProcesses, unregisterServerAdapter } from "../../adapters/index.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";

describeEmbeddedPostgres("chat channels: github review workflow", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const { seedCompany, readChatConversationsByEndpointId, readChatEndpointsById, readIssueCommentsByIssueId, readIssuesById, readChatActionsById, readChatGitHubReviewsByEndpointId, readHeartbeatRunsByCompanyId, createService, chatWakeContext, deliverMessage } = h;
  const { signedGitHubWebhookRequest, configuredGitHubEndpoint } = gh;

  describe("GitHub agent review workflow", () => {
    async function reviewBotFixture() {
      const fixture = await seedCompany();
      const context = await configuredGitHubEndpoint(fixture, {}, true);
      const endpoint = await context.service.get(context.endpoint.id);
      const [principal] = await db
        .insert(chatExternalPrincipals)
        .values({
          companyId: fixture.companyId,
          provider: "github",
          providerAccountId: endpoint.providerAccountId!,
          externalId: "42",
          kind: "user",
          displayName: "Octocat",
          handle: "octocat",
          isBot: false,
        })
        .returning();
      await db.insert(chatIdentityLinks).values({
        companyId: fixture.companyId,
        endpointId: endpoint.id,
        principalId: principal.id,
        paperclipUserId: "owner-user",
        status: "linked",
        confirmedAt: new Date(),
      });
      const management = githubChatManagementService(db, context.providerFetch);
      const initial = await management.configuration(endpoint.id, "owner-user");
      await management.saveConfiguration(
        endpoint.id,
        {
          expectedRevision: initial.revision,
          configuration: { ...initial.configuration, toolsEnabled: true },
        },
        "owner-user",
      );
      await context.service.update(
        endpoint.id,
        { allowGroupChats: true },
        "owner-user",
      );
      return { ...fixture, ...context, endpoint, principal, management };
    }
    async function subscribedGitHubFixture(threadId = "github:paperclipai/paperclip:issue:419") {
      const f = await reviewBotFixture();
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: threadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41901", text: `@${f.endpoint.botUsername} start this thread`, userId: "42", userName: "octocat", mentioned: true }) });
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      return { ...f, thread, conversation };
    }
    async function addPeerGitHubBot(f: Awaited<ReturnType<typeof reviewBotFixture>>) {
      const peer = await f.service.create(f.companyId, { provider: "github", assignedAgentId: f.assignedAgentId, name: "Gonzo" }, "owner-user");
      await db.update(chatEndpoints).set({ botUsername: "gonzo[bot]", status: "active" }).where(eq(chatEndpoints.id, peer.id));
      return peer;
    }

    async function toolReplyFixture(threadId = "github:paperclipai/paperclip:issue:418", reportOnly = false, findingCategories?: string[]) {
      const f = await reviewBotFixture();
      if (reportOnly || findingCategories) {
        const config = await f.management.configuration(f.endpoint.id, "owner-user");
        await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
          configuration: { ...config.configuration, defaults: { ...config.configuration.defaults, ...(reportOnly ? { ratingThreshold: null } : {}), ...(findingCategories ? { findingCategories } : {}) } },
        }, "owner-user");
      }
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: threadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41801", text: "Are you there?", userId: "42", userName: "octocat", mentioned: true }) });
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: conversation.issueId, provider: "github", providerMessageId: "41801",
        }) }).returning();
      const session = { companyId: f.companyId, agentId: f.assignedAgentId, issueId: conversation.issueId, runId: run.id };
      return { ...f, conversation, run, session };
    }

    async function publicationRetryFixture(findingCategories?: string[]) {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418", true, findingCategories);
      const head = "b".repeat(40);
      const inline: Array<{ id: number; body: string; html_url: string; user: { login: string } }> = [];
      const checks: Array<{ id: number; external_id: string; app: { id: number }; html_url: string }> = [];
      const writes: Array<{ path: string; method: string }> = [];
      const provider = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/pulls/418/comments?")) return Response.json(inline);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: checks });
        if (init?.method === "POST" && url.endsWith("/pulls/418/comments")) {
          writes.push({ path: url, method: init.method });
          const item = { id: 420 + inline.length, body: JSON.parse(String(init.body)).body,
            html_url: "https://github.com/acme/repo/pull/418#discussion_r420", user: { login: f.endpoint.botUsername! } };
          inline.push(item);
          return Response.json(item);
        }
        if (url.includes("/check-runs") && init?.method) {
          writes.push({ path: url, method: init.method });
          const body = JSON.parse(String(init.body));
          const check = checks[0] ?? { id: 419, external_id: body.external_id, app: { id: Number(f.endpoint.botExternalId) }, html_url: "https://github.com/checks/419" };
          if (!checks.length) checks.push(check);
          return Response.json(check);
        }
        return undefined;
      };
      f.setSupplementalProviderFetch(provider);
      const service = githubChatReviewService(db, f.providerFetch);
      await service.execute(f.session, "begin_review", { reviewedCommit: head });
      const assessment = { reviewedCommit: head, score: 3, complete: true, summary: "Advisory review", rationale: "Reviewed the file",
        coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] }, findings: [] };
      const action = async () => (await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication"),
      )))[0];
      return { ...f, service, head, assessment, provider, action, inline, checks, writes };
    }

    const passiveWait = (key: string) => ({ status: "succeeded" as const, runtimeMode: "native" as const, nativePhase: "committed", resultJson: {
      finalizationPhase: "committed", finalizationReasonCode: "external_chat_response_waiting",
      nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
        continuation: { kind: "response_wake", idempotencyKey: key } },
      presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none",
        commentAction: "none", reasonCodes: ["yielded_control_plane_wait"] } } });

    async function reviewCheckWorkerFixture(status: "running" | "failed" = "failed") {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      const event = githubAutomaticReviewEvent({ action: "opened", repository: { id: 97531, full_name: "paperclipai/paperclip" }, sender: { id: 42, login: "octocat" },
        pull_request: { number: 418, title: "Review", body: "", draft: false, base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) }, user: { id: 42, login: "octocat" }, labels: [] } }, randomUUID())!;
      const [review] = await db.insert(chatGitHubReviews).values({ companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId!, runId: f.run.id, repositoryId: "97531", repository: event.repository, pullNumber: 418, headSha: event.headSha,
        deliveryId: event.deliveryId, configurationRevision: config.revision, policySnapshot: config.configuration.defaults, event }).returning();
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
      const writes: Record<string, unknown>[] = [], requests: string[] = [];
      let remoteHead = event.headSha, unavailable = false;
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) { requests.push(url); return Response.json({ head: { sha: remoteHead } }); }
        if (url.includes("/check-runs?")) { requests.push(url); return Response.json({ check_runs: [] }); }
        if (url.endsWith("/check-runs") && init?.method === "POST") {
          requests.push(url);
          if (unavailable) return Response.json({ message: "injected check outage" }, { status: 503 });
          writes.push(JSON.parse(String(init.body)));
          return Response.json({ id: 418, html_url: "https://github.com/checks/418" });
        }
        return undefined;
      });
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      const action = async () => (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "github_review_check"))))[0];
      return { ...f, event, review, endpoint, checks, writes, requests, action,
        enqueue: () => checks.enqueue(endpoint, event, true, "authorized"),
        setRemoteHead: (value: string) => { remoteHead = value; }, setUnavailable: (value: boolean) => { unavailable = value; } };
    }

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

    async function reviewProjectionFixture(cancelFirst = true) {
      const f = await reviewBotFixture();
      const deliveryId = randomUUID();
      const payload = { action: "synchronize", installation: { id: 2468 },
        repository: { id: 97531, full_name: "paperclipai/paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
        sender: { id: 42, login: "octocat" },
        pull_request: { number: 82, title: "Rapid pushes", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" }, head: { sha: "b".repeat(40) },
          user: { id: 42, login: "octocat", type: "User" }, labels: [] } };
      f.setSupplementalProviderFetch(async input => String(input).endsWith("/pulls/82")
        ? Response.json({ ...payload.pull_request, head: { sha: "c".repeat(40) } }) : undefined);
      const checks = githubReviewCheckService(db, f.providerFetch);
      const [endpoint] = await readChatEndpointsById(f.endpoint.id);
      const event = githubAutomaticReviewEvent(payload, deliveryId)!;
      await checks.enqueue(endpoint, event, true, "authorized");
      const action = async () => (await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, endpoint.id), eq(chatActions.kind, "github_review_check"))))[0];
      if (cancelFirst) await checks.processPending();
      const admit = async () => {
        expect((await f.service.handleWebhook(endpoint.publicId, "github", signedGitHubWebhookRequest({
          event: "pull_request", delivery: deliveryId, payload, webhookSecret: f.webhookSecret,
        }))).status).toBeLessThan(300);
        await expect.poll(async () => (await readChatGitHubReviewsByEndpointId(endpoint.id)).length,
          { timeout: 10_000 }).toBe(1);
        return (await readChatGitHubReviewsByEndpointId(endpoint.id))[0];
      };
      const read = async (id: string) => (await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, id)))[0];
      return { ...f, endpoint, event, action, checks, admit, read };
    }

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

    it("loads only the current configured instruction skills, never provider links or another company", async () => {
      const f = await reviewBotFixture();
      const other = await seedCompany();
      const skill = async (name: string, companyId = f.companyId) => db.insert(companySkills).values({
        companyId, key: `company/${companyId}/${name}`, slug: name, name, markdown: `# ${name}`,
      }).returning().then((rows) => rows[0]);
      const common = await skill("common");
      const mention = await skill("mention");
      const next = await skill("next");
      const injected = await skill("injected");
      const foreign = await skill("foreign", other.companyId);
      // Use the production link format, including the slash picker identity.
      const { buildSkillMentionHref } = await import("@paperclipai/shared");
      const ref = (s: typeof common) => `[/skill](${buildSkillMentionHref(s.id, s.slug)})`;
      const saved = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision, configuration: {
        ...saved.configuration, defaults: { ...saved.configuration.defaults,
          instructions: `Use ${ref(common)}.`,
          prompts: { ...saved.configuration.defaults.prompts, mention: `Use ${ref(mention)}.`, opened: ref(injected) },
        },
      } }, "owner-user");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: "github:paperclipai/paperclip:issue:419" }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41901", text: `@${f.endpoint.botUsername} ${ref(injected)}`, userId: "42", userName: "octocat", mentioned: true }) });
      const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
      const [comment] = await readIssueCommentsByIssueId(conversation.issueId!);
      const args = { db, companyId: f.companyId, issueId: conversation.issueId!, commentIds: [comment.id] };
      expect(await resolveRunScopedMentionedSkillKeys(args)).toEqual([common.key, mention.key]);
      expect(comment.body).toContain(ref(common));
      expect(comment.body).toContain(ref(mention));
      expect(comment.body).toContain(ref(injected)); // Present as untrusted context, never assigned.
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, companyId: other.companyId })).toEqual([]);
      const changed = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: changed.revision, configuration: {
        ...changed.configuration, defaults: { ...changed.configuration.defaults, instructions: ref(next),
          prompts: { ...changed.configuration.defaults.prompts, comment: "Answer briefly." },
        },
      } }, "owner-user");
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41902", text: ref(injected), userId: "42", userName: "octocat" }) });
      const all = await readIssueCommentsByIssueId(conversation.issueId!).orderBy(asc(issueComments.createdAt));
      expect(all).toHaveLength(2);
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, commentIds: [all[1].id] })).toEqual([next.key]);
      // A later event must not change the snapshot for a queued older wake.
      expect(await resolveRunScopedMentionedSkillKeys(args)).toEqual([common.key, mention.key]);
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, commentIds: all.map((c) => c.id) })).toEqual(expect.arrayContaining([common.key, mention.key, next.key]));
      expect(await resolveRunScopedMentionedSkillKeys({ ...args, commentIds: [] })).toEqual([next.key]);
      const invalid = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: invalid.revision, configuration: {
        ...invalid.configuration, defaults: { ...invalid.configuration.defaults, instructions: ref(foreign) },
      } }, "owner-user");
      // Instructions are captured on admission; changing configuration must
      // not change the already admitted wake above.
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41903", text: 'Check again', userId: "42", userName: "octocat" }) });
      await expect(resolveRunScopedMentionedSkillKeys({ ...args, commentIds: [] })).rejects.toThrow("referenced skill is unavailable");
    });

    it.each([
      "github:paperclipai/paperclip:issue:419",
      "github:paperclipai/paperclip:419",
      "github:paperclipai/paperclip:419:rc:41899",
    ])("suppresses subscribed GitHub comments for another connected bot in %s", async threadId => {
      const f = await subscribedGitHubFixture(threadId);
      await addPeerGitHubBot(f);
      const wakeCount = f.wakeup.mock.calls.length;
      const message = makeMessage({ id: "41902", text: "@GONZO[bot] tell me a joke", userId: "42", userName: "octocat" });
      const send = () => deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread, trigger: "subscribed_message", message });
      await send(); await send();
      const rows = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.providerEventId, `${threadId}:41902`)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "filtered", principalId: null, redactedError: "GitHub message explicitly addresses a different recipient" });
      expect(rows[0].normalizedEvent).toHaveProperty("filtering.contentRetained", false);
      expect(JSON.stringify(rows[0].normalizedEvent)).not.toContain("tell me a joke");
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(1);
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
      expect(f.runtime.endpoints.get(f.endpoint.id)?.reactions).toEqual([]);
      expect(f.responseWrites).toHaveLength(1);
      expect(await f.service.listActivity(f.endpoint.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "filtered", detail: "GitHub message explicitly addresses a different recipient" }),
      ]));
    });

    it("admits a GitHub request explicitly addressed to both connected bots", async () => {
      const f = await subscribedGitHubFixture();
      await addPeerGitHubBot(f);
      const wakeCount = f.wakeup.mock.calls.length;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
        trigger: "mention", message: makeMessage({ id: "41902", text: `@gonzo @${f.endpoint.botUsername} both help`, userId: "42", userName: "octocat", mentioned: true }) });
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(2);
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount + 1);
    });

    it("returns snapshot finding categories and publishes only accepted categories", async () => {
      const categories = ["custom-reliability"];
      const f = await publicationRetryFixture(categories);
      const begin = await f.service.execute(f.session, "begin_review", { reviewedCommit: f.head });
      expect(begin).toMatchObject({ findingCategories: categories });
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: config.revision,
        configuration: { ...config.configuration, defaults: { ...config.configuration.defaults, findingCategories: ["new-category"] } },
      }, "owner-user");
      expect(await f.service.execute(f.session, "begin_review", { reviewedCommit: f.head }))
        .toMatchObject({ findingCategories: categories });
      const finding = { key: "one", path: "src/math.ts", line: 1, side: "RIGHT", severity: "error", category: "invented", body: "Concrete issue" };
      await expect(f.service.execute(f.session, "submit_review", { ...f.assessment, findings: [finding] }, "bad-category"))
        .rejects.toThrow('Accepted finding categories: ["custom-reliability"]');
      expect(await f.action()).toBeUndefined();
      const result = await f.service.execute(f.session, "submit_review", { ...f.assessment,
        findings: [{ ...finding, category: categories[0] }],
      }, "accepted-category");
      expect(result).toMatchObject({ status: "processed" });
      const [review] = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      expect(review.assessment?.findings[0].category).toBe(categories[0]);
      expect((await f.action()).status).toBe("processed");
      expect(await chatHistoryActionBlocks(db, (await f.action()).id)).toBe(false);
      expect(f.responseComments.size).toBe(1);
    });

    it("publishes one score heading when a newly configured bot submits a formatted summary", async () => {
      const f = await publicationRetryFixture();
      await db.update(chatEndpoints).set({ botDisplayName: "Fresh Review Bot" }).where(eq(chatEndpoints.id, f.endpoint.id));
      const submit = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      expect(submit.parametersSchema).toMatchObject({ properties: {
        summary: { description: expect.stringContaining("Review body only") },
        rationale: { description: expect.stringContaining("Do not repeat the summary") },
      } });
      const assessment = { ...f.assessment, summary: "## Fresh Review Bot — 2/5\n\n## Fresh Review Bot — 3/5\n\nAdvisory review\n\n### Findings\n\nKeep this section." };
      const result = await f.service.execute(f.session, "submit_review", assessment, "formatted-summary");
      expect(result).toMatchObject({ status: "processed", score: 3 });
      const body = [...f.responseComments.values()][0].body;
      expect(body).toMatch(/^## Fresh Review Bot — 3\/5\n\nAdvisory review/);
      expect(body.match(/^## Fresh Review Bot — /gm)).toHaveLength(1);
      expect(body).toContain("### Findings\n\nKeep this section.");
      expect(body).toContain(f.assessment.rationale);
      expect(body).toContain(`Reviewed commit: \`${f.head}\``);
      expect(f.responseComments.size).toBe(1);
      const [review] = await readChatGitHubReviewsByEndpointId(f.endpoint.id);
      expect(review.assessment?.summary).toBe(assessment.summary);
    });

    it.each((["completed", "failed", "missing_decision", "comment_requested", "missing_semantic", "legacy", "uncommitted_native", "pending_publication", "missing_decision_then_missing", "uncommitted_then_failed", "malformed_null", "malformed_scalar", "malformed_schema", "malformed_action"] as const)
      .flatMap(scenario => ["external_chat_response_waiting", "preserved_result_status_unproven"].map(reason => ({ scenario, reason }))))(
      "keeps GitHub response maintenance truthful for a new request: $scenario ($reason)", async ({ scenario, reason }) => {
      const pendingPresentation = scenario.startsWith("missing_decision") || scenario.startsWith("uncommitted") || scenario.startsWith("malformed");
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "review-before-new-request");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const originalId = [...f.responseComments.keys()][0];
      const originalBody = f.responseComments.get(originalId)!.body;
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41802", text: "Please handle this new request", userId: "42", userName: "octocat" }) });
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: scenario === "failed" ? "failed" : "succeeded", runtimeMode: scenario === "legacy" ? "legacy" : "native",
        nativePhase: scenario.startsWith("uncommitted") ? "observed" : "committed", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }), resultJson: { finalizationPhase: "committed", finalizationReasonCode: reason,
          ...(scenario === "missing_semantic" ? {} : { nativeResult: { schema: "paperclip.run_result.v1",
            reportedWorkDisposition: scenario === "completed" ? "completed" : "yielded",
            continuation: { kind: "response_wake", idempotencyKey: "new-request-wait" } } }),
          ...(scenario.startsWith("missing_decision") ? {} : { presentationDecision: scenario === "malformed_null" ? null : scenario === "malformed_scalar" ? "pending" : {
            schema: scenario === "malformed_schema" ? "unknown" : "paperclip.run_presentation_decision.v1", chosenSource: "none",
            commentAction: scenario === "malformed_action" ? "unknown" : scenario === "comment_requested" ? "create" : "none", reasonCodes: ["yielded_control_plane_wait"] } }) } }).returning();
      if (scenario === "pending_publication") await db.insert(chatActions).values({ companyId: f.companyId,
        endpointId: f.endpoint.id, conversationId: f.conversation.id, kind: "github_review_publication",
        providerActionId: `github_publication:${randomUUID()}`, status: "processing",
        payload: { operation: "comment", session: { ...f.session, runId: next.id } } });
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      const [delivery] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id),
        eq(chatDeliveries.providerEventId, `${thread.id}:41802`)));
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, delivery.id),
        eq(chatActions.kind, "github_response_comment")));
      if (scenario === "pending_publication") {
        expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect(response.result?.final).not.toBe(true);
        // Waiting for the reply to settle spends no delivery retry.
        expect(response.status).toBe("processed");
        expect(response.result?.attempts).toBeUndefined();
      } else if (pendingPresentation) {
        expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect(response.result?.final).not.toBe(true);
        const pendingWrites = f.responseWrites.length;
        await responses.processPending();
        await expect(responses.failRun({ ...f.session, runId: next.id, endpointId: f.endpoint.id,
          body: "This turn ended without publishing a final response." })).rejects.toMatchObject({ status: 409 });
        expect(f.responseWrites).toHaveLength(pendingWrites);
        const failed = scenario === "uncommitted_then_failed";
        const missing = scenario === "missing_decision_then_missing";
        await db.update(heartbeatRuns).set({ status: failed ? "failed" : "succeeded",
          nativePhase: failed ? "failed" : "committed", resultJson: {
            ...next.resultJson, finalizationPhase: failed ? "failed" : "committed",
            nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: missing ? "completed" : "yielded",
              continuation: missing ? null : { kind: "response_wake", idempotencyKey: "settled-request-wait" } },
            presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none",
              commentAction: "none", reasonCodes: [missing ? "no_final_response" : "yielded_control_plane_wait"] },
          } }).where(eq(heartbeatRuns.id, next.id));
        await responses.processPending();
        // A status for the new request never replaces the published review.
        expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect((await readChatActionsById(response.id))[0]).toMatchObject({
          status: failed || missing ? "processed" : "cancelled", result: { final: true },
        });
      } else {
        expect(f.responseComments.get(originalId)!.body).toBe(originalBody);
        expect(response).toMatchObject({ status: "processed", result: { final: true, code: "published_response_kept" } });
      }
      const writes = f.responseWrites.length;
      await responses.processPending();
      expect(f.responseWrites).toHaveLength(writes);
    });

    it.each(["same_head", "new_head"] as const)("reuses one main GitHub PR comment across review requests: %s", async headCase => {
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "first-review");
      const originalId = [...f.responseComments.keys()][0];
      // Restart after a provider write whose shared receipt was lost. The
      // App-owned marker, rather than process memory, must recover the target.
      await db.update(chatActions).set({ result: null }).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_pr_response_comment")));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }) }).returning();
      const session = { ...f.session, runId: next.id };
      const currentHead = headCase === "new_head" ? "c".repeat(40) : f.head;
      f.setSupplementalProviderFetch(async (input, init) => String(input).endsWith("/pulls/418")
        ? Response.json({ number: 418, state: "open", draft: false, head: { sha: currentHead },
          base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] })
        : f.provider(input, init));
      await f.service.execute(session, "begin_review", { reviewedCommit: currentHead });
      await f.service.execute(session, "submit_review", { ...f.assessment, reviewedCommit: currentHead, summary: "Second assessment" }, "second-review");
      expect([...f.responseComments.keys()]).toEqual([originalId]);
      expect(f.responseComments.get(originalId)?.body).toContain("Second assessment");
      expect(f.responseWrites.filter(write => write.method === "POST")).toHaveLength(1);
    });

    it("ignores a review request addressed to an external GitHub bot", async () => {
      const f = await subscribedGitHubFixture("github:paperclipai/paperclip:419");
      const wakeCount = f.wakeup.mock.calls.length;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread: f.thread,
        trigger: "subscribed_message", message: makeMessage({ id: "41902", text: "@greptile review", userId: "42", userName: "octocat" }) });
      const [delivery] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id),
        eq(chatDeliveries.providerEventId, `${f.thread.id}:41902`)));
      expect(delivery.state).toBe("filtered");
      expect(f.wakeup).toHaveBeenCalledTimes(wakeCount);
      expect(await readIssueCommentsByIssueId(f.conversation.issueId!)).toHaveLength(1);
      expect(f.responseWrites).toHaveLength(1);
    });

    it("reconciles a GitHub working comment when execution stops without a publication", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "execution_finalization_deadline_exceeded" })
        .where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.conversation.issueId!));
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("stopped before completing");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("paused");
    });

    it("recovers lost inline and check responses without duplicate GitHub publications", async () => {
      const f = await publicationRetryFixture();
      const lost = new Set<string>();
      f.setSupplementalProviderFetch(async (input, init) => {
        const response = await f.provider(input, init);
        if (init?.method === "POST" && /\/(?:comments|check-runs)$/.test(String(input)) && !lost.has(String(input))) {
          lost.add(String(input));
          throw new Error("Provider accepted the write but the response was lost");
        }
        return response;
      });
      const result = await f.service.execute(f.session, "submit_review", { ...f.assessment,
        findings: [{ key: "note", path: "src/math.ts", line: 1, side: "RIGHT", severity: "error", category: "correctness", body: "Example finding" }],
      }, "lost-receipts");
      expect(result).toMatchObject({ status: "processed", score: 3, conclusion: "neutral" });
      expect(f.inline).toHaveLength(1);
      expect(f.checks).toHaveLength(1);
      expect(f.writes.filter(write => write.method === "POST")).toHaveLength(2);
      expect(f.responseComments.size).toBe(1);
      expect((await f.action()).status).toBe("processed");
    }, 25_000);

    it.each([503, 429])("automatically retries a transient GitHub review publication (HTTP %s)", async providerStatus => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418", true);
      const head = "b".repeat(40);
      let summaryAttempts = 0;
      const checks: Record<string, unknown>[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/check-runs") && init?.method) {
          checks.push(JSON.parse(String(init.body)));
          return Response.json({ id: 419, html_url: "https://github.com/checks/419" });
        }
        if (url.includes("/issues/comments/") && init?.method === "PATCH" && ++summaryAttempts === 1)
          return new Response("Temporary provider failure", { status: providerStatus, headers: { "retry-after": "1" } });
        return undefined;
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { createToolGatewayService } = await import("../../services/tool-gateway.js");
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "begin_review", { reviewedCommit: head });
      const assessment = { reviewedCommit: head, score: 3, complete: true, summary: "Advisory review", rationale: "Reviewed the file",
        coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] }, findings: [] };
      const idempotencyKey = randomUUID();
      const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, idempotencyKey });
      expect(result).toMatchObject({ status: "completed", result: { data: { status: "processed", score: 3, conclusion: "neutral" } } });
      expect(summaryAttempts).toBe(2);
      expect(f.responseComments.size).toBe(1);
      expect(checks).toEqual([expect.objectContaining({ conclusion: "neutral", status: "completed" })]);
      const replay = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, idempotencyKey });
      expect(replay).toMatchObject({ result: { data: { status: "processed", score: 3, conclusion: "neutral" } } });
      expect(summaryAttempts).toBe(2);
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
      expect(action).toMatchObject({ status: "processed" });
      expect((await readChatGitHubReviewsByEndpointId(f.endpoint.id))).toHaveLength(1);
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { ...assessment, score: 5 }, idempotencyKey }))
        .rejects.toMatchObject({ status: 409, reasonCode: "github_idempotency_conflict" });
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Revoke review publication", policyType: "block", priority: 0,
        selectors: { catalogEntryId: tool.catalogEntryId! },
      });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, idempotencyKey })).rejects.toThrow();
      expect(summaryAttempts).toBe(2);
    }, 25_000);

    it.each([
      { boardFollowUp: false, legacyOrigin: false },
      { boardFollowUp: true, legacyOrigin: false },
      { boardFollowUp: false, legacyOrigin: true },
      { boardFollowUp: true, legacyOrigin: true },
    ])("keeps GitHub review tools callable through a later native task gateway (board follow-up: $boardFollowUp, legacy origin: $legacyOrigin)", async ({ boardFollowUp, legacyOrigin }) => {
      vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.example.test");
      onTestFinished(() => { vi.unstubAllEnvs(); });
      const f = await publicationRetryFixture();
      const identity = await initializeRunIdentity(db, {
        companyId: f.companyId, runId: f.run.id, issueId: f.conversation.issueId!,
        responsibleUserId: "owner-user", messageIds: legacyOrigin ? [] : [String(f.run.contextSnapshot?.wakeCommentId)], cause: "instruction",
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const [agent] = await db.select().from(agents).where(eq(agents.id, f.assignedAgentId));
      const gateway = createToolGatewayService(db);
      const first = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: f.run.id });
      const firstTools = await createAssignedMcpTools({ gateway, gatewayPublicId: new URL(first[0].url).pathname.split("/").at(-1)!, bearerToken: first[0].token });
      expect(await firstTools.execute({ tool: "paperclip_search_assigned_tools", arguments: { query: "begin_review" } })).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("begin_review") })]) });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      const [later] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.assignedAgentId, status: "running", runtimeMode: "native",
        nativeIssueId: f.conversation.issueId, contextSnapshot: { wakeReason: "issue_monitor_due" },
      }).returning();
      const [boardMessage] = boardFollowUp ? await db.insert(issueComments).values({
        companyId: f.companyId, issueId: f.conversation.issueId!, authorType: "user", authorUserId: "owner-user", body: "Finish the review",
      }).returning() : [];
      await initializeRunIdentity(db, {
        companyId: f.companyId, runId: later.id, issueId: f.conversation.issueId!,
        responsibleUserId: "owner-user", parentContextId: identity.id, messageIds: boardMessage ? [boardMessage.id] : [], cause: "monitor",
      });
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: later.id });
      expect(servers).toHaveLength(1);
      await expect(gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: later.id, issueId: randomUUID() }))
        .rejects.toMatchObject({ reasonCode: "run_context_mismatch" });
      const assigned = await createAssignedMcpTools({ gateway, gatewayPublicId: new URL(servers[0].url).pathname.split("/").at(-1)!, bearerToken: servers[0].token });
      expect(await assigned.execute({ tool: "paperclip_search_assigned_tools", arguments: { query: "begin_review" } })).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("begin_review") })]) });
      const read = assigned.definitions().find(tool => String(tool.name).includes("read_pull_request"))!;
      expect(await assigned.execute({ tool: String(read.name), arguments: { section: "metadata" } })).toMatchObject({ data: { pull: { number: 418 } } });
      const begin = assigned.definitions().find(tool => String(tool.name).includes("begin_review"))!;
      await assigned.execute({ tool: String(begin.name), arguments: { reviewedCommit: f.head } });
      const submit = assigned.definitions().find(tool => String(tool.name).includes("submit_review"))!;
      expect(await assigned.execute({ tool: String(submit.name), arguments: f.assessment })).toMatchObject({ data: { status: "processed", score: 3 } });
      expect(f.responseComments.size).toBe(1);
      expect([...f.responseComments.values()][0].body).toContain("Advisory review");
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.endpointId, f.endpoint.id));
      await expect(assigned.execute({ tool: String(read.name), arguments: { section: "metadata" } })).rejects.toThrow();
    });

    describe("replies in review finding threads behind an active run", () => {
      const pr = "github:paperclipai/paperclip:17044";
      async function findingThreadFixture() {
        vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.example.test");
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const f = await subscribedGitHubFixture(pr);
        const adapterType = `github-finding-thread-test-${randomUUID()}`;
        const execute = vi.fn(async (_input: { runId: string; context: Record<string, unknown> }) => ({
          exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Answered the finding thread",
        }));
        registerServerAdapter({ type: adapterType, supportsLocalAgentJwt: false, execute,
          testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
        const heartbeat = heartbeatService(db);
        const activeRunId = randomUUID();
        onTestFinished(async () => {
          runningProcesses.delete(activeRunId);
          await heartbeat.drainActiveRunExecutions();
          unregisterServerAdapter(adapterType);
        });
        const issueId = f.conversation.issueId!;
        await db.update(companies).set({ defaultResponsibleUserId: "owner-user" }).where(eq(companies.id, f.companyId));
        await db.update(agents).set({ adapterType, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
          .where(eq(agents.id, f.assignedAgentId));
        // Published findings bind their inline threads to the PR review task.
        const { id: _id, ...base } = f.conversation;
        const threads = await Promise.all(["4332012267", "4332012626"].map(async (commentId) => {
          const thread = makeThread({ channelId: "paperclipai/paperclip", id: `${pr}:rc:${commentId}` }).thread;
          const [conversation] = await db.insert(chatConversations).values({ ...base, externalThreadId: thread.id,
            providerUrl: `https://github.com/paperclipai/paperclip/pull/17044#discussion_r${commentId}` }).returning();
          return { thread, conversation };
        }));
        // The review-request run still holds the task when the linked user replies.
        await db.insert(heartbeatRuns).values({ id: activeRunId, companyId: f.companyId, agentId: f.assignedAgentId,
          status: "running", startedAt: new Date(), contextSnapshot: { issueId, source: "chat:github" },
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
        runningProcesses.set(activeRunId, { child: {} as never, graceSec: 0, processGroupId: null });
        await db.update(issues).set({ status: "in_review", executionRunId: activeRunId,
          executionAgentNameKey: "maya", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
        f.wakeup.mockImplementation(heartbeat.wakeup);
        let messageId = 41950;
        const reply = (thread: Thread, text: string) => deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id,
          provider: "github", thread, trigger: "subscribed_message",
          message: makeMessage({ id: String(messageId++), text, userId: "42", userName: "octocat" }) });
        const commentFor = async (text: string) => (await readIssueCommentsByIssueId(issueId)).find((c) => c.body.includes(text))!.id;
        const finishActiveRun = async () => {
          runningProcesses.delete(activeRunId);
          await heartbeat.cancelRun(activeRunId, "Review request finished", { suppressImmediateRecovery: true });
          await heartbeat.drainActiveRunExecutions();
        };
        const followUpRuns = async () => (await readHeartbeatRunsByCompanyId(f.companyId))
          .filter((run) => run.id !== activeRunId && run.wakeupRequestId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { ...f, issueId, threads, execute, reply, commentFor, finishActiveRun, followUpRuns };
      }

      it("answers each finding thread in its own run instead of one unattestable batch", async () => {
        const f = await findingThreadFixture();
        await f.reply(f.threads[0].thread, "First finding is intentional");
        await f.reply(f.threads[1].thread, "Second finding is fixed in the next commit");
        const first = await f.commentFor("First finding"), second = await f.commentFor("Second finding");
        await f.finishActiveRun();
        const runs = await f.followUpRuns();
        expect(runs.map((run) => ({ status: run.status, errorCode: run.errorCode, error: run.error })))
          .toEqual([{ status: "succeeded", errorCode: null, error: null }, { status: "succeeded", errorCode: null, error: null }]);
        expect(runs.map((run) => extractWakeCommentIds(run.contextSnapshot))).toEqual([[first], [second]]);
        expect(runs.map((run) => run.contextSnapshot?.chatConversationId))
          .toEqual(f.threads.map(({ conversation }) => conversation.id));
        expect(f.execute.mock.calls.map(([input]) => [input.context.paperclipExternalChatExecutionBound,
          extractWakeCommentIds(input.context)])).toEqual([[true, [first]], [true, [second]]]);
      });

      it("still batches several replies in one finding thread into one attested run", async () => {
        const f = await findingThreadFixture();
        await f.reply(f.threads[0].thread, "First note on this finding");
        await f.reply(f.threads[0].thread, "Second note on this finding");
        const ids = [await f.commentFor("First note"), await f.commentFor("Second note")];
        await f.finishActiveRun();
        const runs = await f.followUpRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: "succeeded", errorCode: null });
        expect(extractWakeCommentIds(runs[0].contextSnapshot)).toEqual(ids);
        expect(f.execute).toHaveBeenCalledTimes(1);
      });

      it("still denies each separated finding-thread run after the linked identity is revoked", async () => {
        const f = await findingThreadFixture();
        await f.reply(f.threads[0].thread, "First finding is intentional");
        await f.reply(f.threads[1].thread, "Second finding is fixed in the next commit");
        await db.update(chatIdentityLinks).set({ status: "revoked", revokedAt: new Date() })
          .where(eq(chatIdentityLinks.principalId, f.principal.id));
        await f.finishActiveRun();
        const runs = await f.followUpRuns();
        expect(runs.length).toBeGreaterThan(0);
        for (const run of runs) expect(run).toMatchObject({ status: "failed", errorCode: "setup_failed" });
        expect(f.execute).not.toHaveBeenCalled();
      });
    });

    it.each([
      { label: "preserves an explicit shorter GitHub tool deadline and reconciles without duplicate publication", delayMs: 200, timeoutMs: 50 },
    ])("recovers a durable GitHub publication receipt ($label)", async ({ delayMs, timeoutMs }) => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418", true);
      const head = "b".repeat(40);
      const checks: Record<string, unknown>[] = [];
      f.setSupplementalProviderFetch(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/pulls/418")) return Response.json({ number: 418, state: "open", draft: false,
          head: { sha: head }, base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] });
        if (url.includes("/files?")) return Response.json([{ filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
        if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
        if (url.includes("/check-runs") && init?.method) {
          checks.push(JSON.parse(String(init.body)));
          return Response.json({ id: 419, html_url: "https://github.com/checks/419" });
        }
        if (url.includes("/issues/comments/") && init?.method === "PATCH") {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        return undefined;
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const { createToolGatewayService } = await import("../../services/tool-gateway.js");
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tools = await githubBotToolsForSession(db, f.session);
      const tool = tools.find(tool => tool.upstreamToolName === "submit_review")!;
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "begin_review", { reviewedCommit: head });
      const assessment = { reviewedCommit: head, score: 5, complete: true,
        summary: "Reviewed the changed behavior and its callers. ".repeat(30),
        rationale: "Checked the mutation boundary and the client retry contract. ".repeat(30),
        coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] }, findings: [] };
      const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment, timeoutMs })
        .then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => {
        const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
        return action?.status;
      }, { timeout: 15_000 }).toBe("processed");
      expect(f.responseComments.size).toBe(1);
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(checks).toContainEqual(expect.objectContaining({ conclusion: "neutral", status: "completed" }));
      if (timeoutMs === undefined) {
        expect(result).toMatchObject({ value: { status: "completed", result: { data: { status: "processed", score: 5, conclusion: "neutral" } } } });
      } else {
        expect(result).toMatchObject({ error: { status: 504, reasonCode: "tool_timeout" } });
      }
      const writes = f.responseWrites.length;
      const replay = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: assessment });
      expect(replay).toMatchObject({ result: { data: { status: "processed", score: 5, conclusion: "neutral" } } });
      const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, replay.invocationId));
      expect(invocation).toMatchObject({ status: "succeeded", errorCode: null, errorMessage: null });
      expect(f.responseWrites).toHaveLength(writes);
    }, 40_000);

    it("rejects changed requests and revoked access before repeating an unstaged review", async () => {
      const f = await publicationRetryFixture();
      let metadataReads = 0;
      let unavailable = true;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).endsWith("/pulls/418")) {
          metadataReads++;
          if (unavailable) throw new Error("Connection closed before PR metadata arrived");
        }
        return f.provider(input, init);
      });
      vi.stubGlobal("fetch", f.providerFetch);
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const gateway = createToolGatewayService(db);
      const session = await gateway.createSession({ companyId: f.companyId, agentId: f.assignedAgentId, runId: f.run.id });
      const tool = (await githubBotToolsForSession(db, f.session)).find(tool => tool.upstreamToolName === "submit_review")!;
      const input = { sessionToken: session.token, tool: tool.name, parameters: f.assessment, idempotencyKey: "preflight-request" };
      await expect(gateway.executeTool(input)).rejects.toThrow("GitHub is temporarily unavailable");
      unavailable = false;
      const failedReads = metadataReads;
      await expect(gateway.executeTool({ ...input, parameters: { ...f.assessment, summary: "Changed assessment" } }))
        .rejects.toMatchObject({ reasonCode: "github_publication_unavailable" });
      expect(await f.action()).toBeUndefined();
      expect(metadataReads).toBe(failedReads);
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Revoke review", policyType: "block", priority: 0,
        selectors: { catalogEntryId: tool.catalogEntryId! } });
      await expect(gateway.executeTool(input)).rejects.toThrow();
      expect(await f.action()).toBeUndefined();
      expect(metadataReads).toBe(failedReads);
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST"]);
    });

    it("retries an ambiguous GitHub edit without creating another comment", async () => {
      const f = await toolReplyFixture();
      let unavailable = true;
      f.setSupplementalProviderFetch(async (input, init) => {
        if (String(input).includes("/issues/comments/") && init?.method === "PATCH" && unavailable) throw new Error("Response lost");
        return undefined;
      });
      const service = githubChatReviewService(db, f.providerFetch);
      const result = await service.execute(f.session, "comment", { body: "Here is your answer", idempotencyKey: "retry-reply" });
      expect(result.status).toBe("failed");
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("unsettled");
      unavailable = false;
      const [action] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_publication")));
      await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, action.id));
      await service.processPending();
      expect(f.responseWrites.map(write => write.method)).toEqual(["POST", "PATCH"]);
      expect(f.responseComments.size).toBe(1);
      await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe("confirmed");
    });

    it.each(["none", "confirmed", "unsettled", "check_only", "different_run", "different_company", "wrong_agent", "denied", "ambiguous_exhausted", "cancelled_after_ambiguous", "missing_receipt"] as const)(
      "GitHub failure fallback respects exact tool delivery state: %s", async scenario => {
        const f = await toolReplyFixture();
        if (scenario !== "none") {
          await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
            kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`,
            payload: { operation: scenario === "check_only" ? "assessment" : "comment", session: { ...f.session,
              ...(scenario === "different_run" ? { runId: randomUUID() } : {}),
              ...(scenario === "different_company" ? { companyId: randomUUID() } : {}),
              ...(scenario === "wrong_agent" ? { agentId: f.replacementAgentId } : {}),
            } },
            status: scenario === "unsettled" ? "processing" : scenario === "denied" || scenario === "cancelled_after_ambiguous" ? "cancelled" : scenario === "ambiguous_exhausted" ? "failed" : "processed",
            result: scenario === "check_only" || scenario === "missing_receipt" ? {} : scenario === "denied" ? { code: "authorization_changed", attempts: 1 } : scenario === "cancelled_after_ambiguous" ? { code: "authorization_changed", attempts: 2 }
              : scenario === "ambiguous_exhausted" ? { code: "publication_failed", retryable: false, attempts: 8 }
              : { id: "41802", url: "https://github.com/paperclipai/paperclip/issues/418#issuecomment-41802" },
          });
        }
        const unresolved = ["unsettled", "ambiguous_exhausted", "cancelled_after_ambiguous", "missing_receipt"].includes(scenario);
        const expected = scenario === "confirmed" ? "confirmed" : unresolved ? "unsettled" : "none";
        await expect(githubRunReplyState(db, { ...f.session, endpointId: f.endpoint.id })).resolves.toBe(expected);
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "test_runtime_failed" }).where(eq(heartbeatRuns.id, f.run.id));
        await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
        await enqueueChatRunMilestones(db); await f.service.processPendingPublications();
        const posts = f.runtime.endpoints.get(f.endpoint.id)?.posts ?? [];
        expect(posts).toHaveLength(0);
        expect(f.responseWrites).toHaveLength(expected === "none" ? 2 : 1);
        if (expected === "none") expect(f.responseWrites[1]).toMatchObject({ method: "PATCH", body: expect.stringContaining("stopped before completing this turn") });
        const [fallback] = await db.select().from(chatPublications).where(and(eq(chatPublications.endpointId, f.endpoint.id),
          eq(chatPublications.idempotencyKey, `run:${f.run.id}:failed:${f.endpoint.id}`)));
        expect(fallback.state).toBe(expected === "none" ? "published" : "cancelled");
      },
    );

    it.each(["issues", "issue_comment", "pull_request_review_comment"])(
      "admits signed %s mentions with automation off, deduplicates and retains manual task authority", async (event) => {
        const f = await reviewBotFixture();
        const saved = await f.management.configuration(f.endpoint.id, "owner-user");
        await f.management.saveConfiguration(f.endpoint.id, { expectedRevision: saved.revision, configuration: { ...saved.configuration, defaults: { ...saved.configuration.defaults, invocation: "mentions_only", events: [], issueOpened: false }, repositories: { ...saved.configuration.repositories, "97531": { instructions: "Use repository-specific guidance" } } } }, "owner-user");
        const body = `@${f.endpoint.botUsername!.replace(/\[bot\]$/, "")} tell me a joke`;
        const target = { number: 83, title: "Say hello", body, user: { id: 42, login: "octocat", type: "User" }, labels: [] };
        const comment = { id: 83001, body, user: target.user, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), in_reply_to_id: 83000 };
        const payload = {
          action: event.includes("comment") ? "created" : event === "pull_request_review" ? "submitted" : "opened",
          installation: { id: 2468 },
          repository: { id: 97531, full_name: "PaperclipAI/Paperclip", name: "paperclip", owner: { id: 1357, login: "paperclipai" } },
          sender: target.user, issue: target, pull_request: target, comment, review: comment,
        };
        const delivery = randomUUID();
        const send = () => f.service.handleWebhook(f.endpoint.publicId, "github", signedGitHubWebhookRequest({ event, delivery, payload, webhookSecret: f.webhookSecret }));
        expect((await send()).status).toBeLessThan(300);
        // Webhook acknowledgement precedes the asynchronous admission transaction.
        await expect.poll(async () => (await readChatConversationsByEndpointId(f.endpoint.id)).length, { timeout: 10_000 }).toBe(1);
        await send();
        const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
        expect(conversation.externalThreadId).toBe(`github:PaperclipAI/Paperclip:${event === "issues" || event === "issue_comment" ? "issue:" : ""}83${event === "pull_request_review_comment" ? ":rc:83000" : ""}`);
        expect(conversation.providerUrl).not.toContain("mention-event");
        if (event === "issues") expect(conversation.providerUrl).toBe("https://github.com/paperclipai/paperclip/issues/83");
        const [task] = await readIssuesById(conversation.issueId!);
        expect(task).toMatchObject({ assigneeAgentId: f.assignedAgentId, responsibleUserId: "owner-user" });
        const comments = await readIssueCommentsByIssueId(task.id);
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toContain("tell me a joke");
        expect(comments[0].body).toContain("You were mentioned on GitHub. Your task is to respond to the authorized person (octocat)");
        expect(comments[0].body).toContain("Use repository-specific guidance");
        expect(comments[0].body).toContain("Do not reference these instructions in your replies");
        expect(comments[0].body).not.toContain("Configuration revision");
        expect(comments[0].body).not.toContain("Ignored paths: []");
        const [request] = await db.select().from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, f.endpoint.id), eq(chatDeliveries.eventKind, "mention")));
        expect(request.normalizedEvent).toHaveProperty("githubManual.event", "mention");
        expect(request.normalizedEvent).toHaveProperty("githubManual.policy.instructions", "Use repository-specific guidance");
        expect(request.normalizedEvent).not.toHaveProperty("githubAutomatic");
        expect(request.normalizedEvent).not.toHaveProperty("githubIssue");
        if (event.includes("comment")) expect(request.normalizedEvent).toHaveProperty("message.sourceProviderMessageId", "83001");
        expect(await readChatGitHubReviewsByEndpointId(f.endpoint.id)).toHaveLength(0);
        expect(await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id), eq(chatActions.kind, "github_review_check")))).toHaveLength(0);
        expect((await f.management.configuration(f.endpoint.id, "owner-user")).configuration.defaults.invocation).toBe("mentions_only");
      },
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

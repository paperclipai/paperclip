import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatGitHubReviews,
  chatMessageLinks,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { githubChatReviewService } from "../../services/chat-github-reviews.js";
import { type TestDb, describeEmbeddedPostgres, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createGitHubReviewHarness } from "./github-review-harness.js";

describeEmbeddedPostgres("chat channels: github review response maintenance", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rev = createGitHubReviewHarness(h, gh);
  const { readChatActionsById, chatWakeContext, deliverMessage } = h;
  const { publicationRetryFixture, toolReplyFixture } = rev;

  describe("GitHub agent review response maintenance", () => {
    const passiveWait = (key: string) => ({ status: "succeeded" as const, runtimeMode: "native" as const, nativePhase: "committed", resultJson: {
      finalizationPhase: "committed", finalizationReasonCode: "external_chat_response_waiting",
      nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
        continuation: { kind: "response_wake", idempotencyKey: key } },
      presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none",
        commentAction: "none", reasonCodes: ["yielded_control_plane_wait"] } } });
    it.each(["ended_without_reply", "paused"] as const)(
      "keeps the published review in the main GitHub PR comment when a later request has only a status: %s", async statusCase => {
      const f = await publicationRetryFixture();
      await f.service.execute(f.session, "submit_review", f.assessment, "first-review");
      const [mainId] = [...f.responseComments.keys()];
      expect(f.responseComments.get(mainId)?.body).toContain("Advisory review");
      const committed = { status: "succeeded" as const, nativePhase: "committed", resultJson: {
        presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none", commentAction: "none" } } };
      await db.update(heartbeatRuns).set(committed).where(eq(heartbeatRuns.id, f.run.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      // Production saw several queued re-review requests while one run owned
      // the task: the run's own request ends without a reply, and the older
      // queued request is shown as paused while the task is blocked.
      for (const id of ["41802", "41803"]) await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id, text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41803",
        }) }).returning();
      await db.update(heartbeatRuns).set(committed).where(eq(heartbeatRuns.id, next.id));
      if (statusCase === "paused") {
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.conversation.issueId!));
      } else {
        await githubResponseCommentService(db, f.providerFetch).failRun({ companyId: f.companyId, endpointId: f.endpoint.id,
          issueId: f.conversation.issueId!, runId: next.id,
          body: "This turn ended without publishing a final response. See the Paperclip task for details." });
      }
      for (let pass = 0; pass < 3; pass++) await githubResponseCommentService(db, f.providerFetch).processPending();
      expect([...f.responseComments.keys()]).toEqual([mainId]);
      const body = f.responseComments.get(mainId)?.body ?? "";
      expect(body).toContain("Advisory review");
      expect(body).not.toContain("Work is paused");
      expect(body).not.toContain("without publishing a final response");
      // Requests with a status settle against the kept review instead of
      // retrying. Unpaused, the older queued request still waits for its run.
      const open = await db.select({ id: chatActions.id }).from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment"), sql`coalesce(${chatActions.result}->>'final', 'false') <> 'true'`));
      expect(open).toHaveLength(statusCase === "paused" ? 0 : 1);
    });
    it("settles an older request's status without replacing a newer main GitHub PR placeholder", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      // The first request's run stopped before the next request arrived.
      await db.update(heartbeatRuns).set({ status: "failed", updatedAt: new Date(Date.now() - 60_000) })
        .where(eq(heartbeatRuns.id, f.run.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Review again", userId: "42", userName: "octocat", mentioned: true }) });
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      await responses.processPending();
      expect(f.responseComments.size).toBe(1);
      const body = [...f.responseComments.values()][0].body;
      expect(body).not.toContain("stopped before completing");
      const [first] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment"))).orderBy(asc(chatActions.createdAt)).limit(1);
      expect(first).toMatchObject({ status: "processed", result: { final: true, code: "status_superseded" } });
    });
    it("settles a GitHub working comment whose run finished just before another request's run started", async () => {
      const f = await toolReplyFixture();
      const [firstId] = [...f.responseComments.keys()];
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      const committed = { status: "succeeded" as const, nativePhase: "committed", resultJson: {
        presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none", commentAction: "none" } } };
      // The first request's run ends without a reply, and the next request's run
      // starts before any sweep sees the first run as the task's latest.
      await db.update(heartbeatRuns).set(committed).where(eq(heartbeatRuns.id, f.run.id));
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "One more thing", userId: "42", userName: "octocat", mentioned: true }) });
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }) }).returning();
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      // Work is still running on the task, so the first request waits.
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      await db.update(heartbeatRuns).set(committed).where(eq(heartbeatRuns.id, next.id));
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("ended without publishing a final response");
      const open = await db.select({ id: chatActions.id }).from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment"), sql`coalesce(${chatActions.result}->>'final', 'false') <> 'true'`));
      expect(open).toEqual([]);
      const writes = f.responseWrites.length;
      await responses.processPending();
      expect(f.responseWrites).toHaveLength(writes);
    });
    it.each([["recent", 0, "See the [latest response]"], ["too old", 31 * 60_000, "stopped before completing"]] as const)(
      "waits for the automatic continuation of a failed GitHub request run: %s", async (_label, failedAgoMs, settled) => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native",
        errorCode: "native_continuation_requires_reconciliation", updatedAt: new Date(Date.now() - failedAgoMs) })
        .where(eq(heartbeatRuns.id, f.run.id));
      const responses = githubResponseCommentService(db, f.providerFetch);
      const stopped = { companyId: f.companyId, endpointId: f.endpoint.id, issueId: f.conversation.issueId!, runId: f.run.id,
        body: "This turn stopped before completing. See the Paperclip task for details." };
      if (failedAgoMs === 0) {
        await expect(responses.failRun(stopped)).rejects.toMatchObject({ status: 409 });
        await responses.processPending();
        expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId, status: "succeeded",
          runtimeMode: "native", nativePhase: "committed", retryOfRunId: f.run.id,
          contextSnapshot: { issueId: f.conversation.issueId }, resultJson: { presentationDecision: {
            schema: "paperclip.run_presentation_decision.v1", chosenSource: "none", commentAction: "none" } } });
        const [main] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
          issueId: f.conversation.issueId, externalConversationId: "github:paperclipai/paperclip",
          externalLabel: "paperclipai/paperclip", externalThreadId: "github:paperclipai/paperclip:418" }).returning();
        await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: main.id,
          kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`, status: "processed",
          payload: { operation: "assessment", session: { companyId: f.companyId, issueId: f.conversation.issueId,
            runId: randomUUID(), agentId: f.assignedAgentId } },
          result: { summaryUrl: "https://github.com/paperclipai/paperclip/pull/418#issuecomment-5" } });
        await responses.processPending();
      } else {
        await responses.failRun(stopped);
      }
      expect(f.responseComments.get(firstId)?.body).toContain(settled);
    });
    it("keeps waiting while the automatic continuations of a failed GitHub request run also fail", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      const failed = (ago: number) => ({ status: "failed", runtimeMode: "native" as const,
        errorCode: "native_continuation_requires_reconciliation", updatedAt: new Date(Date.now() - ago) });
      await db.update(heartbeatRuns).set(failed(50 * 60_000)).where(eq(heartbeatRuns.id, f.run.id));
      const [first] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        ...failed(40 * 60_000), retryOfRunId: f.run.id, contextSnapshot: { issueId: f.conversation.issueId } }).returning();
      const [second] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        ...failed(60_000), contextSnapshot: { issueId: f.conversation.issueId, previousRunId: first.id } }).returning();
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      await db.update(heartbeatRuns).set({ updatedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(heartbeatRuns.id, second.id));
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("stopped before completing");
    });
    it("links a request awaiting a continuation to a later response without waiting for the deadline", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native",
          errorCode: "native_continuation_requires_reconciliation", updatedAt: new Date(Date.now() - 60_000) })
          .where(eq(heartbeatRuns.id, f.run.id));
        const [main] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
          issueId: f.conversation.issueId, externalConversationId: "github:paperclipai/paperclip",
          externalLabel: "paperclipai/paperclip", externalThreadId: "github:paperclipai/paperclip:418" }).returning();
        await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: main.id,
          kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`, status: "processed",
          payload: { operation: "assessment", session: { companyId: f.companyId, issueId: f.conversation.issueId,
            runId: randomUUID(), agentId: f.assignedAgentId } },
          result: { summaryUrl: "https://github.com/paperclipai/paperclip/pull/418#issuecomment-5" } });
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        await vi.waitFor(() => expect(f.responseComments.get(firstId)?.body).toContain("See the [latest response]"),
          { timeout: 10_000 });
        expect(errors).toEqual([]);
      } finally {
        await coordinator.stop();
        vi.useRealTimers();
      }
    });
    it("settles a request still waiting for a continuation once the wait expires, through the registered worker", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native",
          errorCode: "native_continuation_requires_reconciliation", updatedAt: new Date(Date.now() - 29 * 60_000) })
          .where(eq(heartbeatRuns.id, f.run.id));
        await githubResponseCommentService(db, f.providerFetch).registerTerminalResponseWork(coordinator, () => true).ready;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await vi.waitFor(() => expect(f.responseComments.get(firstId)?.body).toContain("stopped before completing"),
          { timeout: 10_000 });
        expect(errors).toEqual([]);
      } finally {
        await coordinator.stop();
        vi.useRealTimers();
      }
    });
    it.each(["in_progress", "blocked"] as const)("links the latest response when a request's run ends without its own reply: %s",
      async issueStatus => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      await db.update(issues).set({ status: issueStatus }).where(eq(issues.id, f.conversation.issueId!));
      const [firstId] = [...f.responseComments.keys()];
      const [main] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId, externalConversationId: "github:paperclipai/paperclip",
        externalLabel: "paperclipai/paperclip", externalThreadId: "github:paperclipai/paperclip:418" }).returning();
      await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: main.id,
        kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`, status: "processed",
        payload: { operation: "assessment", session: { companyId: f.companyId, issueId: f.conversation.issueId, runId: randomUUID(), agentId: f.assignedAgentId } },
        result: { summaryUrl: "https://github.com/paperclipai/paperclip/pull/418#issuecomment-1" } });
      await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativePhase: "committed", resultJson: {
        finalizationPhase: "committed", finalizationReasonCode: "completion_claim_policy_accepted",
        nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done" },
        presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none", commentAction: "create" } } })
        .where(eq(heartbeatRuns.id, f.run.id));
      await githubResponseCommentService(db, f.providerFetch).failRun({ companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId!, runId: f.run.id,
        body: "This turn ended without publishing a final response. See the Paperclip task for details." });
      expect(f.responseComments.get(firstId)?.body).toContain("See the [latest response](https://github.com/paperclipai/paperclip/pull/418)");
      expect(f.responseComments.get(firstId)?.body).not.toContain("ended without publishing");
    });
    it("links a GitHub thread whose run waited to the response a later run published", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set(passiveWait("first-wait")).where(eq(heartbeatRuns.id, f.run.id));
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      // The run waits on purpose and the task is still open, so the thread waits too.
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      // A response on another pull request bound to the same task is not linked.
      const [other] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId, externalConversationId: "github:paperclipai/paperclip",
        externalLabel: "paperclipai/paperclip", externalThreadId: "github:paperclipai/paperclip:4180" }).returning();
      await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: other.id,
        kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`, status: "processed",
        payload: { operation: "comment", session: { companyId: f.companyId, issueId: f.conversation.issueId, runId: randomUUID(), agentId: f.assignedAgentId } },
        result: { id: "77", url: "https://github.com/paperclipai/paperclip/pull/4180#issuecomment-77" } });
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.conversation.issueId!));
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "Fixed this one too", userId: "42", userName: "octocat", mentioned: true }) });
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "running", runtimeMode: "native", contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id, issueId: f.conversation.issueId, provider: "github", providerMessageId: "41802",
        }) }).returning();
      await githubChatReviewService(db, f.providerFetch).execute({ ...f.session, runId: next.id }, "comment",
        { body: "Re-reviewed both threads", idempotencyKey: "later-response" });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, next.id));
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toMatch(/See the \[latest response\]\(https:\/\/github\.com\//);
    });
    it("links a waiting GitHub thread to a later review published only as inline findings", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set(passiveWait("inline-only-wait")).where(eq(heartbeatRuns.id, f.run.id));
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      const reviewId = randomUUID();
      await db.insert(chatGitHubReviews).values({ id: reviewId, companyId: f.companyId, endpointId: f.endpoint.id,
        issueId: f.conversation.issueId!, repositoryId: "42", repository: "paperclipai/paperclip", pullNumber: 418,
        headSha: "b".repeat(40), deliveryId: "inline-only", configurationRevision: 1, policySnapshot: {} as never, event: {} as never,
        state: "completed", publicationReceipts: { "finding:1": { id: "88",
          url: "https://github.com/paperclipai/paperclip/pull/418#discussion_r88", digest: "d" } } });
      await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
        kind: "github_review_publication", providerActionId: `github_publication:${randomUUID()}`, status: "processed",
        payload: { operation: "assessment", reviewId, session: { companyId: f.companyId, issueId: f.conversation.issueId, runId: f.run.id, agentId: f.assignedAgentId } },
        result: { reviewId, summaryUrl: null } });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      await responses.processPending();
      // The outgoing-text projection drops URL fragments, so the link names the pull request.
      expect(f.responseComments.get(firstId)?.body).toContain("See the [latest response](https://github.com/paperclipai/paperclip/pull/418)");
      expect(f.responseComments.get(firstId)?.body).not.toContain("ended without publishing");
    });
    it("settles a waiting GitHub thread once the task finishes without a later response", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set(passiveWait("only-wait")).where(eq(heartbeatRuns.id, f.run.id));
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("ended without publishing a final response");
    });
    it("settles a GitHub thread whose run's final reply could not be published", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativePhase: "committed", resultJson: {
        finalizationPhase: "committed", finalizationReasonCode: "governed_gate_pending",
        responsePublication: { schema: "paperclip.native_response_publication.v1", state: "failed", attempts: 6,
          reasonCode: "native_response_publication_failed", lastReason: "publication_refused", nextAttemptAt: null } } })
        .where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      const responses = githubResponseCommentService(db, f.providerFetch);
      for (let pass = 0; pass < 2; pass++) await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("reply could not be published");
    });
    it.each(["github:paperclipai/paperclip:418:rc:4100", "github:paperclipai/paperclip:issue:418"])(
      "settles a GitHub request whose run failed and whose automatic retry finished the task: %s", async threadId => {
      const f = await toolReplyFixture(threadId);
      const [firstId] = [...f.responseComments.keys()];
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      // The retry carries the task, not the request's wake comment.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgentId,
        status: "succeeded", runtimeMode: "native", nativePhase: "committed", retryOfRunId: f.run.id,
        contextSnapshot: { issueId: f.conversation.issueId }, resultJson: {
          presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "none", commentAction: "none" } } });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      const responses = githubResponseCommentService(db, f.providerFetch);
      for (let pass = 0; pass < 3; pass++) await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).not.toContain("Working on this");
    });
    it.each([[502, true], [422, false]] as const)(
      "keeps retrying a GitHub request after 8 attempts only for a temporary error: %s", async (status, retryable) => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      const readResponse = async () => (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment"))))[0];
      const before = await readResponse();
      await db.update(chatActions).set({ status: "failed", result: { ...before.result, attempts: 7, retryable: true,
        retryAt: new Date(0).toISOString(), code: "acknowledgement_unconfirmed" } }).where(eq(chatActions.id, before.id));
      f.setSupplementalProviderFetch(async (_input, init) => init?.method === "PATCH"
        ? Response.json({ message: "GitHub error" }, { status }) : undefined);
      const startedAt = Date.now();
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const after = await readResponse();
      expect(after).toMatchObject({ status: "failed", result: { attempts: 8, retryable } });
      if (retryable) {
        const wait = Date.parse(String(after.result?.retryAt)) - startedAt;
        expect(wait).toBeGreaterThanOrEqual(3_590_000);
        expect(wait).toBeLessThanOrEqual(3_660_000);
      }
    });
    it("settles a coalesced GitHub request whose comment was deleted without blocking the reply", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const thread = makeThread({ channelId: "paperclipai/paperclip", id: f.conversation.externalThreadId }).thread;
      await deliverMessage({ callbacks: f.callbacks, endpointId: f.endpoint.id, provider: "github", thread,
        trigger: "mention", message: makeMessage({ id: "41802", text: "And this one", userId: "42", userName: "octocat", mentioned: true }) });
      await githubResponseCommentService(db, f.providerFetch).processPending();
      const inbound = await db.select({ commentId: chatMessageLinks.commentId, deliveryId: chatMessageLinks.deliveryId })
        .from(chatMessageLinks).where(and(eq(chatMessageLinks.conversationId, f.conversation.id), eq(chatMessageLinks.direction, "inbound")))
        .orderBy(asc(chatMessageLinks.createdAt));
      expect(inbound).toHaveLength(2);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot,
        wakeCommentIds: inbound.map(link => link.commentId) } }).where(eq(heartbeatRuns.id, f.run.id));
      const [sibling] = await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, inbound[1]!.deliveryId!),
        eq(chatActions.kind, "github_response_comment")));
      expect(sibling.result?.id).toBeTruthy();
      f.responseComments.delete(Number(sibling.result!.id));
      await githubChatReviewService(db, f.providerFetch).execute(f.session, "comment",
        { body: "Answered both requests", idempotencyKey: "coalesced-reply" });
      expect([...f.responseComments.values()].some(comment => comment.body.includes("Answered both requests"))).toBe(true);
      expect((await readChatActionsById(sibling.id))[0]).toMatchObject({ status: "cancelled",
        result: { final: true, code: "response_deleted" } });
    });
    it("settles a GitHub request whose posted comment was deleted instead of retrying it", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      const responses = githubResponseCommentService(db, f.providerFetch);
      const readResponse = async () => (await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment"))))[0];
      // A 404 that is not about this comment (here the comment write) is not a deletion.
      f.setSupplementalProviderFetch(async (_input, init) => init?.method === "PATCH"
        ? Response.json({ message: "Not Found" }, { status: 404 }) : undefined);
      await responses.processPending();
      expect(await readResponse()).toMatchObject({ status: "failed", result: { retryable: true } });
      f.setSupplementalProviderFetch(async () => undefined);
      const due = await readResponse();
      await db.update(chatActions).set({ result: { ...due.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, due.id));
      f.responseComments.delete(firstId);
      const writes = f.responseWrites.length;
      await responses.processPending();
      const response = await readResponse();
      expect(response).toMatchObject({ status: "cancelled", result: { final: true, code: "response_deleted" } });
      expect(f.responseComments.size).toBe(0);
      expect(f.responseWrites).toHaveLength(writes);
    });
    it("settles a GitHub thread whose acknowledgement retries ran out, after the recovery migration", async () => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418:rc:4100");
      const [firstId] = [...f.responseComments.keys()];
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.conversation.issueId!));
      // Before the settle fixes, a request could spend all its acknowledgement
      // retries and stay failed, which no recovery path reads again.
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.endpointId, f.endpoint.id),
        eq(chatActions.kind, "github_response_comment")));
      await db.update(chatActions).set({ status: "failed", result: { ...response.result,
        attempts: 8, retryable: false, code: "acknowledgement_unconfirmed" } }).where(eq(chatActions.id, response.id));
      const responses = githubResponseCommentService(db, f.providerFetch);
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      const migration = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
        "../../../../packages/db/src/migrations/0509_recover_exhausted_github_responses.sql"), "utf8");
      // Rows the recovery must leave alone: final, still retryable, no posted comment, or no delivery.
      const untouched = await db.insert(chatActions).values([
        { result: { id: "1", final: true }, providerActionId: `untouched:${randomUUID()}`, deliveryId: response.deliveryId },
        { result: { id: "2", retryable: true }, providerActionId: `untouched:${randomUUID()}`, deliveryId: response.deliveryId },
        { result: { code: "acknowledgement_unconfirmed" }, providerActionId: `untouched:${randomUUID()}`, deliveryId: response.deliveryId },
        { result: { id: "4" }, providerActionId: `untouched:${randomUUID()}`, deliveryId: null },
      ].map(row => ({ ...row, companyId: f.companyId, endpointId: f.endpoint.id, conversationId: f.conversation.id,
        kind: "github_response_comment", status: "failed" as const, payload: {} }))).returning();
      await db.$client.unsafe(migration);
      expect((await Promise.all(untouched.map(row => readChatActionsById(row.id)))).map(([row]) => row.status))
        .toEqual(["failed", "failed", "failed", "failed"]);
      await db.delete(chatActions).where(inArray(chatActions.id, untouched.map(row => row.id)));
      // Recovery resets the attempt count so a temporary GitHub error can retry.
      expect((await readChatActionsById(response.id))[0]).toMatchObject({ status: "processed",
        result: { attempts: 0, code: "recovered_after_exhausted_retries" } });
      let failures = 0;
      f.setSupplementalProviderFetch(async (input, init) => init?.method === "PATCH" && failures++ === 0
        ? Response.json({ message: "Server Error" }, { status: 502 }) : undefined);
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("Working on this");
      const [retrying] = await readChatActionsById(response.id);
      expect(retrying).toMatchObject({ status: "failed", result: { retryable: true } });
      await db.update(chatActions).set({ result: { ...retrying.result, retryAt: new Date(0).toISOString() } })
        .where(eq(chatActions.id, response.id));
      await responses.processPending();
      expect(f.responseComments.get(firstId)?.body).toContain("stopped before completing");
      const [settled] = await db.select().from(chatActions).where(eq(chatActions.id, response.id));
      expect(settled.result?.final).toBe(true);
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
  });
});

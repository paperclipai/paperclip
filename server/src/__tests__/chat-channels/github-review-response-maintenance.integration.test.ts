import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  chatActions,
  chatDeliveries,
  heartbeatRuns,
} from "@paperclipai/db";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
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
  const { publicationRetryFixture } = rev;

  describe("GitHub agent review response maintenance", () => {
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

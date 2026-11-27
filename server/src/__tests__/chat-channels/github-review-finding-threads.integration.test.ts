import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatIdentityLinks,
  chatPublications,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
  toolInvocations,
  toolPolicies,
} from "@paperclipai/db";
import type { Thread } from "chat";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { githubChatReviewService } from "../../services/chat-github-reviews.js";
import { githubBotToolsForSession } from "../../services/chat-github-tools.js";
import { buildPaperclipRuntimeMcpServers } from "../../services/heartbeat/run-preparation.js";
import { createAssignedMcpTools } from "../../services/native-runtime/assigned-mcp-tools.js";
import { createToolGatewayService } from "../../services/tool-gateway.js";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { enqueueChatRunMilestones, githubRunReplyState } from "../../services/chat-run-publications.js";
import { extractWakeCommentIds, heartbeatService } from "../../services/heartbeat.js";
import { registerServerAdapter, runningProcesses, unregisterServerAdapter } from "../../adapters/index.js";
import { type TestDb, describeEmbeddedPostgres, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createGitHubReviewHarness } from "./github-review-harness.js";

describeEmbeddedPostgres("chat channels: github review finding threads and fallbacks", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rev = createGitHubReviewHarness(h, gh);
  const {
    readChatConversationsByEndpointId,
    readIssueCommentsByIssueId,
    readIssuesById,
    readChatGitHubReviewsByEndpointId,
    readHeartbeatRunsByCompanyId,
    deliverMessage,
  } = h;
  const { signedGitHubWebhookRequest } = gh;
  const {
    reviewBotFixture,
    subscribedGitHubFixture,
    toolReplyFixture,
    publicationRetryFixture,
  } = rev;

  describe("GitHub agent review finding threads and delivery fallbacks", () => {
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
        if (expected === "none") expect(f.responseWrites[1]).toMatchObject({ method: "PATCH", body: expect.stringContaining(
          scenario === "different_run" ? "See the [latest response](https://github.com/paperclipai/paperclip/issues/418)" : "stopped before completing this turn") });
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
  });
});

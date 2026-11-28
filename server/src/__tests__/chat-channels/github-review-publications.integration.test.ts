import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  chatActions,
  chatDeliveries,
  chatEndpoints,
  companySkills,
  heartbeatRuns,
  issueComments,
  issues,
  toolPolicies,
} from "@paperclipai/db";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { chatHistoryActionBlocks } from "../helpers/chat-history-proof.js";
import { githubChatReviewService } from "../../services/chat-github-reviews.js";
import { githubAutomaticReviewEvent } from "../../services/chat-github-events.js";
import { githubResponseCommentService } from "../../services/chat-github-response-comments.js";
import { githubBotToolsForSession } from "../../services/chat-github-tools.js";
import { resolveRunScopedMentionedSkillKeys } from "../../services/heartbeat/run-preparation.js";
import { type TestDb, describeEmbeddedPostgres, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createGitHubReviewHarness } from "./github-review-harness.js";

describeEmbeddedPostgres("chat channels: github review publications", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rev = createGitHubReviewHarness(h, gh);
  const {
    seedCompany,
    readChatConversationsByEndpointId,
    readIssueCommentsByIssueId,
    readChatActionsById,
    readChatGitHubReviewsByEndpointId,
    chatWakeContext,
    deliverMessage,
  } = h;
  const {
    reviewBotFixture,
    subscribedGitHubFixture,
    addPeerGitHubBot,
    toolReplyFixture,
    publicationRetryFixture,
  } = rev;

  describe("GitHub agent review publications", () => {
    it.each([
      ["closed", "e", "already merged or closed, so no review is needed", "finish the task as done"],
      ["closed", "f", "already merged or closed, so no review is needed", "finish the task as done"],
      ["open", "e", "this review is no longer needed", "finish the task as done"],
      ["queued", "e", "a newer automatic review for that commit is already queued", "leave the task open for the queued review"],
    ] as const)("tells a superseded automatic review to stop without waiting on a person: %s, requested head %s",
      async (state, requestedHead, reason, ending) => {
      const f = await toolReplyFixture("github:paperclipai/paperclip:418");
      const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpoint.id));
      const context = githubAutomaticReviewEvent({ action: "opened", repository: { id: 97531, full_name: "paperclipai/paperclip" },
        sender: { id: 42, login: "octocat" }, pull_request: { number: 418, title: "Review", body: "", draft: false,
          base: { sha: "a".repeat(40), ref: "master" }, head: { sha: requestedHead.repeat(40) }, user: { id: 42, login: "octocat" }, labels: [] } },
      randomUUID())!;
      await db.update(chatDeliveries).set({ normalizedEvent: { ...delivery.normalizedEvent, githubAutomatic: { context } } })
        .where(eq(chatDeliveries.id, delivery.id));
      if (state === "queued") await db.insert(chatDeliveries).values({ companyId: delivery.companyId, endpointId: delivery.endpointId,
        conversationId: delivery.conversationId, providerEventId: `newer-${randomUUID()}`, deduplicationKey: `newer-${randomUUID()}`,
        eventKind: delivery.eventKind, state: "received", createdAt: new Date(delivery.createdAt.getTime() + 60_000),
        normalizedEvent: { ...delivery.normalizedEvent, githubAutomatic: { context: { ...context, headSha: "f".repeat(40) } } } });
      f.setSupplementalProviderFetch(async input => String(input).endsWith("/pulls/418")
        ? Response.json({ number: 418, title: "Fix", body: null, state: state === "queued" ? "open" : state, draft: false, head: { sha: "f".repeat(40) },
          base: { sha: "a".repeat(40), ref: "master" }, user: { id: 42, login: "octocat", type: "User" }, labels: [] })
        : undefined);
      const error = await githubChatReviewService(db, f.providerFetch).execute(f.session, "read_pull_request", { section: "metadata" })
        .then(() => null, (caught: unknown) => caught as { message: string; details?: Record<string, unknown> });
      expect(error?.message).toContain(reason);
      expect(error?.message).toContain(ending);
      if (state === "queued") expect(error?.message).not.toContain("finish the task as done");
      if (requestedHead === "f") expect(error?.message).not.toContain("older pull request head");
      expect(error?.message).not.toContain("An authorized person can request");
      expect(error?.details).toMatchObject({ reasonCode: "github_review_superseded", pullRequestClosed: state === "closed",
        newerReviewQueued: state === "queued" });
    });

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
        trigger: "subscribed_message", message: makeMessage({ id: "41903", text: "Check again", userId: "42", userName: "octocat" }) });
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
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "execution_finalization_deadline_exceeded",
        updatedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(heartbeatRuns.id, f.run.id));
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
  });
});

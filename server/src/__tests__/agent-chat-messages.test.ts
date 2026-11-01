import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, authUsers, chatCompletionDeliveries, chatTaskHandoffs, companyMemberships, heartbeatRuns, issueComments, issueThreadInteractions, issues, projects } from "@paperclipai/db";
import type { AgentApiKeyScope } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { sendAgentChatMessage } from "../services/agent-chat-messages.js";
import { withConversationReadState } from "../services/agent-chat-read-state.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { activityService } from "../services/activity.js";
import { recordAcceptedChatHandoff } from "../services/chat-completion-delivery.js";
import { conversationReplay, deliverConversationComments, undeliveredConversationComments } from "../services/agent-conversations.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { CROSS_ISSUE_INFLUENCE_LIMIT } from "../services/cross-issue-influence-limit.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

(support.supported ? describe : describe.skip)("proactive agent chat messages", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
    await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });
  const fixture = () => server.fixture({ connectionScenario: "fresh", apiToolsEnabled: false, disableWakeOnDemand: true });
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const input = { body: "## Morning review\n\nThree PRs need your review.", idempotencyKey: "morning-pr-digest" };
  const send = (f: Fixture, value: unknown = input) => sendAgentChatMessage(server.db, f, value);
  const httpSend = (f: Fixture, value: unknown = input, keyScope: AgentApiKeyScope = { kind: "standard" }, authorizingUserId?: string) => fetch(`${server.apiUrl}/api/agents/me/chat/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId, keyScope, authorizingUserId)}` },
    body: JSON.stringify(value),
  });
  const apiKey = async (f: Fixture, scopeConfig: AgentApiKeyScope = { kind: "standard" }) => {
    const token = `pcp_${randomUUID()}`;
    const [key] = await server.db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId, name: "Chat delivery test",
      responsibleUserId: f.responsibleUserId, scopeConfig, keyHash: createHash("sha256").update(token).digest("hex") }).returning();
    return { ...key, token };
  };
  const keySend = (f: Fixture, token: string, value: unknown = input) => fetch(`${server.apiUrl}/api/agents/me/chat/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-paperclip-run-id": f.runId },
    body: JSON.stringify(value),
  });
  const spendInfluence = (f: Fixture, count: number) => server.db.insert(activityLog).values(Array.from({ length: count }, (_, index) => ({
    companyId: f.companyId, actorType: "agent" as const, actorId: f.agentId, agentId: f.agentId, runId: f.runId,
    action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: f.issueId,
    details: { kind: ["comment", "update", "interaction_resolution"][index % 3] },
  })));

  it.each(["native", "http"])("enforces the shared run cap for %s delivery without creating an empty chat", async transport => {
    const f = await fixture();
    await spendInfluence(f, CROSS_ISSUE_INFLUENCE_LIMIT);
    if (transport === "native") {
      await expect(f.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
        .rejects.toMatchObject({ status: 429, details: { code: "cross_issue_influence_cap_exceeded", cap: CROSS_ISSUE_INFLUENCE_LIMIT } });
    } else {
      const response = await httpSend(f);
      expect(response.status, await response.clone().text()).toBe(429);
      expect(await response.json()).toMatchObject({ details: { code: "cross_issue_influence_cap_exceeded", cap: CROSS_ISSUE_INFLUENCE_LIMIT } });
    }
    const snapshot = await f.snapshot();
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect(snapshot.activity).toHaveLength(CROSS_ISSUE_INFLUENCE_LIMIT);
  });

  it("charges a committed message once across retries, recovery and conflicting content", async () => {
    const f = await fixture(), receipt = (await send(f))!;
    expect((await httpSend(f)).status).toBe(200);
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
      .toMatchObject({ result: { commentId: receipt.commentId, replayed: true } });
    expect((await httpSend(f, { ...input, body: "Different content" })).status).toBe(409);
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: { ...input, idempotencyKey: "not-committed" }, callId: randomUUID() })).toBeNull();
    expect((await f.snapshot()).activity.filter(row => row.action === "issue.cross_issue_influence_observed")).toHaveLength(1);
    expect((await f.snapshot()).comments).toHaveLength(1);
  });

  it("cannot race native and HTTP delivery past the shared final slot", async () => {
    const f = await fixture();
    await spendInfluence(f, CROSS_ISSUE_INFLUENCE_LIMIT - 1);
    const outcomes = await Promise.all([
      f.authority.execute({ tool: "send_chat_message", arguments: { ...input, idempotencyKey: "native-last-slot" }, callId: randomUUID() })
        .then(() => 201, error => error.status),
      httpSend(f, { ...input, idempotencyKey: "http-last-slot" }).then(response => response.status),
    ]);
    expect(outcomes.sort()).toEqual([201, 429]);
    const snapshot = await f.snapshot();
    expect(snapshot.activity.filter(row => row.action === "issue.cross_issue_influence_observed")).toHaveLength(CROSS_ISSUE_INFLUENCE_LIMIT);
    expect(snapshot.comments).toHaveLength(1);
    expect(snapshot.issues.filter(issue => issue.conversationAgentId)).toHaveLength(1);
  });

  it("supports standard task API keys without changing agent and run attribution", async () => {
    const f = await fixture(), key = await apiKey(f);
    const response = await keySend(f, key.token);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await f.snapshot()).activity).toContainEqual(expect.objectContaining({ action: "issue.comment_added",
      actorId: f.agentId, agentId: f.agentId, runId: f.runId, responsibleUserId: f.responsibleUserId }));
  });

  it("preserves an external authorizer's current access intersection", async () => {
    const f = await fixture();
    expect((await httpSend(f, input, { kind: "standard" }, randomUUID())).status).toBe(403);
    await expect(sendAgentChatMessage(server.db, { ...f, authorizingUserId: randomUUID() }, input)).rejects.toMatchObject({ status: 403 });
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect((await f.snapshot()).comments).toEqual([]);
  });

  it("keeps skill-test JWT and API-key scopes confined to their own task", async () => {
    const f = await fixture(), scope = { kind: "skill_test", issueId: f.issueId } as const;
    const key = await apiKey(f, scope);
    expect((await httpSend(f, input, scope)).status).toBe(403);
    expect((await keySend(f, key.token)).status).toBe(403);
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect((await f.snapshot()).comments).toEqual([]);
  });

  it.each(["admitted", "legacy", "saved-task"])("retains a persisted %s skill-test run boundary after task mode changes", async kind => {
    const f = await fixture();
    const contextSnapshot = kind === "admitted" ? { paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issueId } }
      : kind === "legacy" ? { paperclipSkillTest: { id: randomUUID() } }
      : { paperclipIssue: { id: f.issueId, workMode: "skill_test" } };
    await server.db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, f.issueId));
    await server.db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, f.issueId));
    expect((await httpSend(f)).status).toBe(403);
    await expect(sendAgentChatMessage(server.db, f, input, { receiptOnly: true })).rejects.toThrow(/skill.test/i);
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect((await f.snapshot()).comments).toEqual([]);
  });

  it("does not let task-bridge credentials publish outside their admitted task", async () => {
    const f = await fixture(), key = await apiKey(f, { kind: "task_bridge", parentIssueId: f.issueId });
    expect((await keySend(f, key.token)).status).toBe(403);
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
  });

  it.each(["revoked", "narrowed", "responsible-human"])("rechecks a %s API key after waiting for the destination", async kind => {
    const f = await fixture(), receipt = (await send(f))!, key = await apiKey(f);
    let unlock!: () => void, ready!: (pid: number) => void;
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const gate = server.db.transaction(async tx => {
      const [{ pid }] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid() as pid`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, receipt.conversationId)).for("update");
      ready(pid); await release;
    });
    const pid = await locked;
    const delivery = keySend(f, key.token, { ...input, idempotencyKey: "key-after-wait" });
    try {
      await vi.waitFor(async () => {
        const [row] = await server.db.execute(sql<{ blocked: boolean }>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) as blocked`);
        expect(row.blocked).toBe(true);
      }, { timeout: 5_000, interval: 10 });
      await server.db.update(agentApiKeys).set(kind === "revoked" ? { revokedAt: new Date() }
        : kind === "narrowed" ? { scopeConfig: { kind: "skill_test", issueId: f.issueId } }
        : { responsibleUserId: randomUUID() }).where(eq(agentApiKeys.id, key.id));
      unlock(); await gate;
      expect((await delivery).status).toBe(403);
      expect((await f.snapshot()).comments).toHaveLength(1);
    } finally { unlock(); await gate; await delivery; }
  }, 30_000);

  it("publishes through the native tool without generic API tools, without starting a turn or changing the source", async () => {
    const f = await fixture();
    expect(f.authority.definitions().map(d => d.name)).toContain("send_chat_message");
    const before = await issueService(server.db).getById(f.issueId);
    const receipt = await f.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() }) as { commentId: string; conversationId: string; chatUrl: string };
    const snapshot = await f.snapshot();
    const comment = snapshot.comments.find(c => c.id === receipt.commentId)!;
    expect(comment).toMatchObject({ body: input.body, authorAgentId: f.agentId, createdByRunId: f.runId, onBehalfOfUserId: f.responsibleUserId,
      metadata: { chatMessage: { sourceTaskId: f.issueId, sourceRunId: f.runId } } });
    expect(snapshot.issues.find(i => i.id === receipt.conversationId)).toMatchObject({ conversationAgentId: f.agentId,
      conversationUserId: f.responsibleUserId, conversationState: "waiting", executionRunId: null, status: "in_review" });
    expect(await issueService(server.db).getById(f.issueId)).toEqual(before);
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(snapshot.activity.filter(a => a.action === "issue.comment_added")).toHaveLength(1);
    expect(await activityService(server.db).runsForIssue(f.companyId, receipt.conversationId)).toEqual([]);
    expect(receipt.chatUrl).toContain(`/chats/${f.agentId}`);
    expect(await withConversationReadState(server.db, f.companyId, f.responsibleUserId!, [{ id: receipt.conversationId }])).toMatchObject([{ isUnreadForMe: true }]);
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
      .toMatchObject({ result: { commentId: receipt.commentId, replayed: true } });
  });

  it("creates once under concurrent first sends and recovers a committed response across run retries", async () => {
    const f = await fixture();
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() })).toBeNull();
    expect((await f.snapshot()).issues.filter(i => i.conversationAgentId)).toHaveLength(0);
    const [a, b] = await Promise.all([send(f), send(f)]);
    expect(a!.commentId).toBe(b!.commentId);
    expect((await f.snapshot()).comments).toHaveLength(1);
    const other = await send(f, { ...input, idempotencyKey: "second" });
    expect(other!.commentId).not.toBe(a!.commentId);
    await expect(send(f, { ...input, body: "Different digest" })).rejects.toThrow(/different content/);
    const nextRunId = randomUUID();
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId,
      status: "running", nativeIssueId: f.issueId, responsibleUserId: f.responsibleUserId });
    await server.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    expect(await send({ ...f, runId: nextRunId })).toMatchObject({ commentId: a!.commentId, replayed: true });
    expect((await f.snapshot()).comments).toHaveLength(2);
  });

  it("supports HTTP routine delivery during an active chat reply and after a context reset", async () => {
    const f = await fixture();
    await server.db.update(heartbeatRuns).set({ invocationSource: "automation", triggerDetail: "routine" }).where(eq(heartbeatRuns.id, f.runId));
    const first = await httpSend(f);
    expect(first.status, await first.clone().text()).toBe(201);
    const receipt = await first.json();
    const replyRun = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: replyRun, companyId: f.companyId, agentId: f.agentId, status: "running",
      nativeIssueId: receipt.conversationId, responsibleUserId: f.responsibleUserId, contextSnapshot: { issueId: receipt.conversationId, conversationSessionGeneration: 0 } });
    await server.db.update(issues).set({ executionRunId: replyRun, conversationState: "active" }).where(eq(issues.id, receipt.conversationId));
    const before = await issueService(server.db).getById(receipt.conversationId);
    expect((await httpSend(f, { ...input, idempotencyKey: "during-reply" })).status).toBe(201);
    const after = await issueService(server.db).getById(receipt.conversationId);
    expect(after).toMatchObject({ executionRunId: replyRun, conversationState: before!.conversationState, status: before!.status });
    await server.db.update(issues).set({ conversationSessionGeneration: 1, conversationState: "waiting", executionRunId: null }).where(eq(issues.id, receipt.conversationId));
    expect((await httpSend(f, { ...input, idempotencyKey: "after-new" })).status).toBe(201);
    await expect(issueService(server.db).addComment(receipt.conversationId, "Stale reply", { agentId: f.agentId, runId: replyRun })).rejects.toThrow(/earlier session/);
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    expect((await f.snapshot()).comments).toHaveLength(3);
  });

  it("never enqueues a digest during recovery or the next human reply", async () => {
    const f = await fixture(), svc = issueService(server.db);
    const receipt = (await send(f))!;
    const conversation = (await svc.getById(receipt.conversationId))!;
    const enqueue = vi.fn(async (_agentId: string, _options: unknown) => null);
    expect(await undeliveredConversationComments(server.db, f.companyId, conversation.id)).toEqual([]);
    await deliverConversationComments(server.db, conversation, enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    const reply = await svc.addComment(conversation.id, "Which PR should I review first?", { userId: f.responsibleUserId! }, { clientRequestId: randomUUID() });
    expect((await undeliveredConversationComments(server.db, f.companyId, conversation.id)).map(comment => comment.id)).toEqual([reply.id]);
    await deliverConversationComments(server.db, conversation, enqueue);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ requestedByActorType: "user", requestedByActorId: f.responsibleUserId,
      contextSnapshot: { wakeCommentId: reply.id, wakeCommentIds: [reply.id] } });
    expect(await conversationReplay(server.db, f.companyId, conversation.id, reply.id))
      .toContain(JSON.stringify({ author: "agent", body: input.body }));
  });

  it.each([
    { transport: "native", replay: false }, { transport: "native", replay: true },
    { transport: "http", replay: false }, { transport: "http", replay: true },
  ])("serializes $transport delivery with a native chat mutation, replay=$replay", async ({ transport, replay }) => {
    const f = await fixture(), receipt = (await send(f))!, chatRunId = randomUUID();
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 2 } } }).where(eq(agents.id, f.agentId));
    await server.db.insert(heartbeatRuns).values({ id: chatRunId, companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: receipt.conversationId, responsibleUserId: f.responsibleUserId,
      contextSnapshot: { issueId: receipt.conversationId, conversationSessionGeneration: 0 } });
    await server.db.update(issues).set({ executionRunId: chatRunId, conversationState: "active" }).where(eq(issues.id, receipt.conversationId));
    const chat = new PaperclipRunnerToolAuthority(server.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: receipt.conversationId, runId: chatRunId, apiUrl: server.apiUrl, apiToolsEnabled: false });
    let unlock!: () => void, ready!: (pid: number) => void;
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const gate = server.db.transaction(async tx => {
      const [{ pid }] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid() as pid`);
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.agentId)).for("update");
      ready(pid);
      await release;
    });
    const pid = await locked;
    const waitForBlocked = async (count: number) => vi.waitFor(async () => {
      const [row] = await server.db.execute(sql<{ count: number }>`with recursive blocked(pid) as (
        select pid from pg_stat_activity where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))
        union select activity.pid from pg_stat_activity activity join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
        where activity.datname = current_database()
      ) select count(*)::int as count from blocked`);
      expect(row.count).toBeGreaterThanOrEqual(count);
    }, { timeout: 5000, interval: 10 });
    const message = replay ? input : { ...input, idempotencyKey: "concurrent-message" };
    let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let observedDelivery: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const delivery = transport === "native"
        ? f.authority.execute({ tool: "send_chat_message", arguments: message, callId: randomUUID() })
        : httpSend(f, message).then(async response => {
          expect(response.status, await response.clone().text()).toBe(replay ? 200 : 201);
          return response.json();
        });
      observedDelivery = Promise.allSettled([delivery]);
      await waitForBlocked(1);
      const mutation = chat.execute({ tool: "write_document", callId: randomUUID(), arguments: {
        key: "concurrent-note", title: "Concurrent note", body: "The chat reply stays independent.", baseRevisionId: null, idempotencyKey: "concurrent-note",
      } });
      settled = Promise.allSettled([delivery, mutation]);
      await waitForBlocked(2);
      unlock();
      await gate;
      const results = await settled;
      expect(results.map(result => result.status), JSON.stringify(results)).toEqual(["fulfilled", "fulfilled"]);
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { disposition: "applied", document: { key: "concurrent-note" } } });
      expect(await issueService(server.db).getById(receipt.conversationId)).toMatchObject({ conversationState: "active" });
    } finally {
      unlock();
      await gate;
      await settled;
      await observedDelivery;
    }
  }, 30_000);

  it("isolates two humans sharing an agent and two agents serving one human", async () => {
    const f = await fixture();
    const a = await send(f);
    const userId = randomUUID();
    await server.db.insert(authUsers).values({ id: userId, name: "Second human", email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await server.db.update(heartbeatRuns).set({ responsibleUserId: userId }).where(eq(heartbeatRuns.id, f.runId));
    const b = await send(f);
    expect(b!.conversationId).not.toBe(a!.conversationId);
    const [agent] = await server.db.insert(agents).values({ companyId: f.companyId, name: "Second agent", status: "active", adapterType: "process" }).returning();
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent.id, status: "running", issueId: f.issueId, responsibleUserId: userId });
    await server.db.update(issues).set({ assigneeAgentId: agent.id, executionRunId: runId }).where(eq(issues.id, f.issueId));
    const c = await send({ ...f, agentId: agent.id, runId });
    expect(new Set([a!.conversationId, b!.conversationId, c!.conversationId]).size).toBe(3);
    await expect(issueService(server.db).addComment(a!.conversationId, "Wrong agent", { agentId: agent.id, runId })).rejects.toThrow(/Only this conversation/);
    await expect(issueService(server.db).addComment(b!.conversationId, "Bypass", { agentId: f.agentId, runId: f.runId })).rejects.toThrow(/earlier session/);
  });

  it("delivers to its own chat while preserving pending questions and the original handoff completion", async () => {
    const f = await fixture(), svc = issueService(server.db);
    const own = await svc.create(f.companyId, { title: "Own chat", assigneeAgentId: f.agentId,
      conversationAgentId: f.agentId, conversationUserId: f.responsibleUserId!, conversationState: "waiting", status: "in_review" });
    const [coordinator] = await server.db.insert(agents).values({ companyId: f.companyId, name: "Coordinator", status: "active", adapterType: "process" }).returning();
    const origin = await svc.create(f.companyId, { title: "Origin chat", assigneeAgentId: coordinator.id,
      conversationAgentId: coordinator.id, conversationUserId: f.responsibleUserId!, conversationState: "waiting", status: "in_review" });
    await recordAcceptedChatHandoff(server.db, (await svc.getById(f.issueId))!, origin);
    const [question] = await server.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: own.id,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Proceed?" } }).returning();
    expect(await send(f)).toMatchObject({ conversationId: own.id });
    expect(await server.db.select().from(issueComments).where(eq(issueComments.issueId, origin.id))).toEqual([]);
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id))).toEqual([question]);
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    await svc.update(f.issueId, { status: "done" });
    expect(await server.db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.taskId, f.issueId)))
      .toMatchObject([{ status: "pending", responseCommentId: null }]);
    expect(await server.db.select().from(chatTaskHandoffs).where(eq(chatTaskHandoffs.taskId, f.issueId)))
      .toMatchObject([{ conversationId: origin.id, agentId: coordinator.id }]);
  });

  it.each(["ask", "planning", "review", "watchdog", "stopped", "stale", "missing-human", "revoked", "private-task", "private-project", "private-ancestor", "paused-agent"])("rejects %s before creating a chat", async kind => {
    const f = await fixture();
    if (kind === "ask" || kind === "planning") await server.db.update(issues).set({ workMode: kind }).where(eq(issues.id, f.issueId));
    if (kind === "review") await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "watchdog") await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskWatchdog: true, watchedIssueId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "stopped") await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "stale") await server.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    if (kind === "missing-human") await server.db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "revoked") await server.db.delete(companyMemberships).where(eq(companyMemberships.principalId, f.responsibleUserId!));
    if (kind === "private-task") await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    if (kind === "private-project") await server.db.update(projects).set({ visibility: "private", privacyOwnerUserId: f.responsibleUserId }).where(eq(projects.id, f.projectId));
    if (kind === "private-ancestor") {
      await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.blockerId));
      await server.db.update(issues).set({ parentId: f.blockerId, privacyParentIssueId: f.blockerId, privacyRootIssueId: f.blockerId }).where(eq(issues.id, f.issueId));
    }
    if (kind === "paused-agent") await server.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await expect(send(f)).rejects.toThrow();
    expect((await f.snapshot()).comments).toHaveLength(0);
    expect((await f.snapshot()).issues.filter(i => i.conversationAgentId)).toHaveLength(0);
  });

  it("rejects forged destinations and server-owned provenance, and respects the feature gate", async () => {
    const f = await fixture();
    expect((await httpSend(f, { ...input, agentId: f.agentId })).status).toBe(400);
    await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: false });
    try { expect((await httpSend(f)).status).toBe(404); }
    finally { await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: true }); }
    const receipt = await send(f);
    const [comment] = await server.db.select().from(issueComments).where(eq(issueComments.id, receipt!.commentId));
    await expect(issueService(server.db).addComment(f.issueId, "Forged source", { agentId: f.agentId, runId: f.runId }, { metadata: comment.metadata! })).rejects.toThrow(/server-owned/);
  });

  it("keeps unseen concurrent arrivals unread with exact comment cutoffs and monotonic receipts", async () => {
    const f = await fixture();
    const a = (await send(f))!, b = (await send(f, { ...input, idempotencyKey: "later" }))!;
    await server.db.update(issueComments).set({ createdAt: sql`'2026-10-30 12:00:00.123456+00'::timestamptz` }).where(eq(issueComments.id, a.commentId));
    await server.db.update(issueComments).set({ createdAt: sql`'2026-10-30 12:00:00.123789+00'::timestamptz` }).where(eq(issueComments.id, b.commentId));
    const cookie = await server.humanSession(f.responsibleUserId!);
    const mark = (id: string) => fetch(`${server.apiUrl}/api/issues/${a.conversationId}/read`, { method: "POST", headers: { Cookie: cookie, Origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ throughCommentId: id }) });
    const unread = async () => (await withConversationReadState(server.db, f.companyId, f.responsibleUserId!, [{ id: a.conversationId }]))[0].isUnreadForMe;
    const response = await mark(a.commentId);
    expect(response.status, await response.text()).toBe(200);
    expect(await unread()).toBe(true);
    expect((await mark(b.commentId)).status).toBe(200);
    expect(await unread()).toBe(false);
    await mark(a.commentId);
    expect(await unread()).toBe(false);
    const foreign = await server.fixture({ connectionScenario: "fresh" });
    const foreignMessage = (await send(foreign))!;
    expect((await mark(foreignMessage.commentId)).status).toBe(404);
    const chats = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/chats`, { headers: { Cookie: cookie } });
    expect(chats.status).toBe(200);
    expect(await chats.json()).toMatchObject([{ id: a.conversationId, isUnreadForMe: false }]);
  });
});

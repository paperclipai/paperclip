import { createServer } from "node:http";
import { createPullRequestMergeStateResolver } from "../services/github-pull-request-merge.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, chatActions, chatConversations, chatEndpoints, chatPublications, companies, createDb, issues, issueThreadInteractions, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueService } from "../services/issues.js";
import { registerMergeConfirmationWork, MERGE_CONFIRMATION_RECONCILE_MS } from "../services/merged-pr-confirmation-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MERGE_WORK_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("merge confirmation work with PostgreSQL and simulated GitHub", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string, issueId: string, agentId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining = false, standby = false;
  const errors: unknown[] = [];
  const provider = vi.fn(async (_companyId: string, _reference: { number: number }, _signal?: AbortSignal): Promise<"open" | "merged" | "unknown"> => "merged");
  const wakeup = vi.fn(async () => ({ id: "simulated-durable-wake" }));
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("merged-pr-work-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    errors.length = 0; draining = false; standby = false;
    provider.mockReset().mockResolvedValue("merged"); wakeup.mockClear();
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Merge worker", issuePrefix: `M${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Merge task", status: "todo", assigneeAgentId: agentId });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(chatActions); await db.delete(chatPublications); await db.delete(chatConversations); await db.delete(chatEndpoints);
    await db.delete(toolConnections); await db.delete(toolApplications);
    await db.delete(activityLog); await db.delete(issueThreadInteractions); await db.delete(issues);
    await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const service = (database: Db = db) => issueThreadInteractionService(database, { resolvePullRequestState: provider, wakeup });
  const input = (number = 39) => ({ kind: "request_confirmation" as const, title: `Merge paperclipai/paperclip#${number}?`,
    resolverPolicy: "human_only" as const, continuationPolicy: "wake_assignee_on_accept" as const,
    payload: { version: 1 as const, prompt: "Merge the PR?" } });
  const create = (database: Db = db, number = 39) => service(database).create({ id: issueId, companyId }, input(number), { agentId });
  const stored = (id: string) => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)).then(rows => rows[0]);
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining && !standby,
      canReconcile: () => !standby, onError: error => errors.push(error) });
    const worker = registerMergeConfirmationWork(coordinator, service(), () => !draining && !standby);
    await worker.ready;
    return worker;
  }
  async function waitFor(check: () => Promise<void> | void) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await vi.advanceTimersByTimeAsync(1000);
      await delay(10);
      try { await check(); return; } catch (error) { if (attempt === 99) throw error; }
    }
  }
  const settle = () => waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
  async function quiet() {
    await waitFor(() => { expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull(); });
    const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    const calls = provider.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * MERGE_CONFIRMATION_RECONCILE_MS);
    expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(calls);
    reads.mockRestore(); transactions.mockRestore(); executes.mockRestore();
  }

  it("settles empty and configured idle, then ordinary creation accepts, audits, wakes once and becomes quiet with retained history", async () => {
    await start(); await quiet(); expect(provider).not.toHaveBeenCalled();
    const card = await create();
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted"));
    await quiet();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ idempotencyKey: `interaction:${card.id}:accepted`, allowRunCoalescing: false }));
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([expect.objectContaining({
      action: "issue.thread_interaction_accepted", actorId: "system:pr-merged", details: expect.objectContaining({ interactionId: card.id }),
    })]));
    expect(errors).toEqual([]);
  });

  it("reconciles an open candidate at its deadline, never early, then stops after merge", async () => {
    provider.mockResolvedValue("open"); await start(); const card = await create();
    await waitFor(() => expect(provider).toHaveBeenCalledTimes(1)); await settle();
    const dueAt = coordinator!.nextWakeAt()!;
    expect(dueAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(dueAt - Date.now() - 1); expect(provider).toHaveBeenCalledTimes(1);
    provider.mockResolvedValue("merged"); await vi.advanceTimersByTimeAsync(1);
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(provider).toHaveBeenCalledTimes(2); expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("manual cancellation removes the candidate deadline without provider work", async () => {
    provider.mockResolvedValue("open"); await start(); const card = await create();
    await waitFor(() => expect(provider).toHaveBeenCalledTimes(1)); await settle();
    await service().withdrawInteraction({ id: issueId, companyId }, card.id, {}, { agentId });
    await quiet(); expect(provider).toHaveBeenCalledTimes(1); expect(wakeup).not.toHaveBeenCalled();
    expect((await stored(card.id)).status).toBe("cancelled");
  });

  it("does not accept before caller-owned outer commit and forgets a rolled-back create", async () => {
    await start(); await quiet();
    let release!: () => void, created!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const inserted = new Promise<void>(resolve => { created = resolve; });
    let id = "";
    const transaction = db.transaction(async tx => {
      id = (await create(tx as unknown as Db)).id; created(); await barrier;
    });
    await inserted;
    await vi.advanceTimersByTimeAsync(10_000); expect(provider).not.toHaveBeenCalled();
    expect(await stored(id)).toBeUndefined(); release(); await transaction;
    await waitFor(async () => expect((await stored(id)).status).toBe("accepted")); await quiet();
    const prior = provider.mock.calls.length;
    await expect(db.transaction(async tx => { await create(tx as unknown as Db, 41); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await quiet(); expect(provider).toHaveBeenCalledTimes(prior); expect(errors).toEqual([]);
  });

  it("retains provider failures across drain, resumes without overlap, and clears retry after success", async () => {
    provider.mockRejectedValue(new Error("GitHub unavailable")); await start(); const card = await create();
    await waitFor(() => expect(errors).toHaveLength(1)); await settle();
    expect((await stored(card.id)).status).toBe("pending");
    draining = true;
    const reads = vi.spyOn(db, "select"), calls = provider.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); expect(provider).toHaveBeenCalledTimes(calls); reads.mockRestore();
    draining = false; provider.mockResolvedValue("merged");
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("keeps first work committed during drain and startup during standby until resume", async () => {
    standby = true; await start(); const card = await create();
    await vi.advanceTimersByTimeAsync(60_000); expect(provider).not.toHaveBeenCalled();
    standby = false; draining = true;
    await vi.advanceTimersByTimeAsync(60_000); expect(provider).not.toHaveBeenCalled();
    draining = false;
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
  });

  it("reconstructs pending cards on restart and ignores terminal or hidden tasks", async () => {
    provider.mockResolvedValue("open"); const card = await create(); await start();
    await waitFor(() => expect(provider).toHaveBeenCalledTimes(1)); await settle();
    await coordinator!.stop(); coordinator = undefined; provider.mockResolvedValue("merged");
    await start(); await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    const hidden = await db.transaction(async tx => {
      const card = await create(tx as unknown as Db, 41);
      await issueService(tx as unknown as Db).update(issueId, { hiddenAt: new Date() });
      return card;
    });
    await quiet(); expect((await stored(hidden.id)).status).toBe("pending");
    await issueService(db).update(issueId, { hiddenAt: null });
    await waitFor(async () => expect((await stored(hidden.id)).status).toBe("accepted")); await quiet();
  });

  it("preserves a real chat binding's durable continuation outbox on automatic acceptance", async () => {
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:slack:${endpointId}`, name: "Slack", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: endpointId,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId,
      assignedAgentId: agentId, status: "active" });
    const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId, issueId,
      externalConversationId: "merge-channel", externalThreadId: "merge-thread", externalLabel: "Merge thread", state: "active" }).returning();
    await start(); await quiet(); const card = await create();
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(await db.select().from(chatActions).where(eq(chatActions.kind, "interaction_wakeup"))).toEqual([
      expect.objectContaining({ companyId, endpointId, conversationId: conversation.id, providerActionId: `interaction_wakeup:${card.id}`,
        payload: expect.objectContaining({ interactionId: card.id, issueId, agentId, interactionStatus: "accepted" }) }),
    ]);
    expect(await db.select().from(chatPublications)).toEqual(expect.arrayContaining([
      expect.objectContaining({ idempotencyKey: `interaction:${card.id}:${endpointId}`, state: "cancelled" }),
    ]));
    expect(errors).toEqual([]);
  });

  it("does not lose a newer card created during provider observation or wake the superseded card", async () => {
    let release!: () => void, observed!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const observing = new Promise<void>(resolve => { observed = resolve; });
    provider.mockImplementationOnce(async () => { observed(); await barrier; return "merged"; });
    await start(); const old = await create();
    await vi.advanceTimersByTimeAsync(1000); await observing;
    const current = await create(db, 41);
    expect((await stored(old.id)).status).toBe("expired");
    release();
    await waitFor(async () => expect((await stored(current.id)).status).toBe("accepted")); await quiet();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ idempotencyKey: `interaction:${current.id}:accepted` }));
    expect(errors).toEqual([]);
  });

  it("keeps unknown provider results as retryable debt and does not act before retry", async () => {
    provider.mockResolvedValue("unknown"); await start(); const card = await create();
    await waitFor(() => expect(errors).toHaveLength(1));
    const next = coordinator!.nextWakeAt()!;
    await vi.advanceTimersByTimeAsync(next - Date.now() - 1); expect(provider).toHaveBeenCalledTimes(1);
    provider.mockResolvedValue("merged"); await vi.advanceTimersByTimeAsync(1);
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("honors terminal issues, pure merge URL targets and continuationPolicy none", async () => {
    await start(); await quiet();
    const target = await service().create({ id: issueId, companyId }, { ...input(), title: "Merge the linked PR?", continuationPolicy: "none",
      payload: { version: 1, prompt: "Merge the PR?", target: { type: "custom", key: "github-pr-39", href: "https://github.com/paperclipai/paperclip/pull/39" } } }, { agentId });
    await waitFor(async () => expect((await stored(target.id)).status).toBe("accepted")); await quiet();
    expect(wakeup).not.toHaveBeenCalled();
    provider.mockClear();
    const terminal = await db.transaction(async tx => {
      const card = await create(tx as unknown as Db, 41);
      await issueService(tx as unknown as Db).update(issueId, { status: "cancelled" });
      return card;
    });
    await quiet(); expect((await stored(terminal.id)).status).toBe("expired");
    expect(provider).not.toHaveBeenCalled(); expect(wakeup).not.toHaveBeenCalled();
  });

  it("rechecks hidden state under the acceptance lock when visibility changes during a provider read", async () => {
    let release!: () => void, observed!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const observing = new Promise<void>(resolve => { observed = resolve; });
    provider.mockImplementationOnce(async () => { observed(); await barrier; return "merged"; });
    await start(); const card = await create(); await vi.advanceTimersByTimeAsync(1000); await observing;
    await issueService(db).update(issueId, { hiddenAt: new Date() }); release(); await quiet();
    expect((await stored(card.id)).status).toBe("pending"); expect(wakeup).not.toHaveBeenCalled();
    await issueService(db).update(issueId, { hiddenAt: null });
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(wakeup).toHaveBeenCalledTimes(1); expect(errors).toEqual([]);
  });

  it("unrelated pending confirmations do not retain worker SQL or provider work", async () => {
    await start(); await quiet();
    await service().create({ id: issueId, companyId }, { ...input(), title: "Approve the plan?", payload: { version: 1, prompt: "Approve the plan?" } }, { agentId });
    await quiet(); expect(provider).not.toHaveBeenCalled(); expect(wakeup).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("preserves manual acceptance without cancellation and rolls back a failed caller mutation", async () => {
    const card = await create();
    const issue = { id: issueId, companyId, projectId: null, goalId: null };
    await expect(service().acceptInteraction(issue, card.id, {}, { userId: "board" }, {
      afterResolveInTransaction: async () => { throw new Error("manual acceptance rollback"); },
    })).rejects.toThrow("manual acceptance rollback");
    expect((await stored(card.id)).status).toBe("pending");
    const accepted = await service().acceptInteraction(issue, card.id, {}, { userId: "board" });
    expect(accepted.interaction.status).toBe("accepted");
    expect((await stored(card.id)).status).toBe("accepted");
  });

  it.each(["issue lock", "acceptance write"] as const)("keeps a stopped %s acceptance pending and accepts once after restart", async phase => {
    vi.useRealTimers();
    const card = await create();
    let signal: AbortSignal | undefined;
    provider.mockImplementation(async (_companyId, _reference, currentSignal) => { signal = currentSignal; return "merged"; });
    let reserved: Awaited<ReturnType<typeof db.$client.reserve>> | undefined = await db.$client.reserve();
    const [{ pid }] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (phase === "issue lock") {
      await reserved.unsafe("begin");
      await reserved`select id from issues where id=${issueId} for update`;
    } else {
      await db.$client.unsafe(`create function maintenance_hold_merge_acceptance() returns trigger language plpgsql as $$begin
        if new.id = '${card.id}'::uuid and new.status = 'accepted' then perform pg_advisory_xact_lock(930582); end if; return new; end$$`);
      await db.$client.unsafe(`create trigger maintenance_hold_merge_acceptance before update on issue_thread_interactions for each row execute function maintenance_hold_merge_acceptance()`);
      await reserved`select pg_advisory_lock(930582)`;
    }
    let stopping: Promise<void> | undefined;
    try {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      const worker = registerMergeConfirmationWork(coordinator, service(), () => true);
      let blocked: { query: string } | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        [blocked] = await db.$client<{ query: string }[]>`select query from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and ${pid} = any(pg_blocking_pids(pid))`;
        if (blocked) break;
        await delay(10);
      }
      expect(blocked?.query).toContain(phase === "issue lock" ? '"issues"' : '"issue_thread_interactions"');
      let stopped = false;
      stopping = coordinator.stop().then(() => { stopped = true; });
      await delay(20);
      expect(signal?.aborted).toBe(true);
      expect(stopped).toBe(false);
      expect((await stored(card.id)).status).toBe("pending");
      const releasedAt = performance.now();
      if (phase === "issue lock") await reserved.unsafe("commit");
      else await reserved`select pg_advisory_unlock(930582)`;
      reserved.release(); reserved = undefined;
      await stopping; await worker.ready; coordinator = undefined;
      expect(performance.now() - releasedAt).toBeLessThan(1000);
      expect((await stored(card.id)).status).toBe("pending");
      expect(wakeup).not.toHaveBeenCalled();
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_accepted"))).toHaveLength(0);
      expect(await db.select().from(chatActions)).toHaveLength(0);
      await start();
      expect((await stored(card.id)).status).toBe("accepted");
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_accepted"))).toHaveLength(1);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      await quiet();
      expect(wakeup).toHaveBeenCalledTimes(1); expect(errors).toEqual([]);
    } finally {
      if (reserved) {
        if (phase === "issue lock") await reserved.unsafe("rollback");
        else await reserved`select pg_advisory_unlock(930582)`;
        reserved.release();
      }
      await stopping;
      await coordinator?.stop(); coordinator = undefined;
      if (phase === "acceptance write") {
        await db.$client.unsafe("drop trigger if exists maintenance_hold_merge_acceptance on issue_thread_interactions");
        await db.$client.unsafe("drop function if exists maintenance_hold_merge_acceptance()");
      }
    }
  });

  it("awaits an in-flight observation at shutdown and reconstructs its unaccepted card on restart", async () => {
    let release!: () => void, observed!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const observing = new Promise<void>(resolve => { observed = resolve; });
    provider.mockImplementationOnce(async () => { observed(); await barrier; return "merged"; });
    await start(); const card = await create(); await vi.advanceTimersByTimeAsync(1000); await observing;
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await delay(10); expect(stopped).toBe(false); release(); await stopping; coordinator = undefined;
    expect((await stored(card.id)).status).toBe("pending"); expect(wakeup).not.toHaveBeenCalled();
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(2 * MERGE_CONFIRMATION_RECONCILE_MS); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await start(); await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(wakeup).toHaveBeenCalledTimes(1); expect(errors).toEqual([]);
  });

  it.each(["headers", "body", "not-found probe", "public visibility probe"] as const)("cancels an actual unresponsive HTTP %s read promptly at stop", async phase => {
    vi.useRealTimers();
    const card = await create();
    let observed!: () => void, closed!: () => void;
    const requested = new Promise<void>(resolve => { observed = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const signals: AbortSignal[] = [];
    const server = createServer((request, response) => {
      if (phase === "not-found probe" && request.url?.includes("/pulls/")) { response.writeHead(404).end(); return; }
      response.on("close", closed);
      if (phase === "body") { response.writeHead(200, { "content-type": "application/json" }); response.write('{"merged":'); }
      observed();
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected test HTTP address");
    const resolveState = createPullRequestMergeStateResolver(db, {
      requestTimeoutMs: 10_000,
      credentialProvider: () => phase === "public visibility probe" ? { token: "fixture", source: "server_env", secretName: null } : null,
      fetch: (url, init) => { signals.push(init!.signal!); return fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init); },
    });
    const real = issueThreadInteractionService(db, { resolvePullRequestState: resolveState, wakeup });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      const startupAt = performance.now();
      const worker = registerMergeConfirmationWork(coordinator, real, () => true);
      expect(performance.now() - startupAt).toBeLessThan(100);
      await Promise.race([requested, delay(2000).then(() => { throw new Error("HTTP observation did not start"); })]);
      const stoppingAt = performance.now();
      await coordinator.stop(); coordinator = undefined;
      expect(performance.now() - stoppingAt).toBeLessThan(1000);
      await worker.ready;
      await Promise.race([disconnected, delay(1000).then(() => { throw new Error("HTTP request remained open after stop"); })]);
      expect(signals.at(-1)?.aborted).toBe(true);
      expect((await stored(card.id)).status).toBe("pending"); expect(wakeup).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
  });

  it("times out a real unresponsive HTTP read and recovers its durable candidate on restart", async () => {
    vi.useRealTimers(); const card = await create();
    let serveMerge = false, closed!: () => void;
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer((_request, response) => {
      if (serveMerge) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ merged: true, state: "closed" })); return; }
      response.on("close", closed);
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected test HTTP address");
    const real = issueThreadInteractionService(db, { resolvePullRequestState: createPullRequestMergeStateResolver(db, {
      requestTimeoutMs: 100, tokenProvider: () => null,
      fetch: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init),
    }), wakeup });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      const startedAt = performance.now();
      await registerMergeConfirmationWork(coordinator, real, () => true).ready;
      expect(performance.now() - startedAt).toBeLessThan(2000);
      await Promise.race([disconnected, delay(1000).then(() => { throw new Error("Timed out HTTP request remained open"); })]);
      expect(errors).toHaveLength(1); expect((await stored(card.id)).status).toBe("pending"); expect(wakeup).not.toHaveBeenCalled();
      expect(coordinator.nextWakeAt()).not.toBeNull();
      await coordinator.stop(); coordinator = undefined; serveMerge = true;
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      await registerMergeConfirmationWork(coordinator, real, () => true).ready;
      expect((await stored(card.id)).status).toBe("accepted"); expect(wakeup).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
  });

  it("pages beyond a full pending-card page without duplicating the merge parser in SQL", async () => {
    const card = await create();
    const id = BigInt(`0x${card.id.replaceAll("-", "")}`);
    await db.insert(issueThreadInteractions).values(Array.from({ length: 100 }, (_, index) => {
      const hex = (id - BigInt(index + 1)).toString(16).padStart(32, "0");
      return { id: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,
        companyId, issueId, kind: "request_confirmation", title: "Approve the plan?", payload: { version: 1 as const, prompt: "Approve the plan?" } };
    }));
    await start(); expect(provider).not.toHaveBeenCalled();
    await waitFor(async () => expect((await stored(card.id)).status).toBe("accepted")); await quiet();
    expect(provider).toHaveBeenCalledTimes(1); expect(wakeup).toHaveBeenCalledTimes(1); expect(errors).toEqual([]);
  });

  it("limits normalized merge hints to the owning company and matching PR and tolerates duplicates", async () => {
    provider.mockResolvedValue("open"); const own = await create();
    const foreignCompany = randomUUID(), foreignIssue = randomUUID();
    await db.insert(companies).values({ id: foreignCompany, name: "Other company", issuePrefix: "OTH" });
    await db.insert(issues).values({ id: foreignIssue, companyId: foreignCompany, title: "Other", status: "todo" });
    const foreign = await service().create({ id: foreignIssue, companyId: foreignCompany }, input(), { userId: "board" });
    const local = service();
    const hint = [{ companyId, owner: "PAPERCLIPAI", repo: "paperclip", number: 39 }];
    expect((await local.sweepMergedPullRequestConfirmations(hint)).accepted).toBe(1);
    expect((await stored(own.id)).status).toBe("accepted"); expect((await stored(foreign.id)).status).toBe("pending");
    expect(provider).not.toHaveBeenCalled();
    expect((await local.sweepMergedPullRequestConfirmations(hint)).accepted).toBe(0); expect(wakeup).toHaveBeenCalledTimes(1);
  });
});

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { activityLog, agents, companies, createDb, issues, issueThreadInteractions } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { createPullRequestMergeDetailsResolver } from "../services/github-pull-request-merge.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { registerMergeConfirmationWork } from "../services/merged-pr-confirmation-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("merge confirmation rate limits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let issueId: string;
  let agentId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  const wakeup = vi.fn(async () => ({ id: "test-wake" }));

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("merge-confirmation-rate-limit-");
    db = createDb(database.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  });

  beforeEach(async () => {
    errors.length = 0;
    wakeup.mockClear();
    companyId = randomUUID();
    issueId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Merge worker", issuePrefix: `M${companyId.slice(0, 6)}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local",
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Merge task", status: "todo", assigneeAgentId: agentId });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    await coordinator?.stop();
    coordinator = undefined;
    vi.useRealTimers();
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  const service = () => issueThreadInteractionService(db, { resolvePullRequestState: async () => "open", wakeup });
  const input = (number = 39) => ({
    kind: "request_confirmation" as const,
    title: `Merge paperclipai/paperclip#${number}?`,
    resolverPolicy: "human_only" as const,
    continuationPolicy: "wake_assignee_on_accept" as const,
    payload: { version: 1 as const, prompt: "Merge the PR?" },
  });
  const create = () => service().create({ id: issueId, companyId }, input(), { agentId });
  const stored = (id: string) => db.select().from(issueThreadInteractions)
    .where(eq(issueThreadInteractions.id, id)).then(rows => rows[0]);

  async function waitFor(check: () => Promise<void> | void) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await vi.advanceTimersByTimeAsync(1000);
      await delay(10);
      try {
        await check();
        return;
      } catch (error) {
        if (attempt === 99) throw error;
      }
    }
  }

  const settle = () => waitFor(() => expect(idleWorkSnapshot().active).toBe(0));

  it.each(["anonymous", "server_env"] as const)("waits for GitHub's rate-limit reset before checking pending cards again (%s)", async (source) => {
    const first = await create();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId, companyId, title: "Second merge task", status: "todo", assigneeAgentId: agentId,
    });
    const second = await service().create({ id: otherIssueId, companyId }, input(40), { agentId });
    const resetAt = Date.now() + 540_000;
    const fetchGitHub = vi.fn(async (url: string | URL | Request) => {
      if (Date.now() < resetAt) return new Response(null, { status: 429, headers: { "retry-after": "540" } });
      return String(url).includes("/pulls/")
        ? Response.json({ merged: true, state: "closed" })
        : Response.json({ private: false });
    });
    const real = issueThreadInteractionService(db, {
      resolvePullRequestDetails: createPullRequestMergeDetailsResolver(db, {
        credentialProvider: () => source === "server_env"
          ? { token: "fixture", source, secretName: null }
          : null,
        fetch: fetchGitHub,
      }),
      wakeup,
    });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await registerMergeConfirmationWork(coordinator, real, () => true).ready;
    await settle();

    expect(errors).toEqual([]);
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBe(resetAt);
    expect((await stored(first.id)).status).toBe("pending");
    expect((await stored(second.id)).status).toBe("pending");

    await vi.advanceTimersByTimeAsync(resetAt - Date.now() - 1);
    expect(fetchGitHub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(async () => {
      expect((await stored(first.id)).status).toBe("accepted");
      expect((await stored(second.id)).status).toBe("accepted");
    });
    await waitFor(() => expect(coordinator?.nextWakeAt()).toBeNull());
    expect(fetchGitHub).toHaveBeenCalledTimes(source === "server_env" ? 5 : 3);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("preserves the rate-limit deadline when another pull request read fails", async () => {
    const mixed = await service().create({ id: issueId, companyId }, {
      ...input(),
      title: "Merge paperclipai/paperclip#39 and paperclipai/paperclip#40?",
    }, { agentId });
    const resetAt = Date.now() + 540_000;
    const fetchGitHub = vi.fn(async (url: string | URL | Request) => {
      if (Date.now() >= resetAt) return Response.json({ merged: true, state: "closed" });
      return String(url).endsWith("/pulls/39")
        ? new Response(null, { status: 429, headers: { "retry-after": "540" } })
        : new Response(null, { status: 503 });
    });
    const real = issueThreadInteractionService(db, {
      resolvePullRequestDetails: createPullRequestMergeDetailsResolver(db, { tokenProvider: () => null, fetch: fetchGitHub }),
      wakeup,
    });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await registerMergeConfirmationWork(coordinator, real, () => true).ready;
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(fetchGitHub).toHaveBeenCalledTimes(2);

    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId, companyId, title: "Another merge task", status: "todo", assigneeAgentId: agentId,
    });
    const other = await service().create({ id: otherIssueId, companyId }, input(41), { agentId });
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => {
      expect(fetchGitHub).toHaveBeenCalledTimes(2);
      expect(idleWorkSnapshot().active).toBe(0);
    });
    expect(errors).toHaveLength(1);
    expect(coordinator.nextWakeAt()).toBe(resetAt);
    expect((await stored(mixed.id)).status).toBe("pending");
    expect((await stored(other.id)).status).toBe("pending");

    await vi.advanceTimersByTimeAsync(resetAt - Date.now());
    await waitFor(async () => {
      expect((await stored(mixed.id)).status).toBe("accepted");
      expect((await stored(other.id)).status).toBe("accepted");
    });
    await waitFor(() => expect(coordinator?.nextWakeAt()).toBeNull());
    expect(fetchGitHub).toHaveBeenCalledTimes(5);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });
});

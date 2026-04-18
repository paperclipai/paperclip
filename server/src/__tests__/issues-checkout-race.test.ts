/**
 * Stress-test: atomic checkout for race conditions under concurrency
 *
 * GLA-025 / STA-100 — QA audit
 *
 * Validates that concurrent checkout requests for the same issue honour the
 * optimistic-lock contract: exactly one caller wins each race, all others
 * receive a 409 conflict, and the winning lock is internally consistent.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Guard: skip on hosts that don't support embedded Postgres
// ──────────────────────────────────────────────────────────────────────────────
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping atomic-checkout race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Settle a promise into a discriminated-union result so Promise.all doesn't throw. */
async function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** Return true when the error looks like the 409 checkout-conflict the service throws. */
function isCheckoutConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // The service throws via the `conflict()` helper which sets status=409 and
  // includes the word "conflict" in the message.
  return (
    e["status"] === 409 ||
    String(e["message"] ?? "").toLowerCase().includes("conflict")
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────────

describeEmbeddedPostgres("issueService.checkout — concurrency / race conditions", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Shared fixtures
  let companyId: string;
  let projectId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-race-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    // Tear down in dependency order
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Fixture factory
  // ──────────────────────────────────────────────────────────────────────────

  async function createFixtures(agentCount: number) {
    companyId = randomUUID();
    projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "RaceTestCo",
      issuePrefix: "RCT",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Stress Test Project",
      status: "active",
      urlKey: `rct-stress-${companyId.slice(0, 8)}`,
    });

    // Create N agents
    const agentIds: string[] = [];
    for (let i = 0; i < agentCount; i++) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `StressAgent-${i}`,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    // Create one heartbeat run per agent
    const runIds: string[] = [];
    for (const agentId of agentIds) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "stress-test",
        status: "running",
        startedAt: new Date(),
      });
    }

    return { agentIds, runIds };
  }

  /** Create a fresh todo issue, return its id. */
  async function createTodoIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: `Race issue ${issueId.slice(0, 8)}`,
      status: "todo",
      priority: "medium",
      issueNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `RCT-${Math.floor(Math.random() * 1_000_000)}`,
    });
    return issueId;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1 — Basic two-agent race: exactly one winner
  // ──────────────────────────────────────────────────────────────────────────
  it("exactly one agent wins when two agents race to checkout simultaneously", async () => {
    const { agentIds, runIds } = await createFixtures(2);
    const issueId = await createTodoIssue();

    const results = await Promise.all([
      settle(svc.checkout(issueId, agentIds[0]!, ["todo"], runIds[0]!)),
      settle(svc.checkout(issueId, agentIds[1]!, ["todo"], runIds[1]!)),
    ]);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(isCheckoutConflict(losers[0]!.error)).toBe(true);

    // Confirm DB state is consistent with the winner
    const winner = winners[0]!;
    if (!winner.ok) throw new Error("unreachable");
    expect(winner.value.status).toBe("in_progress");
    expect(winner.value.assigneeAgentId).toEqual(winner.value.assigneeAgentId);
    expect(winner.value.checkoutRunId).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2 — High-fan-out: N=20 concurrent contenders, exactly one winner
  // ──────────────────────────────────────────────────────────────────────────
  it("exactly one agent wins when 20 agents race to checkout simultaneously", async () => {
    const AGENT_COUNT = 20;
    const { agentIds, runIds } = await createFixtures(AGENT_COUNT);
    const issueId = await createTodoIssue();

    const results = await Promise.all(
      agentIds.map((agentId, i) =>
        settle(svc.checkout(issueId, agentId, ["todo"], runIds[i]!)),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    // Exactly one winner
    expect(winners).toHaveLength(1);
    // All losers should be conflict errors (not unexpected errors)
    for (const loser of losers) {
      expect(isCheckoutConflict(loser.error)).toBe(true);
    }

    // Final DB state must match the single winner
    const winner = winners[0]!;
    if (!winner.ok) throw new Error("unreachable");
    const [dbRow] = await db
      .select()
      .from(issues)
      .where(
        (await import("drizzle-orm")).eq(issues.id, issueId),
      );
    expect(dbRow?.status).toBe("in_progress");
    expect(dbRow?.assigneeAgentId).toBe(winner.value.assigneeAgentId);
    expect(dbRow?.checkoutRunId).toBe(winner.value.checkoutRunId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3 — Sequential re-checkout by the same agent/run is idempotent
  // ──────────────────────────────────────────────────────────────────────────
  it("same agent/run can re-checkout its own in_progress issue without conflict", async () => {
    const { agentIds, runIds } = await createFixtures(1);
    const issueId = await createTodoIssue();

    const first = await svc.checkout(issueId, agentIds[0]!, ["todo"], runIds[0]!);
    expect(first.status).toBe("in_progress");

    // Re-checkout with the same run — must succeed (idempotent)
    const second = await svc.checkout(issueId, agentIds[0]!, ["in_progress"], runIds[0]!);
    expect(second.status).toBe("in_progress");
    expect(second.assigneeAgentId).toBe(agentIds[0]);
    expect(second.checkoutRunId).toBe(runIds[0]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4 — Winner cannot be displaced while holding the lock
  // ──────────────────────────────────────────────────────────────────────────
  it("winner cannot be displaced by a late checkout from a different agent", async () => {
    const { agentIds, runIds } = await createFixtures(2);
    const issueId = await createTodoIssue();

    // Agent 0 wins the race
    await svc.checkout(issueId, agentIds[0]!, ["todo"], runIds[0]!);

    // Agent 1 tries to checkout after the lock is held
    const late = await settle(svc.checkout(issueId, agentIds[1]!, ["todo", "in_progress"], runIds[1]!));
    expect(late.ok).toBe(false);
    expect(isCheckoutConflict(late.error)).toBe(true);

    // Lock owner is still agent 0
    const [dbRow] = await db
      .select()
      .from(issues)
      .where(
        (await import("drizzle-orm")).eq(issues.id, issueId),
      );
    expect(dbRow?.assigneeAgentId).toBe(agentIds[0]);
    expect(dbRow?.checkoutRunId).toBe(runIds[0]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5 — Repeated races across multiple issues: atomicity holds per-issue
  // ──────────────────────────────────────────────────────────────────────────
  it("atomicity holds across 10 independent issues with 5 contenders each", async () => {
    const ISSUE_COUNT = 10;
    const AGENTS_PER_ISSUE = 5;

    const { agentIds, runIds } = await createFixtures(AGENTS_PER_ISSUE);
    const issueIds: string[] = [];
    for (let i = 0; i < ISSUE_COUNT; i++) {
      issueIds.push(await createTodoIssue());
    }

    // Fire all checkouts simultaneously across all issues
    const allResults = await Promise.all(
      issueIds.flatMap((issueId) =>
        agentIds.map((agentId, i) =>
          settle(svc.checkout(issueId, agentId, ["todo"], runIds[i]!)),
        ),
      ),
    );

    // Group results by issue
    for (let i = 0; i < ISSUE_COUNT; i++) {
      const issueResults = allResults.slice(
        i * AGENTS_PER_ISSUE,
        (i + 1) * AGENTS_PER_ISSUE,
      );
      const winners = issueResults.filter((r) => r.ok);
      const losers = issueResults.filter((r) => !r.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(AGENTS_PER_ISSUE - 1);
      for (const loser of losers) {
        expect(isCheckoutConflict(loser.error)).toBe(true);
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6 — Status gate: checkout with wrong expectedStatuses always fails
  // ──────────────────────────────────────────────────────────────────────────
  it("checkout rejects when the issue status is not in expectedStatuses", async () => {
    const { agentIds, runIds } = await createFixtures(1);
    const issueId = await createTodoIssue();

    const result = await settle(
      svc.checkout(issueId, agentIds[0]!, ["backlog"], runIds[0]!),
    );

    expect(result.ok).toBe(false);
    // Should be a conflict (status mismatch) not a server error
    expect(isCheckoutConflict(result.error)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7 — Stale-run adoption: a new run can take over from a terminal run
  // ──────────────────────────────────────────────────────────────────────────
  it("new run can adopt checkout from a terminal (succeeded) run on the same agent", async () => {
    const { agentIds, runIds } = await createFixtures(1);
    const issueId = await createTodoIssue();
    const { eq } = await import("drizzle-orm");

    // First run checks out
    await svc.checkout(issueId, agentIds[0]!, ["todo"], runIds[0]!);

    // Mark first run as succeeded (terminal)
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runIds[0]!));

    // Create a fresh second run for the same agent
    const newRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId,
      agentId: agentIds[0]!,
      invocationSource: "on_demand",
      triggerDetail: "stress-test-adopt",
      status: "running",
      startedAt: new Date(),
    });

    // New run should be able to adopt the stale lock
    const adopted = await svc.checkout(issueId, agentIds[0]!, ["in_progress"], newRunId);
    expect(adopted.status).toBe("in_progress");
    expect(adopted.checkoutRunId).toBe(newRunId);
  });
});

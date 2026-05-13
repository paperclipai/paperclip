/**
 * Phase-4 4c-3 — mc-dispatch fallback service (Wave 1 stub).
 *
 * Wave 1 tests the eligibility-decision-recording. Actual MC-process-spawn
 * is gated behind 4c-2 + Marco-Decision and not exercised here.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcDispatchFallbackService } from "../services/mc-dispatch-fallback.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping mc-dispatch-fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("mc-dispatch-fallback service (Phase-4 4c-3 wave 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mc-fallback-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRuns);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "test-co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedIssue(status = "todo"): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "fixture",
      status,
      priority: "medium",
      createdByUserId: "user-1",
    });
    return issueId;
  }

  async function seedActiveLock(issueId: string): Promise<string> {
    const runId = randomUUID();
    await db.insert(issueRuns).values({
      runId,
      companyId,
      issueId,
      executor: "hermes",
      leaseOwner: "worker-1",
      leasedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 900_000),
      heartbeatAt: new Date(),
      status: "running",
    });
    return runId;
  }

  it("evaluate: eligible when issue exists, no lock, not blocked", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = mcDispatchFallbackService(db);

    const result = await svc.evaluate({ companyId, issueId });
    expect(result.eligible).toBe(true);
  });

  it("evaluate: not eligible when issue does not exist", async () => {
    await seedCompany();
    const svc = mcDispatchFallbackService(db);
    const result = await svc.evaluate({ companyId, issueId: randomUUID() });
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toBe("issue-not-found");
  });

  it("evaluate: not eligible when active lock present", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    await seedActiveLock(issueId);
    const svc = mcDispatchFallbackService(db);

    const result = await svc.evaluate({ companyId, issueId });
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toBe("lock-active");
  });

  it("evaluate: not eligible when issue status is blocked", async () => {
    await seedCompany();
    const issueId = await seedIssue("blocked");
    const svc = mcDispatchFallbackService(db);

    const result = await svc.evaluate({ companyId, issueId });
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toBe("issue-blocked");
  });

  it("evaluate: not eligible when company mismatch", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = mcDispatchFallbackService(db);

    const result = await svc.evaluate({ companyId: randomUUID(), issueId });
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toBe("issue-not-found");
  });

  it("recordDecision: dryRun returns accepted-dry-run without lock create", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = mcDispatchFallbackService(db);

    const result = await svc.recordDecision({
      companyId,
      issueId,
      issueRunId: null,
      fallbackFrom: "hermes",
      reason: "hermes_down_2m",
      dryRun: true,
    });
    expect(result.outcome).toBe("accepted-dry-run");
    expect(result.warnings.length).toBeGreaterThan(0);

    const locks = await db.select().from(issueRuns);
    expect(locks.length).toBe(0);
  });

  it("recordDecision: rejects with hold_and_alert when dryRun=false (4c-2 pending)", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = mcDispatchFallbackService(db);

    const result = await svc.recordDecision({
      companyId,
      issueId,
      issueRunId: null,
      fallbackFrom: "hermes",
      reason: "hermes_down_2m",
      dryRun: false,
    });
    expect(result.outcome).toBe("rejected-hold-and-alert");
    expect(result.warnings.some((w) => w.includes("MC-spawn integration not yet wired"))).toBe(true);
  });

  it("recordDecision: rejected-lock-active when active lock present", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const lockedRunId = await seedActiveLock(issueId);
    const svc = mcDispatchFallbackService(db);

    const result = await svc.recordDecision({
      companyId,
      issueId,
      issueRunId: null,
      fallbackFrom: "hermes",
      reason: "hermes_down_2m",
      dryRun: true,
    });
    expect(result.outcome).toBe("rejected-lock-active");
    expect(result.issueRunId).toBe(lockedRunId);
  });

  it("recordDecision: rejected-issue-blocked when status blocked", async () => {
    await seedCompany();
    const issueId = await seedIssue("closed");
    const svc = mcDispatchFallbackService(db);

    const result = await svc.recordDecision({
      companyId,
      issueId,
      issueRunId: null,
      fallbackFrom: "hermes",
      reason: "hermes_down_2m",
      dryRun: true,
    });
    expect(result.outcome).toBe("rejected-issue-blocked");
  });

  it("recordDecision: throws notFound for missing issue", async () => {
    await seedCompany();
    const svc = mcDispatchFallbackService(db);

    await expect(
      svc.recordDecision({
        companyId,
        issueId: randomUUID(),
        issueRunId: null,
        fallbackFrom: "hermes",
        reason: "hermes_down_2m",
        dryRun: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

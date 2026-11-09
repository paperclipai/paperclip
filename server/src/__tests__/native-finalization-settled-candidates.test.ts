import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  statusDecisionEffects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const captured = vi.hoisted(() => ({ counts: [] as number[] }));
class StopAfterCandidateScan extends Error {}
vi.mock("../services/native-runtime/native-reconciliation-timing.js", () => ({
  createNativeReconciliationPassTiming: () => ({
    phase: (name: string) => {
      if (name === "candidates") throw new StopAfterCandidateScan();
    },
    candidates: (count: number) => { captured.counts.push(count); },
    finish: () => undefined,
  }),
}));

const {
  NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS,
  reconcileNativeFinalizations,
  resetSettledCommittedUpkeepForTests,
} = await import("../services/native-runtime/native-finalization-reconciler.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;

async function candidateCount(pass: Promise<unknown>) {
  await expect(pass).rejects.toBeInstanceOf(StopAfterCandidateScan);
  return captured.counts.at(-1);
}

describeEmbeddedPostgres("native finalization candidate selection", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-settled-candidates-");
    db = createDb(temporary.connectionString);
  }, 30_000);

  beforeEach(async () => {
    captured.counts = [];
    resetSettledCommittedUpkeepForTests();
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settled", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Native", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Settled work", status: "done" });
  });

  afterEach(async () => {
    await db.delete(statusDecisionEffects);
    await db.delete(nativeRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function committedRun(options: { status?: string; finishedAgoMs?: number | null; decisionId?: string } = {}) {
    const runId = randomUUID();
    const finishedAgoMs = options.finishedAgoMs === undefined ? 2 * HOUR_MS : options.finishedAgoMs;
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId,
      status: options.status ?? "succeeded",
      runtimeMode: "native",
      nativeIssueId: issueId,
      finishedAt: finishedAgoMs === null ? null : new Date(Date.now() - finishedAgoMs),
      contextSnapshot: { issueId },
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.insert(nativeRunFinalizations).values({
        runId, companyId, issueId, phase: "committed",
        resultId: randomUUID(),
        ...(options.decisionId ? { assessmentId: randomUUID(), decisionId: options.decisionId } : {}),
      });
    });
    return runId;
  }

  it("skips settled committed rows outside the upkeep rotation and rotates through them", async () => {
    const settled = NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS * 2 + 5;
    for (let index = 0; index < settled; index++) await committedRun();

    const counts = [];
    for (let pass = 0; pass < 4; pass++) counts.push(await candidateCount(reconcileNativeFinalizations(db)));

    expect(counts).toEqual([
      NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS,
      NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS,
      5,
      NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS,
    ]);
  });

  async function fillUpkeepPage() {
    for (let index = 0; index < NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS + 2; index++) await committedRun();
  }

  it("keeps committed rows that finished within the grace window or have not finished", async () => {
    await fillUpkeepPage();
    const protectedRows = 12;
    for (let index = 0; index < protectedRows; index++) {
      const variant = index % 3;
      if (variant === 0) await committedRun({ finishedAgoMs: 10 * 60 * 1000 });
      else if (variant === 1) await committedRun({ status: "running", finishedAgoMs: null });
      else await committedRun({ status: "succeeded", finishedAgoMs: null });
    }

    expect(await candidateCount(reconcileNativeFinalizations(db)))
      .toBe(NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS + protectedRows);
  });

  it("keeps settled committed rows whose decision has an undelivered effect", async () => {
    await fillUpkeepPage();
    const protectedRows = 12;
    for (let index = 0; index < protectedRows; index++) {
      const decisionId = randomUUID();
      await committedRun({ decisionId });
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.insert(statusDecisionEffects).values({
          companyId, issueId, decisionId, ordinal: 0, effectKind: "wake", targetType: "agent",
          idempotencyKey: randomUUID(), payload: {}, deliveryState: index % 2 === 0 ? "failed" : "pending",
        });
      });
    }

    expect(await candidateCount(reconcileNativeFinalizations(db)))
      .toBe(NATIVE_SETTLED_COMMITTED_UPKEEP_PER_PASS + protectedRows);
  });

  it("reconciles a settled row when a pass names it explicitly", async () => {
    const runId = await committedRun();
    await committedRun();

    expect(await candidateCount(reconcileNativeFinalizations(db, [runId]))).toBe(1);
  });
});

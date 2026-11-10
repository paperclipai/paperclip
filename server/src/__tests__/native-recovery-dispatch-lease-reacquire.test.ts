import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, budgetPolicies, budgetReservations, companies, costEvents, createDb, environmentLeases, heartbeatRuns, issues,
  nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recheckRunBudgetReservationInTransaction, reserveRunBudget } from "../services/budget-reservations.js";
import { currentNativeControllerIdentity, type NativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";

const GENERATION = 2;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("budget admission of a restart claim whose lease lapsed in a time jump", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let controller: NativeControllerIdentity;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-recovery-dispatch-lease-");
    db = createDb(database.connectionString);
    controller = await currentNativeControllerIdentity();
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  function claimEntry(overrides: Record<string, unknown> = {}) {
    return { at: new Date().toISOString(), restartKind: "hard", controllerBootId: controller.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt.toISOString(),
      controllerGeneration: GENERATION, disposition: "resume_dead_runner", reason: "dead_runner_with_exact_provider_checkpoint",
      stateRootAction: "reuse_exact_root", recoveryRequestId: null, providerAttempt: 1, ...overrides };
  }

  async function seed(options: {
    recoveryState?: string; history?: Array<Record<string, unknown>>; bootId?: string; remote?: boolean;
    overBudget?: boolean;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Time jump", issuePrefix: `T${companyId.slice(0, 4)}`.toUpperCase() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex", role: "engineer", status: "idle",
      adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Resumed task", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment",
      issueId: issue!.id, nativeIssueId: issue!.id, runtimeMode: "native", status: "running",
      contextSnapshot: { issueId: issue!.id } }).returning();
    const leaseOwner = `${controller.bootId}:${GENERATION}:${randomUUID()}`;
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue!.id, runId: run!.id, phase: "observed",
      attempt: 1, leaseOwner, leaseExpiresAt: sql`clock_timestamp() - interval '40 minutes'`,
      controllerBootId: options.bootId ?? controller.bootId, controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: GENERATION,
      recoveryState: options.recoveryState ?? "resuming_session", recoveryHistory: options.history ?? [claimEntry()] });
    if (options.remote) await db.insert(environmentLeases).values({ companyId, issueId: issue!.id,
      heartbeatRunId: run!.id, provider: "daytona" });
    if (options.overBudget) {
      await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents",
        windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, notifyEnabled: false });
      await db.insert(costEvents).values({ companyId, agentId, provider: "openai", model: "gpt", costCents: 250,
        occurredAt: new Date(), costStatus: "reported" });
    }
    const coordinator = async () => (await db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, run!.id)))[0]!;
    return { companyId, runId: run!.id, leaseOwner, coordinator };
  }

  it("takes back the lease of its own restart claim and admits the resume", async () => {
    const f = await seed();
    const reserved = await reserveRunBudget(db, f.companyId, f.runId, null, {}, f.leaseOwner);
    expect(reserved).not.toHaveProperty("admissionBlockReason");
    const saved = await f.coordinator();
    expect(saved.leaseOwner).toBe(f.leaseOwner);
    expect(saved.recoveryState).toBe("resuming_session");
    expect(saved.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  it("still refuses a resume that is over its hard-stop budget", async () => {
    const f = await seed({ overBudget: true });
    const refusal = await reserveRunBudget(db, f.companyId, f.runId, null, {}, f.leaseOwner)
      .then(result => "admissionBlockReason" in result ? String(result.admissionBlockReason) : null,
        (error: Error) => error.message);
    expect(refusal).toMatch(/budget/i);
    expect((await f.coordinator()).leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it("takes the lease back at the dispatch gate only when the resume is admitted", async () => {
    const admitted = await seed();
    const [reservation] = await db.insert(budgetReservations).values({ companyId: admitted.companyId, runId: admitted.runId,
      agentId: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.runId)))[0]!.agentId,
      amountCents: "0", state: "held", providerStartedAt: new Date() }).returning();
    const gate = async (f: Awaited<ReturnType<typeof seed>>, reservationId: string) => db.transaction(async tx => {
      const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      return recheckRunBudgetReservationInTransaction(tx as unknown as Db, [], run!, reservationId, f.leaseOwner);
    });
    expect(await gate(admitted, reservation!.id)).toBeNull();
    expect((await admitted.coordinator()).leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);

    const fenced = await seed({ recoveryState: "awaiting_evidence" });
    const [fencedReservation] = await db.insert(budgetReservations).values({ companyId: fenced.companyId, runId: fenced.runId,
      agentId: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fenced.runId)))[0]!.agentId,
      amountCents: "0", state: "held", providerStartedAt: new Date() }).returning();
    const before = await fenced.coordinator();
    expect(await gate(fenced, fencedReservation!.id)).toBe("Native recovery no longer owns provider dispatch");
    expect(await fenced.coordinator()).toEqual(before);
  });

  it.each<[string, () => Parameters<typeof seed>[0]]>([
    ["a graceful shutdown suspended the claim", () => ({ recoveryState: "awaiting_runner_reattach", history: [
      claimEntry({ disposition: "reattach_existing_runner" }),
      { at: new Date().toISOString(), restartKind: "graceful", disposition: "restart_suspended", reason: "SIGTERM" }] })],
    ["failure settlement appended its outcome", () => ({ history: [claimEntry(),
      { at: new Date().toISOString(), disposition: "retryable_failure", reason: "native_session_lease_lost" }] })],
    ["recovery now waits for evidence", () => ({ recoveryState: "awaiting_evidence" })],
    ["the run is blocked", () => ({ recoveryState: "blocked" })],
    ["the claim belongs to an earlier generation", () => ({ history: [claimEntry({ controllerGeneration: GENERATION - 1 })] })],
    ["another boot owns the row", () => ({ bootId: `boot-${randomUUID()}` })],
    ["the run executes on a remote sandbox", () => ({ remote: true })],
  ])("stays fenced out when %s", async (_name, options) => {
    const f = await seed(options());
    const before = await f.coordinator();
    await expect(reserveRunBudget(db, f.companyId, f.runId, null, {}, f.leaseOwner))
      .rejects.toThrow("Native recovery no longer owns provider dispatch");
    expect(await f.coordinator()).toEqual(before);
  });

  it("stays fenced out when another owner holds the claim", async () => {
    const f = await seed();
    await expect(reserveRunBudget(db, f.companyId, f.runId, null, {}, `${controller.bootId}:${GENERATION}:${randomUUID()}`))
      .rejects.toThrow("Native recovery no longer owns provider dispatch");
  });
});

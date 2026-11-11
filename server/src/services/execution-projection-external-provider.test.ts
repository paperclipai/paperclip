import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, dotAgentBindings, dotRunnerAssignments, dotRunnerOperations, heartbeatRuns,
  issues, museAgentBindings, museRunnerAssignments, museRunnerOperations, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "./execution-projection.js";

const support = await getEmbeddedPostgresTestSupport();
const now = new Date("2026-10-13T18:36:00Z");
(support.supported ? describe : describe.skip)("external provider acceptance projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    // Always a disposable test database; never use an operator's DATABASE_URL.
    database = await startEmbeddedPostgresTestDatabase("external-provider-projection-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(provider: "muse" | "openai_dot", options: {
    companyId?: string; generation?: number; revoked?: boolean;
    claimed?: boolean; nativeAccepted?: boolean; assignmentCompanyId?: string;
  } = {}) {
    const companyId = options.companyId ?? randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), bindingId = randomUUID(), assignmentId = randomUUID();
    if (!options.companyId) await db.insert(companies).values({ id: companyId, name: "Projection test", issuePrefix: `W${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "External agent", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Assigned work", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", driverKind: provider === "muse" ? "muse_external" : "openai_dot_mcp", startedAt: now });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
      leaseExpiresAt: new Date(now.getTime() + 60_000), controllerGeneration: 1 });
    const binding = { id: bindingId, companyId, agentId, operatorId: "projection-operator", generation: 1,
      status: "ready" as const, revokedAt: options.revoked ? now : null };
    const assignment = { id: assignmentId, companyId: options.assignmentCompanyId ?? companyId, agentId, bindingId,
      bindingGeneration: options.generation ?? 1, runId, normalizedSessionId: randomUUID(), turnId: randomUUID(),
      controllerGeneration: 1, catalogDigest: "projection-test", projection: {},
      acceptBy: new Date(now.getTime() + 60_000), expiresAt: new Date(now.getTime() + 120_000) };
    if (provider === "muse") {
      await db.insert(museAgentBindings).values(binding);
      await db.insert(museRunnerAssignments).values({ ...assignment,
        status: options.claimed ? "claimed" : "offered", claimedAt: options.claimed ? now : null,
        nativeAcceptedAt: options.nativeAccepted ? now : null });
    } else {
      await db.insert(dotAgentBindings).values(binding);
      await db.insert(dotRunnerAssignments).values({ ...assignment, status: "offered", acceptedAt: options.nativeAccepted ? now : null });
    }
    return { companyId, runId, assignmentId, project: () => executionProjectionsForRuns(db, companyId, [runId], now) };
  }

  it("batches Muse offered/claimed and Dot offered runs without calling them working", async () => {
    const muse = await fixture("muse");
    const claimed = await fixture("muse", { companyId: muse.companyId, claimed: true });
    const dot = await fixture("openai_dot", { companyId: muse.companyId });
    // Reservation/claim is not the Runner's native acceptance receipt.
    for (const [table, assignmentId] of [[museRunnerOperations, claimed.assignmentId], [dotRunnerOperations, dot.assignmentId]] as const) {
      await db.insert(table).values({ companyId: muse.companyId, assignmentId, requestId: randomUUID(),
        digest: "reserved-accept", command: { action: "accept" }, status: "reserved" });
    }
    const select = vi.spyOn(db, "select");
    try {
      const projections = await executionProjectionsForRuns(db, muse.companyId, [muse.runId, claimed.runId, dot.runId], now);
      expect(projections.get(muse.runId)).toMatchObject({ phase: "waiting_for_provider", label: "Waiting for Muse" });
      expect(projections.get(claimed.runId)).toMatchObject({ phase: "waiting_for_provider", label: "Waiting for Muse" });
      expect(projections.get(dot.runId)).toMatchObject({ phase: "waiting_for_provider", label: "Waiting for Dot" });
      // Runs, coordinators, interactions, recoveries, and one read per provider.
      expect(select).toHaveBeenCalledTimes(6);
    } finally { select.mockRestore(); }
  });

  it.each(["muse", "openai_dot"] as const)("uses the %s native acceptance timestamp, then respects terminal status", async provider => {
    const f = await fixture(provider, { claimed: true });
    expect((await f.project()).get(f.runId)?.phase).toBe("waiting_for_provider");
    if (provider === "muse") await db.update(museRunnerAssignments).set({ nativeAcceptedAt: now }).where(eq(museRunnerAssignments.id, f.assignmentId));
    else await db.update(dotRunnerAssignments).set({ acceptedAt: now }).where(eq(dotRunnerAssignments.id, f.assignmentId));
    expect((await f.project()).get(f.runId)).toMatchObject({ phase: "working", label: "Working" });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_provider_terminal_failed", finishedAt: now }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.project()).get(f.runId)).toMatchObject({ phase: "failed", label: "Failed" });
  });

  it("does not treat an expired controller lease as confirmed provider waiting", async () => {
    const f = await fixture("muse");
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(now.getTime() - 1) }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await f.project()).get(f.runId)).toMatchObject({ phase: "reconnecting", label: "Confirming execution" });
  });

  it("isolates company, requested run, binding generation and revocation", async () => {
    const own = await fixture("muse"), foreign = await fixture("muse");
    const stale = await fixture("muse", { companyId: own.companyId, generation: 2 });
    const revoked = await fixture("openai_dot", { companyId: own.companyId, revoked: true });
    const wrongCompany = await fixture("muse", { companyId: own.companyId, assignmentCompanyId: foreign.companyId });
    const omitted = await fixture("openai_dot", { companyId: own.companyId });
    const projections = await executionProjectionsForRuns(db, own.companyId,
      [own.runId, foreign.runId, stale.runId, revoked.runId, wrongCompany.runId], now);
    expect(projections.get(own.runId)?.phase).toBe("waiting_for_provider");
    expect(projections.has(foreign.runId)).toBe(false);
    expect(projections.has(omitted.runId)).toBe(false);
    for (const runId of [stale.runId, revoked.runId, wrongCompany.runId]) {
      expect(projections.get(runId)?.phase).toBe("working");
    }
  });
});

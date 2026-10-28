import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";
import { readUpgradeReadiness, summarizeUpgradeReadiness } from "./upgrade-readiness.js";
const idle = { activeRuns: 0, pendingWakes: 0, draining: false };
const report = (patch: Partial<Parameters<typeof summarizeUpgradeReadiness>[0]> = {}) =>
  summarizeUpgradeReadiness({ rows: [{ id: "remote", recoverable: true }],
    before: { ...idle, activeRuns: 1 }, after: { ...idle, activeRuns: 1 },
    activeRunIds: ["remote"], controllerBootId: "this-boot", ...patch });
describe("upgrade readiness", () => {
  it("allows a known recoverable execution without stopping admission", () => {
    expect(report()).toMatchObject({ ready: true, activeRuns: 1, recoverableRuns: 1, blockingRuns: 0, draining: false });
  });
  it("retains an execution without positive recovery evidence as a blocker", () => {
    expect(report({ rows: [{ id: "remote", recoverable: false }] })).toMatchObject({ ready: false, blockingRuns: 1 });
  });
  it("blocks a new execution that appears while the query is in flight", () => {
    expect(report({ activeRunIds: ["remote", "new"], after: { ...idle, activeRuns: 2 } })).toMatchObject({ ready: false, activeRuns: 2, blockingRuns: 1 });
  });
  it("blocks an untracked execution promise and pending admission", () => {
    expect(report({ after: { ...idle, activeRuns: 2 } }).ready).toBe(false);
    expect(report({ after: { ...idle, activeRuns: 1, pendingWakes: 1 } }).ready).toBe(false);
    expect(report({ before: { ...idle, activeRuns: 1, draining: true } }).ready).toBe(false);
  });
  it("never treats a truncated census as complete", () => {
    const rows = Array.from({ length: 1_001 }, (_, i) => ({ id: String(i), recoverable: true }));
    expect(report({ rows, activeRunIds: [] })).toMatchObject({ ready: false, truncated: true });
  });
});

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_UPGRADE_READINESS_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const postgresTests = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Upgrade readiness SQL tests unavailable: ${support.reason}`);
postgresTests("upgrade readiness persisted execution evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      database = { connectionString: externalUrl, cleanup: async () => {} };
    } else database = await startEmbeddedPostgresTestDatabase("paperclip-upgrade-readiness-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  it("requires a bound checkpoint and current owner rather than a native label or live process alone", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const owner = await currentNativeControllerIdentity();
    await db.insert(companies).values({ id: companyId, name: "Upgrade", issuePrefix: `U${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Upgrade", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic upgrade", status: "in_progress", assigneeAgentId: agentId });
    const execution = { runtimeMode: "native", runnerInstanceId: randomUUID(), nativeSessionId: randomUUID(), processPid: process.pid, processStartedAt: new Date() };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, status: "running", ...execution });
    const lease = { controllerBootId: owner.bootId, leaseOwner: "current-lease", controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 60_000) };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", ...lease });
    const input = { activeRunIds: new Set([runId]), counters: () => ({ ...idle, activeRuns: 1 }) };
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    // Only the existing journal's metadata is inspected; no checkpoint decoding belongs to this report.
    await db.insert(nativeRunnerCheckpoints).values({ runId, companyId, issueId, part: "header", material: {} });
    expect(await readUpgradeReadiness(db, input)).toMatchObject({ ready: true, recoverableRuns: 1 });
    for (const patch of [{ runtimeMode: "legacy" }, { runnerInstanceId: null }, { nativeSessionId: null }, { processPid: null }, { processStartedAt: null }]) {
      await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
      await db.update(heartbeatRuns).set(execution).where(eq(heartbeatRuns.id, runId));
    }
    for (const patch of [{ leaseOwner: null }, { controllerGeneration: 0 }, { controllerBootId: "foreign" }, { leaseExpiresAt: new Date(0) }, { failureCode: "uncertain" }]) {
      await db.update(nativeRunFinalizations).set(patch).where(eq(nativeRunFinalizations.runId, runId));
      expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
      await db.update(nativeRunFinalizations).set({ ...lease, failureCode: null }).where(eq(nativeRunFinalizations.runId, runId));
    }
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false);
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    expect((await readUpgradeReadiness(db, input)).ready).toBe(false); // the in-flight local tail is still unknown
    expect(await readUpgradeReadiness(db, { activeRunIds: new Set(), counters: () => idle })).toMatchObject({ ready: true, activeRuns: 0 });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { confirmNativeControllerStopped, NATIVE_CONTROLLER_HOST_UNVERIFIED, requestNativeControllerStopConfirmation }
  from "./native-controller-host-recovery.js";
import { evaluateNativeControllerTakeover, LEGACY_HOST_FALLBACK_EVENT, recordLegacyHostFallbackProof }
  from "./native-restart-recovery.js";

describe("native controller rows saved before their host was recorded", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-controller-host-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => temporary?.cleanup());
  afterEach(() => vi.unstubAllEnvs());

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Host", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "codex_local", status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running",
      runtimeMode: "native", contextSnapshot: { issueId } });
    // The shape the previous release saved: a local controller and no host.
    const [coordinator] = await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
      attempt: 1, leaseOwner: "old-controller", leaseExpiresAt: new Date(0), controllerBootId: randomUUID(),
      controllerPid: 2_000_000_000, controllerProcessStartedAt: new Date() }).returning();
    return { companyId, agentId, issueId, runId, coordinator: coordinator! };
  }

  it("records each use of the single-host fallback in the run log", async () => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "");
    const { companyId, agentId, runId, coordinator } = await seed();
    const decision = await evaluateNativeControllerTakeover({ owner: coordinator, now: new Date() });
    expect(decision).toMatchObject({ allowed: true, legacyHostFallback: true });
    await recordLegacyHostFallbackProof(db, { companyId, id: runId, agentId }, decision, "test");
    const events = await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
      eq(activityLog.action, LEGACY_HOST_FALLBACK_EVENT)));
    expect(events).toEqual([expect.objectContaining({ details: expect.objectContaining({ reason: decision.reason, source: "test" }) })]);
    // It is not run-log evidence, which restart recovery reads as progress.
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toEqual([]);
  });

  it("asks the board on an ephemeral server and resumes only after it confirms the exact controller stopped", async () => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    const { companyId, issueId, runId, coordinator } = await seed();
    expect(await evaluateNativeControllerTakeover({ owner: coordinator, now: new Date() }))
      .toEqual({ allowed: false, reason: "controller_host_unrecorded" });
    await requestNativeControllerStopConfirmation(db, coordinator);
    await requestNativeControllerStopConfirmation(db, coordinator);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toEqual([expect.objectContaining({ cause: NATIVE_CONTROLLER_HOST_UNVERIFIED, ownerType: "board",
      status: "active", evidence: expect.objectContaining({ runId }) })]);

    const stopEvidence = "The old server container was replaced and is not running.";
    await expect(confirmNativeControllerStopped({ db, companyId, issueId, actionId: actions[0]!.id, runId: randomUUID(),
      stopEvidence, actorId: "board-user" })).rejects.toMatchObject({ status: 409 });
    await expect(confirmNativeControllerStopped({ db, companyId, issueId, actionId: actions[0]!.id, runId,
      stopEvidence, actorId: "board-user" })).resolves.toEqual({ runId, status: "queued" });

    const [attested] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(await evaluateNativeControllerTakeover({ owner: attested!, now: new Date() }))
      .toEqual({ allowed: true, reason: "operator_attested_controller_stopped" });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actions[0]!.id)))[0])
      .toMatchObject({ status: "resolved", evidence: expect.objectContaining({ controllerStop: expect.objectContaining({ stopEvidence }) }) });
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.native_controller_stop_confirmed")))).toHaveLength(1);
    // The confirmation is single-use for that exact controller.
    await expect(confirmNativeControllerStopped({ db, companyId, issueId, actionId: actions[0]!.id, runId,
      stopEvidence, actorId: "board-user" })).rejects.toMatchObject({ status: 409 });
  });
});

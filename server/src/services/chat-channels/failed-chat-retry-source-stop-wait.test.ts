import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { conflict } from "../../errors.js";
import { FailedChatRunRetryAuthorizationError } from "../durable-chat-wakeup.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { prepareStoppedSandboxForRecovery, restoreSandboxStopAfterFailedRestart } from "../sandbox-stop-and-retain.js";
import { taskChatRetryExecutionStopped } from "./task-retry-authority.js";
import { awaitFailedChatRetrySourceStop, failedChatRetrySourceStopPending } from "./failed-chat-retry-source-stop-wait.js";

describe("exact chat replay while workspace recovery restarts the failed run's sandbox", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("chat-retry-source-stop-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  /** A failed native run whose remote sandbox was stopped with a bound receipt. */
  async function stoppedSource() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chat retry", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review", status: "blocked", assigneeAgentId: agentId });
    const [source] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed",
      runtimeMode: "native", nativeIssueId: issueId, nativePhase: "terminal_failure",
      errorCode: "native_continuation_requires_reconciliation", contextSnapshot: { issueId }, finishedAt: new Date() }).returning();
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId, heartbeatRunId: runId, provider: "fake-sandbox", providerLeaseId: randomUUID() };
    const [lease] = await db.insert(environmentLeases).values({ ...identity, issueId, environmentId: environment.id,
      status: "released", cleanupStatus: "success", releasedAt: new Date(), leasePolicy: "retain_on_failure",
      metadata: { pluginId: "fake-plugin", remoteCwd: "/work", remoteExecutionTermination:
        remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }) },
    }).returning();
    return { source: source!, lease: lease!, companyId };
  }

  /** Workspace recovery suspends the stop receipt and restarts the sandbox to save its files. */
  async function recoveryRestart(lease: typeof environmentLeases.$inferSelect) {
    const pending = await prepareStoppedSandboxForRecovery(db, lease);
    expect(pending).not.toBeNull();
    return pending!;
  }

  async function restop(pending: typeof environmentLeases.$inferSelect) {
    const attemptId = String(pending.metadata?.pendingCleanupAttemptId);
    expect(await restoreSandboxStopAfterFailedRestart(db, pending, { attemptId })).not.toBeNull();
  }

  /** The containment part of the retry authority, as assertFailedNativeRetryState applies it. */
  const authorize = (sourceRunId: string) => async () => {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    if (!await taskChatRetryExecutionStopped(db, run!))
      throw conflict("This chat request can't be repeated exactly as it was sent.", { code: "chat_failed_run_retry_not_authorized" });
    return true;
  };

  it("loses the source's containment proof while recovery holds the sandbox, then regains it", async () => {
    const { source, lease, companyId } = await stoppedSource();
    expect(await taskChatRetryExecutionStopped(db, source)).toBe(true);
    expect(await failedChatRetrySourceStopPending(db, companyId, source.id)).toBe(false);

    const pending = await recoveryRestart(lease);
    // This is the state the replay's dispatch recheck saw in the incident.
    expect(await taskChatRetryExecutionStopped(db, source)).toBe(false);
    expect(await failedChatRetrySourceStopPending(db, companyId, source.id)).toBe(true);

    await restop(pending);
    expect(await taskChatRetryExecutionStopped(db, source)).toBe(true);
    expect(await failedChatRetrySourceStopPending(db, companyId, source.id)).toBe(false);
  });

  it("waits for the sandbox to stop again instead of failing the replay", async () => {
    const { source, lease, companyId } = await stoppedSource();
    const pending = await recoveryRestart(lease);
    await expect(authorize(source.id)()).rejects.toMatchObject({ details: { code: "chat_failed_run_retry_not_authorized" } });

    const onWait = vi.fn();
    const attempt = vi.fn(authorize(source.id));
    const restopped = new Promise<void>(resolve => setTimeout(() => void restop(pending).then(resolve), 150));
    await expect(awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: source.id,
      signal: new AbortController().signal, onWait, pollMs: 25 }, attempt)).resolves.toBe(true);
    await restopped;
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls.length).toBeGreaterThan(1);
  });

  it("checks once more when the stop settles between the refusal and the pending-stop read", async () => {
    const { source, lease, companyId } = await stoppedSource();
    const pending = await recoveryRestart(lease);
    const check = authorize(source.id);
    let first = true;
    // The refused transaction has released its locks; recovery then commits the stop receipt.
    const attempt = vi.fn(async () => {
      if (!first) return check();
      first = false;
      await check().catch(async error => { await restop(pending); throw error; });
      throw new Error("expected the first attempt to be refused");
    });
    const onWait = vi.fn();
    await expect(awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: source.id,
      signal: new AbortController().signal, onWait, pollMs: 25 }, attempt)).resolves.toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onWait).not.toHaveBeenCalled();
  });

  it("refuses at the deadline when the sandbox stays held", async () => {
    const { source, lease, companyId } = await stoppedSource();
    await recoveryRestart(lease);
    await expect(awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: source.id,
      signal: new AbortController().signal, timeoutMs: 100, pollMs: 25 }, authorize(source.id)))
      .rejects.toMatchObject({ details: { code: "chat_failed_run_retry_not_authorized" } });
  });

  it("refuses without waiting when no stop of the source sandbox is in progress", async () => {
    const { source, companyId } = await stoppedSource();
    // An unreleased lease without a stop intent: the old executor may still be running.
    await db.update(environmentLeases).set({ status: "active", cleanupStatus: null, releasedAt: null, metadata: { pluginId: "fake-plugin" } })
      .where(eq(environmentLeases.heartbeatRunId, source.id));
    const attempt = vi.fn(authorize(source.id));
    const onWait = vi.fn();
    await expect(awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: source.id,
      signal: new AbortController().signal, onWait, pollMs: 25 }, attempt)).rejects.toMatchObject({ status: 409 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onWait).not.toHaveBeenCalled();
  });

  it.each([
    ["a reasoned refusal", () => conflict("saved", { code: "chat_failed_run_retry_not_authorized", reason: "prior_result_publication" })],
    ["a mismatched retry selector", () => new FailedChatRunRetryAuthorizationError()],
    ["another error", () => new Error("database unavailable")],
  ])("does not wait on %s", async (_label, error) => {
    const { source, lease, companyId } = await stoppedSource();
    await recoveryRestart(lease);
    const attempt = vi.fn(async () => { throw error(); });
    await expect(awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: source.id,
      signal: new AbortController().signal, pollMs: 25 }, attempt)).rejects.toBeInstanceOf(Error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not wait when the run is not an exact replay of a failed run", async () => {
    const { source, lease, companyId } = await stoppedSource();
    await recoveryRestart(lease);
    const attempt = vi.fn(authorize(source.id));
    await expect(awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: null,
      signal: new AbortController().signal, pollMs: 25 }, attempt)).rejects.toMatchObject({ status: 409 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the run is stopped", async () => {
    const { source, lease, companyId } = await stoppedSource();
    await recoveryRestart(lease);
    const control = new AbortController();
    const waiting = awaitFailedChatRetrySourceStop(db, { companyId, sourceRunId: source.id,
      signal: control.signal, pollMs: 10_000, onWait: () => control.abort(new Error("stopped")) }, authorize(source.id));
    await expect(waiting).rejects.toThrow("stopped");
  });
});

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  chatConversations,
  chatEndpoints,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type {
  ControlPlanePort,
  NativeExecutionInputV1,
  PrpEvent,
} from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../vendor/paperclip-runner/index.js")
  >()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { PROVIDER_LIMIT_RESUME_KEY_PREFIX, registerProviderLimitResumeWork, requestProviderLimitResumeRetry } from "./provider-limit-resume.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";

describe("native provider capacity failure persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "native-provider-capacity-",
    );
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Native capacity regression",
      issuePrefix: "NPC",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native capacity agent",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
    });
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  /** Runs one native session whose provider ends its turn with `payload`. */
  async function failTurn(options: {
    payload: Record<string, unknown>;
    replayed?: boolean;
    responsibleUserId?: string | null;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const [issue] = await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Reply after a capacity failure",
        status: "in_progress",
        workMode: "standard",
        assigneeAgentId: agentId,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        invocationSource: "assignment",
        triggerDetail: "system",
        contextSnapshot: { issueId },
        responsibleUserId: options.responsibleUserId ?? null,
      })
      .returning();
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({
      db,
      run,
      issue,
      environmentLeaseId: randomUUID(),
    });
    const [contract] = await db
      .select()
      .from(completionContracts)
      .where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, {
      revision: contract.revision,
    });
    expect(completionInput).toEqual(contract.contractJson);
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "observed",
    });
    // A real terminal follows provider session establishment. Keep the
    // recovery evidence explicit; this must not be a bootstrap retry.
    await db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: {
          sessionCheckpoint: {
            providerSessionId: "capacity-test-provider-session",
            providerIdentity: { threadId: "capacity-test-thread" },
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: {
        companyId,
        runId,
        issueId,
        agentId,
        executionWorkspaceId: runId,
      },
      provider: { kind: "codex", model: "gpt-5.6-luna" },
      task: {
        identifier: issueId,
        title: issue.title,
        description: null,
        prompt: "Reply to the current message.",
        workMode: "standard",
      },
      workspace: {
        cwd: "/tmp",
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: native.normalizedSessionId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      completionContract: {
        id: contract.id,
        sha256: contract.canonicalSha256,
        schemaVersion: "paperclip.completion-contract.v1",
        contract: completionInput,
      },
      interactionResponses: [],
      credentialBindings: [],
    };
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      runId,
      normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId,
      sourceEventId: "capacity-terminal",
      sourceSeq: 1,
      sourceKind: "runner",
      eventType: "turn.failed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload: options.payload,
    };
    const openInput = {
      identity: {
        companyId,
        issueId,
        runId,
        agentId,
        sessionId: native.normalizedSessionId,
      },
      backendKind: "mock" as const,
      sourceInstanceId: native.runnerInstanceId,
    };
    if (options.replayed) {
      // Model a controller crash after the event commit but before its
      // observational callback or failure coordinator could run.
      const priorPort = new PaperclipControlPlanePort(db, {
        companyId,
        issueId,
        runId,
        agentId,
        sessionId: native.normalizedSessionId,
        sourceInstanceId: native.runnerInstanceId,
        controlPlaneSourceInstanceId: "prior-controller",
        completionContractId: contract.id,
        completionContractSha256: contract.canonicalSha256,
      });
      await priorPort.openRun(openInput);
      expect((await priorPort.appendEvent(event)).disposition).toBe(
        "committed",
      );
    }
    provider.execute
      .mockReset()
      .mockImplementation(
        async (executeOptions: { controlPlane: ControlPlanePort }) => {
          await executeOptions.controlPlane.openRun(openInput);
          const appended = await executeOptions.controlPlane.appendEvent(event);
          expect(appended.disposition).toBe(
            options.replayed ? "duplicate" : "committed",
          );
          // Production reports the provider terminal through the event, not by
          // pattern-matching this exception's arbitrary message.
          throw new Error("provider turn stopped");
        },
      );
    await expect(
      executePaperclipNativeSession({
        db,
        execution,
        runnerInstanceId: native.runnerInstanceId,
        backend: {
          descriptor: async () => {
            throw new Error(
              "Unexpected provider descriptor call in capacity test",
            );
          },
          openSession: async () => {
            throw new Error(
              "Unexpected provider session call in capacity test",
            );
          },
        },
      }),
    ).rejects.toThrow("provider turn stopped");
    expect(provider.execute).toHaveBeenCalledTimes(1);
    return { runId, issueId, sourceEventId: event.sourceEventId };
  }

  async function holdFor(issueId: string) {
    const [recovery] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return recovery;
  }

  it.each([false, true])(
    "stops automatic retries for a durable usage terminal (replayed=%s)",
    async (replayed) => {
      const { runId, issueId, sourceEventId } = await failTurn({
        replayed,
        payload: {
          status: "failed",
          error: {
            codexErrorInfo: "usageLimitExceeded",
            message: "Private account metadata",
          },
        },
      });
      const [coordinator] = await db
        .select()
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, runId));
      expect(coordinator).toMatchObject({
        phase: "terminal_failure",
        failureCode: "native_provider_usage_limit",
        recoveryState: "blocked",
        attempt: 1,
        nextAttemptAt: null,
        leaseOwner: null,
      });
      const [failedRun] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(failedRun.errorCode).toBe("native_provider_usage_limit");
      const recovery = await holdFor(issueId);
      expect(recovery).toMatchObject({
        ownerType: "board",
        cause: "native_provider_usage_limit",
        wakePolicy: null,
      });
      expect(recovery.nextAction).toContain(
        "Restore model provider usage capacity",
      );
      expect(recovery.nextAction).not.toContain("Private account metadata");
      const [waitingIssue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(waitingIssue.status).toBe("blocked");
      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      expect(
        events.filter((row) => row.sourceEventId === sourceEventId),
      ).toHaveLength(1);
      // No reset was reported, so nothing retries the task by itself.
      await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: recovery.id }))
        .resolves.toEqual({ requested: false, reason: "reset_unknown" });
    },
  );

  /** The ACP harness's weekly-limit terminal, as staging recorded it (PAP-1057). */
  function weeklyLimit(resetAt: Date) {
    const month = resetAt.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const hour = resetAt.getUTCHours();
    const clock = `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
    return {
      status: "failed",
      error: {
        code: "RUNTIME",
        message: "ACP agent reported a terminal limit failure.",
        providerFailure: {
          schema: "paperclip.provider-failure.v1",
          provider: "anthropic",
          phase: "turn",
          category: "quota_exhausted",
          retryability: "requires_action",
          message: `ACP agent reported a terminal limit failure.\nYou've hit your weekly limit · resets ${month} ${resetAt.getUTCDate()}, ${clock} (UTC)`,
        },
      },
    };
  }

  it("waits for a reported usage-limit reset and then requests the task's Retry once", async () => {
    const resetAt = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const userId = `user-${randomUUID()}`;
    const { runId, issueId } = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: userId });

    const hold = await holdFor(issueId);
    expect(hold).toMatchObject({ cause: "native_provider_usage_limit",
      evidence: expect.objectContaining({ providerLimitResetAt: resetAt.toISOString() }) });
    // The hold says when work resumes, not that its session state is ambiguous.
    expect(hold.nextAction).toBe(`The provider usage limit resets at ${resetAt.toISOString()}. `
      + "Paperclip will retry this task then; Retry starts it sooner if usage capacity is already restored.");

    // A hold saved by the previous release names no reset and calls the state ambiguous.
    const { providerLimitResetAt: _reset, ...oldEvidence } = hold.evidence;
    await db.update(issueRecoveryActions).set({ evidence: oldEvidence, nextAction: "Inspect the original provider failure "
      + "and explicitly resolve the ambiguous session state; do not open a replacement provider session." })
      .where(eq(issueRecoveryActions.id, hold.id));

    // Before the reset nothing starts; the owner keeps the reset as its deadline
    // and tells the reader when work resumes.
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id }))
      .resolves.toEqual({ requested: false, waitUntil: resetAt });
    expect(await holdFor(issueId)).toMatchObject({ nextAction: hold.nextAction,
      evidence: expect.objectContaining({ providerLimitResetAt: resetAt.toISOString() }) });

    // At the reset Paperclip asks for the same Retry the accountable user would.
    const afterReset = new Date(resetAt.getTime() + 1000);
    const outcome = await requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id }, afterReset);
    expect(outcome).toMatchObject({ requested: true });
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `task-retry:provider-limit-reset:${runId}`)));
    expect(receipt).toMatchObject({ reason: "task_retry", requestedByActorType: "user", requestedByActorId: userId,
      status: "deferred_issue_execution", payload: expect.objectContaining({ issueId,
        taskRetry: expect.objectContaining({ sourceRunId: runId, actorId: userId }) }) });
    expect((await holdFor(issueId)).evidence.providerLimitResume).toMatchObject({ state: "requested",
      requestId: receipt.id, resetAt: resetAt.toISOString() });

    // A second pass never requests another Retry for the same hold.
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id }, afterReset))
      .resolves.toEqual({ requested: false, reason: "not_waiting" });
    const receipts = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "task_retry"),
      eq(agentWakeupRequests.agentId, agentId)));
    expect(receipts.filter(row => (row.payload as Record<string, unknown>).issueId === issueId)).toHaveLength(1);
  });

  it("starts the Retry from the hold's own deadline after a restart rebuilds it", async () => {
    // A typed reset a few seconds out; the owner learns it only from durable rows.
    const resetAt = new Date(Date.now() + 3000);
    const payload = weeklyLimit(resetAt);
    (payload.error.providerFailure as Record<string, unknown>).retryAt = resetAt.toISOString();
    const userId = `user-${randomUUID()}`;
    const { issueId } = await failTurn({ payload, responsibleUserId: userId });
    const hold = await holdFor(issueId);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: error => { errors.push(error); } });
    const resume = vi.fn(async () => undefined);
    try {
      const worker = registerProviderLimitResumeWork(db, coordinator,
        { resume, schedulingSuppressed: async () => false }, () => true);
      await worker.ready;
      // Nothing starts before the reset.
      expect(resume).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1), { timeout: 20_000, interval: 200 });
      const [receipt] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "task_retry"),
        eq(agentWakeupRequests.requestedByActorId, userId)));
      expect(resume).toHaveBeenCalledWith(companyId, receipt.id);
      expect(Date.now()).toBeGreaterThanOrEqual(resetAt.getTime());
      expect((await holdFor(issueId)).evidence.providerLimitResume).toMatchObject({ state: "requested", requestId: receipt.id });
      expect(hold.id).toBe((await holdFor(issueId)).id);
    } finally {
      await coordinator.stop();
    }
    expect(errors).toEqual([]);
  }, 30_000);

  it("leaves a visible Retry when no user is accountable for the run", async () => {
    const resetAt = new Date(Date.now() + 3 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const { issueId } = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: null });
    const hold = await holdFor(issueId);
    expect(hold.nextAction).toBe(`The provider usage limit resets at ${resetAt.toISOString()}. `
      + "Retry the task after that time, or sooner if usage capacity is restored.");
    const outcome = await requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id },
      new Date(resetAt.getTime() + 1000));
    expect(outcome).toEqual({ requested: false, reason: "no_accountable_user" });
    expect((await holdFor(issueId)).nextAction).toBe("Paperclip did not retry this task after the provider usage limit "
      + "reset because no user is accountable for the run. Retry the task when usage capacity is available.");
  });

  it("prepares a connected chat conversation's Retry through the chat service", async () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const userId = `user-${randomUUID()}`;
    const { runId, issueId } = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: userId });
    // The task belongs to a restricted external chat conversation.
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Slack", type: "chat" }).returning();
    const connectionId = randomUUID();
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId: application!.id, uid: connectionId,
      name: "Slack", transport: "chat_sdk", connectionPurpose: "channel" });
    const endpointId = randomUUID();
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId,
      assignedAgentId: agentId, status: "active", externalExecutionPolicy: "restricted" });
    await db.insert(chatConversations).values({ companyId, endpointId, issueId, externalConversationId: "channel",
      externalThreadId: issueId, externalLabel: "#limits", state: "waiting" });
    const hold = await holdFor(issueId);
    const chatActionId = randomUUID();
    const prepareChatRetry = vi.fn(async () => ({ actionId: chatActionId }));
    const outcome = await requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id, prepareChatRetry },
      new Date(resetAt.getTime() + 1000));
    expect(outcome).toMatchObject({ requested: true });
    expect(prepareChatRetry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId, issueId, agentId, failedRunId: runId, initiatedByUserId: userId }));
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `task-retry:${PROVIDER_LIMIT_RESUME_KEY_PREFIX}${runId}`)));
    expect(receipt.payload).toMatchObject({ taskRetry: expect.objectContaining({ chatActionId }) });
  });

  it("replaces the retry promise on every give-up path", async () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const afterReset = new Date(resetAt.getTime() + 1000);
    // The failed run's terminal can no longer be read as a provider-observed reset.
    const unreadable = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: `user-${randomUUID()}` });
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, unreadable.runId));
    const unreadableHold = await holdFor(unreadable.issueId);
    expect(unreadableHold.nextAction).toContain("Paperclip will retry this task then");
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: unreadableHold.id }, afterReset))
      .resolves.toEqual({ requested: false, reason: "reset_unknown" });
    expect((await holdFor(unreadable.issueId)).nextAction).toBe("Paperclip did not retry this task after the provider "
      + "usage limit reset because the provider's reset could no longer be read. Retry the task when usage capacity is available.");
    // The hold's run no longer failed for the usage limit.
    const changed = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: `user-${randomUUID()}` });
    await db.update(heartbeatRuns).set({ errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, changed.runId));
    const changedHold = await holdFor(changed.issueId);
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: changedHold.id }, afterReset))
      .resolves.toEqual({ requested: false, reason: "source_run_mismatch" });
    expect((await holdFor(changed.issueId)).nextAction).toBe("Paperclip did not retry this task after the provider "
      + "usage limit reset because the failed run no longer matches this hold. Retry the task when usage capacity is available.");
  });

  it("stops after three automatic Retries in a row and counts again after a successful run", async () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const afterReset = new Date(resetAt.getTime() + 1000);
    const userId = `user-${randomUUID()}`;
    const { issueId } = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: userId });
    const hold = await holdFor(issueId);
    // Earlier usage-limit Retries on this task, none followed by a success.
    const earlierRetry = (task: string) => ({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "completed", idempotencyKey: `task-retry:${PROVIDER_LIMIT_RESUME_KEY_PREFIX}${randomUUID()}`,
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: task },
      requestedAt: new Date(Date.now() - 60_000) });
    // Two in a row still leave this one.
    await db.insert(agentWakeupRequests).values([earlierRetry(issueId), earlierRetry(issueId)]);
    const [third] = await db.insert(agentWakeupRequests).values(earlierRetry(issueId)).returning();
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id }, afterReset))
      .resolves.toEqual({ requested: false, reason: "automatic_retry_budget_used" });
    expect((await holdFor(issueId)).nextAction).toBe("Paperclip did not retry this task after the provider usage limit "
      + "reset because three automatic Retries in a row did not restore usage. Retry the task when usage capacity is available.");
    expect(third.id).toBeTruthy();

    // A successful run on the task after earlier Retries restores the budget.
    const second = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: userId });
    await db.insert(agentWakeupRequests).values([earlierRetry(second.issueId), earlierRetry(second.issueId),
      earlierRetry(second.issueId)]);
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: second.issueId, invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: second.issueId }, finishedAt: new Date(Date.now() - 1000),
      createdAt: new Date(Date.now() - 10 * 60_000) });
    const secondHold = await holdFor(second.issueId);
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: secondHold.id }, afterReset))
      .resolves.toMatchObject({ requested: true });
  });

  it("rebuilds every waiting hold after a restart, past one page", async () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const { issueId } = await failTurn({ payload: weeklyLimit(resetAt), responsibleUserId: `user-${randomUUID()}` });
    const hold = await holdFor(issueId);
    // A hold saved before holds named their reset; it sorts after 600 others.
    const { providerLimitResetAt: _reset, ...oldEvidence } = hold.evidence;
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other holds", issuePrefix: "OTH" });
    const otherIssues = Array.from({ length: 600 }, () => randomUUID());
    await db.insert(issues).values(otherIssues.map(id => ({ id, companyId: otherCompanyId, title: "Other", status: "in_progress" })));
    const { id: _id, companyId: _company, sourceIssueId: _issue, createdAt: _c, updatedAt: _u, ...template } = hold;
    for (let page = 0; page < 6; page++) {
      await db.insert(issueRecoveryActions).values(Array.from({ length: 100 }, (_, index) => ({ ...template,
        companyId: otherCompanyId, sourceIssueId: otherIssues[page * 100 + index]!,
        id: `00000000-0000-4000-8000-${String(page * 100 + index).padStart(12, "0")}`,
        evidence: { ...oldEvidence, runId: randomUUID() } })));
    }
    await db.insert(issueRecoveryActions).values({ ...hold, id: `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`,
      evidence: oldEvidence });
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: error => { errors.push(error); } });
    try {
      const worker = registerProviderLimitResumeWork(db, coordinator,
        { resume: vi.fn(async () => undefined), schedulingSuppressed: async () => false }, () => true);
      await worker.ready;
      // The hold past the first page reads its reset and records it.
      await vi.waitFor(async () => expect((await holdFor(issueId)).evidence.providerLimitResetAt).toBe(resetAt.toISOString()),
        { timeout: 25_000, interval: 250 });
    } finally {
      await coordinator.stop();
    }
    expect(errors).toEqual([]);
  }, 40_000);

  it("reports a reset beyond the automatic wait without retrying by itself", async () => {
    // A monthly limit, typed by the provider, three weeks out.
    const resetAt = new Date(Date.now() + 21 * 24 * 60 * 60_000);
    resetAt.setUTCMinutes(0, 0, 0);
    const payload = weeklyLimit(resetAt);
    (payload.error.providerFailure as Record<string, unknown>).retryAt = resetAt.toISOString();
    const userId = `user-${randomUUID()}`;
    const { issueId } = await failTurn({ payload, responsibleUserId: userId });
    const hold = await holdFor(issueId);
    expect(hold.nextAction).toBe(`The provider usage limit resets at ${resetAt.toISOString()}. `
      + "Retry the task after that time, or sooner if usage capacity is restored.");
    expect(hold.evidence).toMatchObject({ providerLimitResetAt: resetAt.toISOString() });
    await expect(requestProviderLimitResumeRetry(db, { companyId, actionId: hold.id },
      new Date(resetAt.getTime() + 1000))).resolves.toEqual({ requested: false, reason: "reset_beyond_wait" });
    expect((await holdFor(issueId)).nextAction).toBe(hold.nextAction);
    const receipts = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.requestedByActorId, userId)));
    expect(receipts).toEqual([]);
  });
});

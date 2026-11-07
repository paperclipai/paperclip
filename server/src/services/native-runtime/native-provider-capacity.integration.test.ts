import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companyMemberships,
  connectionGrants,
  companySecrets,
  aiConnectionTaskPins,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type {
  ControlPlanePort,
  NativeExecutionInputV10,
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

import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aiConnectionService } from "../ai-connections.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, type AiConnectionPoolMember } from "@paperclipai/shared";
import { recordVerifiedRouterQuotaCooldown } from "../heartbeat/run-completion.js";
import { fenceQuotaReplacementStop } from "./native-cancellation-request.js";
import { reconcileSafeNativeReplacements } from "./native-safe-replacement.js";

describe("native provider capacity failure persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const workspaces: string[] = [];
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
    await Promise.all(workspaces.map(path => rm(path, { recursive: true, force: true })));
  });

  it.each([
    ...[false, true].flatMap(replayed => [false, true].map(structured => ({ replayed, structured, kind: "quota", hold: "" }))),
    { replayed: false, structured: false, kind: "auth", hold: "" },
    { replayed: true, structured: true, kind: "auth", hold: "" },
    { replayed: false, structured: false, kind: "runner", hold: "" },
    { replayed: false, structured: false, kind: "runner_definitive", hold: "" },
    { replayed: false, structured: false, kind: "auth", hold: "stop" },
    { replayed: false, structured: false, kind: "runner", hold: "unknown_action" },
    { replayed: false, structured: false, kind: "runner_definitive", hold: "unknown_action" },
    ...["quota", "auth", "runner_definitive"].map(kind => ({ replayed: false, structured: false, kind, hold: "", poolHarness: true })),
    { replayed: false, structured: false, kind: "quota", hold: "", poolHarness: true, ordinaryRetry: true },
  ])(
    "persists $kind failure and continues receipted work (replayed=$replayed, structured=$structured, hold=$hold)",
    async scenario => {
      const { replayed, structured, kind: scenarioKind, hold } = scenario;
      const poolHarness = "poolHarness" in scenario && scenario.poolHarness === true;
      const ordinaryRetry = "ordinaryRetry" in scenario && scenario.ordinaryRetry === true;
      const immediate = scenarioKind === "runner_definitive";
      const kind = immediate ? "runner" : scenarioKind;
      const code = kind === "auth" ? "native_provider_auth_failed" : kind === "runner" ? "native_provider_runner_failed" : "native_provider_usage_limit";
      const failureMessage = kind === "runner" ? "native_runner_process_exited" : "provider turn stopped";
      const workspaceCwd = await mkdtemp(join(tmpdir(), "native-quota-workspace-"));
      workspaces.push(workspaceCwd);
      const savedFile = join(workspaceCwd, "saved-work.txt");
      const savedWork = "Completed work before the usage limit.\n";
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
        attempt: kind === "runner" && !immediate ? 2 : 0,
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

      const execution: NativeExecutionInputV10 = {
        schema: "paperclip.native-execution-input.v10",
        homeMode: "isolated", executionMode: "default", planningContext: null, runtimeContext: nativeRuntimeContextFixture(),
        binding: {
          companyId,
          runId,
          issueId,
          agentId,
          executionWorkspaceId: runId,
        },
        provider: { kind: "codex", model: "gpt-5.6-luna", approvalPolicy: "never" },
        task: {
          identifier: issueId,
          title: issue.title,
          description: null,
          prompt: "Reply to the current message.",
          workMode: "standard",
        },
        workspace: {
          cwd: workspaceCwd,
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
      const userId = `capacity-${randomUUID()}`;
      await db.insert(authUsers).values({ id: userId, name: "Capacity", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      const accounts = aiConnectionService(db);
      const saved = await Promise.all(["First", "Backup"].map(name => accounts.save(companyId, userId, {
        provider: poolHarness && name === "Backup" ? "anthropic" : "openai", method: "api_key", ownership: "personal", name, apiKey: `fixture-${name}`, agentIds: [], allAgents: true,
      }, randomUUID())));
      const members: AiConnectionPoolMember[] = saved.map((account, index) => ({ id: randomUUID(), binding: {
        mode: "delegated" as const, provider: poolHarness && index === 1 ? "anthropic" as const : "openai" as const, method: "api_key" as const, ...account,
      }, profile: poolHarness && index === 1 ? { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } : { provider: "codex", model: "gpt-5" } }));
      const router = aiConnectionRouterService(db);
      const pool = await router.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId,
        config: { ...(poolHarness ? { schemaVersion: 2 as const, kind: "harness_pool" as const } : {}), name: "Capacity pool", enabled: true, mode: "failover", thresholdPercent: 90, members } }, userId);
      await db.update(agents).set({ runtimeConfig: poolHarness ? { harnessPool: { poolId: pool.id } } : { aiConnection: { mode: "router", connectionId: pool.id } } }).where(eq(agents.id, agentId));
      const selection = await router.resolve({ companyId, poolId: pool.id, agentId, userId, adapterType: "paperclip_runner", taskKey: issueId, ...(poolHarness ? { environmentId: null } : {}) });
      if (selection.binding.mode === "responsible_user") throw new Error("Expected delegated fixture");
      await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId, responsibleUserId: userId,
        contextSnapshot: { issueId, aiRouterTaskKey: issueId, aiRouterSelection: selection },
        runnerProfileJson: { recoveryEventInventoryVersion: 1, nativeExecutionInput: { ...execution, workspace: { ...execution.workspace, cwd: workspaceCwd } },
          sessionCheckpoint: { providerSessionId: "capacity-test-provider-session", providerIdentity: { threadId: "capacity-test-thread" }, ...(immediate ? { terminal: { runTerminalState: "failed" } } : {}) } },
      }).where(eq(heartbeatRuns.id, runId));
      if (ordinaryRetry) {
        const [previous] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, scopeKind: "issue", status: "failed", errorCode: "workspace_git_scan_timeout", contextSnapshot: { issueId, aiRouterTaskKey: issueId, aiRouterSelection: selection }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
        await db.update(heartbeatRuns).set({ retryOfRunId: previous!.id }).where(eq(heartbeatRuns.id, runId));
      }
      const event: PrpEvent = {
        schema: "paperclip.prp.event.v1",
        runId,
        normalizedSessionId: native.normalizedSessionId,
        turnId: native.turnId,
        sourceInstanceId: native.runnerInstanceId,
        sourceEventId: "capacity-terminal",
        sourceSeq: 3,
        sourceKind: "runner",
        eventType: "turn.failed",
        schemaVersion: 1,
        priority: 0,
        emittedAt: new Date().toISOString(),
        payload: {
          status: "failed",
          error: {
            codexErrorInfo: kind === "auth" ? "unauthorized" : "usageLimitExceeded",
            message: "Private account metadata",
          },
        },
      };
      const toolStarted: PrpEvent = { ...event, sourceSeq: 1, sourceEventId: "capacity-tool-started", eventType: "tool.execution.started",
        payload: { schema: "paperclip.tool.execution.v1", executionId: "saved-work", name: "write_file", transport: "process", operation: "edit", status: "running", output: null, outputBytes: 0, outputTruncated: false, outputDigest: null } };
      const toolCompleted: PrpEvent = { ...toolStarted, sourceSeq: 2, sourceEventId: "capacity-tool-completed", eventType: "tool.execution.completed",
        payload: { ...toolStarted.payload, status: "completed", output: "Saved work before quota exhaustion" } };
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
      if (replayed) {
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
        await priorPort.appendEvent(toolStarted);
        await writeFile(savedFile, savedWork);
        await priorPort.appendEvent(toolCompleted);
        expect((await priorPort.appendEvent(event)).disposition).toBe(
          "committed",
        );
      }
      provider.execute
        .mockReset()
        .mockImplementation(
          async (options: { controlPlane: ControlPlanePort }) => {
            await options.controlPlane.openRun(openInput);
            await options.controlPlane.appendEvent(toolStarted);
            if (!replayed) await writeFile(savedFile, savedWork);
            if (hold !== "unknown_action") await options.controlPlane.appendEvent(toolCompleted);
            if (kind === "runner") throw new Error(failureMessage);
            const appended = await options.controlPlane.appendEvent(event);
            expect(appended.disposition).toBe(
              replayed ? "duplicate" : "committed",
            );
            // Production reports the provider terminal through the event, not by
            // pattern-matching this exception's arbitrary message.
            if (!structured) throw new Error(failureMessage);
            throw Object.assign(new Error("provider turn stopped"), { providerFailure: {
              schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn", category: kind === "auth" ? "authentication" : "quota_exhausted",
              message: "Provider rejected the account", retryability: "requires_action",
            } });
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
      ).rejects.toThrow(failureMessage);

      expect(provider.execute).toHaveBeenCalledTimes(1);
      const [coordinator] = await db
        .select()
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, runId));
      expect(coordinator).toMatchObject({
        phase: "terminal_failure",
        failureCode: code,
        recoveryState: "blocked",
        attempt: kind === "runner" && !immediate ? 3 : 1,
        nextAttemptAt: null,
        leaseOwner: null,
      });
      const [failedRun] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(failedRun.errorCode).toBe(kind === "runner" ? "native_runner_process_exited" : code);
      const [recovery] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(recovery).toMatchObject({
        ownerType: "board",
        cause: code,
        wakePolicy: null,
      });
      if (kind === "quota") expect(recovery.nextAction).toContain("Restore model provider usage capacity");
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
        events.filter((row) => row.sourceEventId === event.sourceEventId),
      ).toHaveLength(kind === "runner" ? 0 : 1);
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, selection.binding.grantId));
      const ref = grant.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
      if (poolHarness && kind === "quota") await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, agentId));
      const attributionStartedAt = Date.now();
      const attributed = await recordVerifiedRouterQuotaCooldown(db, { companyId, agentId, runId,
        credentialIdentity: `${grant.id}:${userId}:${secret.id}:${secret.aiSessionEpoch}`,
        retryNotBefore: null, failureKind: kind as "quota" | "auth" | "runner",
      });
      expect(attributed).toBe(true);
      if (poolHarness && kind === "quota") await db.update(agents).set({ runtimeConfig: { harnessPool: { poolId: pool.id } } }).where(eq(agents.id, agentId));
      const cooldown = await router.accountCooldown(companyId, selection.binding.connectionId, `secret:${secret.id}:${secret.aiSessionEpoch}`, poolHarness ? { config: selection.runtimeConfig, scope: { environmentId: null } } : undefined);
      const expectedDelay = kind === "runner" ? 5 * 60_000 : 2 * 60 * 60_000;
      expect(cooldown!.getTime()).toBeGreaterThanOrEqual(attributionStartedAt + expectedDelay);
      expect(cooldown!.getTime()).toBeLessThanOrEqual(Date.now() + expectedDelay);
      if (hold === "stop") expect(await fenceQuotaReplacementStop(db, failedRun)).toMatchObject({ kind: "fenced" });
      // This DB lifecycle test injects containment; the real local owner verifier
      // has separate Codex/ACPX stop-receipt and changed-process coverage.
      expect((await reconcileSafeNativeReplacements(db, new Date(), {
        verifyStoppedSession: async candidate => candidate.id === runId ? { evidence: {}, retire: () => true } : null,
      })).scheduled).toBe(hold ? 0 : 1);
      if (hold) {
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
        const [heldPin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, companyId), eq(aiConnectionTaskPins.taskKey, issueId)));
        expect(heldPin.selection.memberId).toBe(members[0].id);
        expect(provider.execute).toHaveBeenCalledTimes(1);
        return;
      }
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(successor.contextSnapshot).toMatchObject({ forceFreshSession: true, issueId,
        aiRouterSelection: { memberId: members[1].id } });
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, companyId), eq(aiConnectionTaskPins.taskKey, issueId)));
      expect(pin.selection.memberId).toBe(members[1].id);
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(await readFile(savedFile, "utf8")).toBe(savedWork);
      if (kind !== "quota" || poolHarness) {
        const [currentIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
        const [runningSuccessor] = await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(),
          runtimeMode: "native", nativeIssueId: issueId }).where(eq(heartbeatRuns.id, successor.id)).returning();
        await db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, issueId));
        const prepared = await prepareNativeHeartbeatRun({ db, run: runningSuccessor, issue: currentIssue,
          environmentLeaseId: randomUUID() });
        await db.insert(nativeRunFinalizations).values({ runId: successor.id, companyId, issueId, phase: "observed" });
        const backupInput = poolHarness ? buildNativeExecutionInput({ companyId, runId: successor.id, agentId,
          issue: { id: issueId, title: issue.title, description: issue.description, identifier: issueId, workMode: "standard" },
          taskPrompt: "Continue remaining work; preserve the receipted output.", workspace: { id: runId, ...execution.workspace },
          normalizedSessionId: prepared.normalizedSessionId, provider: "acpx", acpxAgent: "claude", model: String(pin.selection.runtimeConfig.model),
          completionContract: execution.completionContract, runtimeContext: nativeRuntimeContextFixture(),
        }) : null;
        if (backupInput && backupInput.provider.kind !== "acpx") throw new Error("Expected the selected Claude driver");
        const nextExecution: NativeExecutionInputV10 = { ...execution,
          binding: { ...execution.binding, runId: successor.id },
          provider: backupInput?.provider.kind === "acpx" ? backupInput.provider : { kind: "codex", model: String(pin.selection.runtimeConfig.model), approvalPolicy: "never" },
          session: { ...execution.session, driverKind: poolHarness ? "acpx_runtime" : "codex_app_server", normalizedSessionId: prepared.normalizedSessionId } };
        provider.execute.mockImplementationOnce(async (options: { controlPlane: ControlPlanePort }) => {
          expect(await readFile(savedFile, "utf8")).toBe(savedWork);
          await options.controlPlane.openRun({ ...openInput,
            identity: { ...openInput.identity, runId: successor.id, sessionId: prepared.normalizedSessionId }, sourceInstanceId: prepared.runnerInstanceId });
          return { result: { summary: "Finished remaining work without replay" }, terminal: { runTerminalState: "succeeded" },
            turnId: prepared.turnId, normalizedSessionId: prepared.normalizedSessionId, providerSessionId: "backup-provider",
            driverKind: poolHarness ? "acpx_runtime" : "codex_app_server", driverVersion: "1", nativeEventCount: 0, highestContiguousSourceSeq: 0, usage: null };
        });
        const executeBackup = () => executePaperclipNativeSession({ db, execution: nextExecution, runnerInstanceId: prepared.runnerInstanceId,
          backend: { descriptor: async () => { throw new Error("unexpected descriptor"); }, openSession: async () => { throw new Error("unexpected session"); } } });
        if (kind === "runner" && !immediate) {
          await db.update(heartbeatRuns).set({ contextSnapshot: { ...successor.contextSnapshot,
            aiPoolFailover: { sourceRunId: runId, reason: "auth" } } }).where(eq(heartbeatRuns.id, successor.id));
          await expect(executeBackup()).rejects.toThrow("native_session_retry_exhausted");
          expect(provider.execute).toHaveBeenCalledTimes(1);
          await db.update(heartbeatRuns).set({ contextSnapshot: successor.contextSnapshot }).where(eq(heartbeatRuns.id, successor.id));
        }
        const result = await executeBackup();
        expect(result.exitCode).toBe(0);
        const [backupOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, successor.id));
        expect(backupOwner.attempt).toBe(1);
        expect(provider.execute).toHaveBeenCalledTimes(2);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe("failed");
        const successorEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, successor.id));
        expect(successorEvents.filter(row => row.eventType === "tool.execution.started")).toHaveLength(0);
      }
    },
  );
});

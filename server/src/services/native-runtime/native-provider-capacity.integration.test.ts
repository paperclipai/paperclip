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
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aiConnectionService } from "../ai-connections.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY } from "@paperclipai/shared";
import { recordVerifiedRouterQuotaCooldown } from "../heartbeat/run-completion.js";
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

  it.each([false, true].flatMap(replayed => [false, true].map(structured => ({ replayed, structured }))))(
    "persists quota failure and continues receipted work (replayed=$replayed, structured=$structured)",
    async ({ replayed, structured }) => {
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
        provider: "openai", method: "api_key", ownership: "personal", name, apiKey: `fixture-${name}`, agentIds: [], allAgents: true,
      }, randomUUID())));
      const members = saved.map(account => ({ id: randomUUID(), binding: {
        mode: "delegated" as const, provider: "openai" as const, method: "api_key" as const, ...account,
      }, profile: { provider: "codex" as const, model: "gpt-5" } }));
      const router = aiConnectionRouterService(db);
      const pool = await router.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId,
        config: { name: "Capacity pool", enabled: true, mode: "failover", thresholdPercent: 90, members } }, userId);
      await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).where(eq(agents.id, agentId));
      const selection = await router.resolve({ companyId, poolId: pool.id, agentId, userId, adapterType: "paperclip_runner", taskKey: issueId });
      if (selection.binding.mode === "responsible_user") throw new Error("Expected delegated fixture");
      await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId, responsibleUserId: userId,
        contextSnapshot: { issueId, aiRouterTaskKey: issueId, aiRouterSelection: selection },
        runnerProfileJson: { recoveryEventInventoryVersion: 1, nativeExecutionInput: { ...execution, workspace: { ...execution.workspace, cwd: workspaceCwd } },
          sessionCheckpoint: { providerSessionId: "capacity-test-provider-session", providerIdentity: { threadId: "capacity-test-thread" } } },
      }).where(eq(heartbeatRuns.id, runId));
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
            codexErrorInfo: "usageLimitExceeded",
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
            await options.controlPlane.appendEvent(toolCompleted);
            const appended = await options.controlPlane.appendEvent(event);
            expect(appended.disposition).toBe(
              replayed ? "duplicate" : "committed",
            );
            // Production reports the provider terminal through the event, not by
            // pattern-matching this exception's arbitrary message.
            if (!structured) throw new Error("provider turn stopped");
            throw Object.assign(new Error("provider turn stopped"), { providerFailure: {
              schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn", category: "quota_exhausted",
              message: "Provider quota exhausted", retryability: "requires_action",
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
      ).rejects.toThrow("provider turn stopped");

      expect(provider.execute).toHaveBeenCalledTimes(1);
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
      const [recovery] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
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
        events.filter((row) => row.sourceEventId === event.sourceEventId),
      ).toHaveLength(1);
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, selection.binding.grantId));
      const ref = grant.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
      const attributed = await recordVerifiedRouterQuotaCooldown(db, { companyId, agentId, runId,
        credentialIdentity: `${grant.id}:${userId}:${secret.id}:${secret.aiSessionEpoch}`,
        retryNotBefore: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(attributed).toBe(true);
      // This DB lifecycle test injects containment; the real local owner verifier
      // has separate Codex/ACPX stop-receipt and changed-process coverage.
      expect((await reconcileSafeNativeReplacements(db, new Date(), {
        verifyStoppedSession: async candidate => candidate.id === runId ? { evidence: {}, retire: () => true } : null,
      })).scheduled).toBe(1);
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(successor.contextSnapshot).toMatchObject({ forceFreshSession: true, issueId,
        aiRouterSelection: { memberId: members[1].id } });
      const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, companyId), eq(aiConnectionTaskPins.taskKey, issueId)));
      expect(pin.selection.memberId).toBe(members[1].id);
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(await readFile(savedFile, "utf8")).toBe(savedWork);
    },
  );
});

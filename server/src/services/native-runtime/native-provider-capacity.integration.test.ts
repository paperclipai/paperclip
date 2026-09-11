import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
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

  it.each([false, true])(
    "stops automatic retries for a durable usage terminal (replayed=%s)",
    async (replayed) => {
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
        payload: {
          status: "failed",
          error: {
            codexErrorInfo: "usageLimitExceeded",
            message: "Private account metadata",
          },
        },
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
        expect((await priorPort.appendEvent(event)).disposition).toBe(
          "committed",
        );
      }
      provider.execute
        .mockReset()
        .mockImplementation(
          async (options: { controlPlane: ControlPlanePort }) => {
            await options.controlPlane.openRun(openInput);
            const appended = await options.controlPlane.appendEvent(event);
            expect(appended.disposition).toBe(
              replayed ? "duplicate" : "committed",
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
      expect(waitingIssue.status).toBe("in_review");
      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      expect(
        events.filter((row) => row.sourceEventId === event.sourceEventId),
      ).toHaveLength(1);
    },
  );
});

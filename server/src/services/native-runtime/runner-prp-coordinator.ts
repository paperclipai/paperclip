import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { agents, completionContracts, heartbeatRuns, issues } from "@paperclipai/db";
import {
  DurablePrpControlPlane,
  type PaperclipSemanticToolDefinition,
  type PrpStructuredRunResult,
  type PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";

import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { PaperclipRunnerSemanticAuthority } from "./runner-semantic-authority.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const RUNNER_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface PrepareRunnerPrpSessionInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly runnerInstanceId: string;
  readonly environmentLeaseId: string;
  readonly normalizedSessionId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly runnerVersion: string;
  readonly runnerDigest: string;
  readonly bootstrapTtlMs?: number;
  readonly connectionLeaseTtlMs?: number;
}

export interface PreparedRunnerPrpSession {
  readonly connectUrl: string;
  /** One-use secret. Pass it only through the runner's protected bootstrap channel. */
  readonly bootstrapTicket: string;
  issueBootstrapTicket(): string;
  readonly semanticTools: readonly PaperclipSemanticToolDefinition[];
  queueCommand(
    type: string,
    payload?: Record<string, unknown>,
    commandId?: string,
  ): { readonly commandId: string; readonly controllerSeq: number };
  completeRun(input: {
    readonly result: PrpStructuredRunResult;
    readonly terminal: PrpTerminalState;
    readonly turnId?: string;
    readonly callerResultId?: string;
    readonly callerDedupeKey?: string;
  }): Promise<{
    readonly disposition: "committed" | "duplicate";
    readonly resultId: string;
  }>;
  waitForTerminal(timeoutMs?: number): Promise<{
    readonly result: PrpStructuredRunResult;
    readonly terminal: PrpTerminalState;
    readonly turnId?: string;
    readonly providerSessionId?: string;
  }>;
  release(): Promise<void>;
}

function clampDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("runner_prp_credential_ttl_invalid");
  }
  return value;
}

function validateInput(input: PrepareRunnerPrpSessionInput): void {
  for (const id of [
    input.companyId,
    input.issueId,
    input.runId,
    input.agentId,
    input.runnerInstanceId,
    input.normalizedSessionId,
  ]) {
    if (!UUID_PATTERN.test(id)) throw new Error("runner_prp_binding_invalid");
  }
  for (const id of [input.environmentLeaseId, input.turnId, input.itemId]) {
    if (!STABLE_ID_PATTERN.test(id))
      throw new Error("runner_prp_binding_invalid");
  }
  if (
    !STABLE_ID_PATTERN.test(input.runnerVersion) ||
    !RUNNER_DIGEST_PATTERN.test(input.runnerDigest)
  ) {
    throw new Error("runner_prp_runner_identity_invalid");
  }
}

function completionCriterionIds(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const criteria = (value as Record<string, unknown>).criteria;
  if (!Array.isArray(criteria)) return null;
  const ids = criteria.map((criterion) => {
    if (typeof criterion !== "object" || criterion === null || Array.isArray(criterion)) return null;
    const id = (criterion as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  });
  if (ids.some((id) => id === null)) return null;
  const typedIds = ids as string[];
  return new Set(typedIds).size === typedIds.length ? typedIds : null;
}

/**
 * Creates the hidden, run-bound PRP authority. This module does not select a
 * runtime or start runnerd. The flagged adapter owns those actions later.
 */
export function runnerPrpCoordinator(
  db: Db,
  options: {
    readonly stateRoot: string;
    /** Internal restart-test seam. Production dispatch has no pause here. */
    readonly onSemanticToolInputCommitted?: (input: {
      readonly callId: string;
      readonly operationId: string;
    }) => Promise<void>;
  },
) {
  const stateRoot = resolve(options.stateRoot);

  return {
    prepare: async (
      input: PrepareRunnerPrpSessionInput,
    ): Promise<PreparedRunnerPrpSession> => {
      validateInput(input);
      const bootstrapTtlMs = clampDuration(
        input.bootstrapTtlMs,
        30_000,
        1_000,
        60_000,
      );
      const connectionLeaseTtlMs = clampDuration(
        input.connectionLeaseTtlMs,
        60 * 60 * 1_000,
        60_000,
        24 * 60 * 60 * 1_000,
      );

      const [binding] = await db
        .select({
          run: heartbeatRuns,
          issue: issues,
          agent: agents,
          completionContract: completionContracts,
        })
        .from(heartbeatRuns)
        .innerJoin(
          issues,
          and(
            eq(issues.id, heartbeatRuns.nativeIssueId),
            eq(issues.companyId, heartbeatRuns.companyId),
          ),
        )
        .innerJoin(
          agents,
          and(
            eq(agents.id, heartbeatRuns.agentId),
            eq(agents.companyId, heartbeatRuns.companyId),
          ),
        )
        .innerJoin(
          completionContracts,
          and(
            eq(completionContracts.id, heartbeatRuns.completionContractId),
            eq(completionContracts.companyId, heartbeatRuns.companyId),
            eq(completionContracts.issueId, heartbeatRuns.nativeIssueId),
          ),
        )
        .where(
          and(
            eq(heartbeatRuns.id, input.runId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
            eq(heartbeatRuns.nativeIssueId, input.issueId),
            eq(heartbeatRuns.runnerInstanceId, input.runnerInstanceId),
            eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
            eq(heartbeatRuns.runtimeMode, "native"),
          ),
        )
        .limit(1);
      if (
        !binding ||
        !["queued", "running"].includes(binding.run.status) ||
        binding.run.driverKind !== "codex" ||
        !binding.run.completionContractId ||
        !binding.run.completionContractSha256 ||
        binding.completionContract.canonicalSha256 !== binding.run.completionContractSha256 ||
        binding.issue.assigneeAgentId !== input.agentId ||
        binding.issue.executionRunId !== input.runId ||
        ["paused", "terminated", "pending_approval", "error"].includes(
          binding.agent.status,
        )
      ) {
        throw new Error("runner_prp_run_not_authorized");
      }
      const criterionIds = completionCriterionIds(
        binding.completionContract.contractJson,
      );
      if (!criterionIds) throw new Error("runner_prp_run_not_authorized");

      const semanticAuthority = new PaperclipRunnerSemanticAuthority(db, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        agentId: input.agentId,
      });
      const semanticTools = await semanticAuthority.listAlwaysAvailableTools();
      const nativeStore = new NativeRunCoordinatorStore(db, {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        agentId: input.agentId,
        normalizedSessionId: input.normalizedSessionId,
        runnerSourceInstanceId: input.runnerInstanceId,
        completionContractId: binding.run.completionContractId,
        completionContractSha256: binding.run.completionContractSha256,
        completionContractRevision: String(binding.completionContract.revision),
        completionContractCriterionIds: criterionIds,
      });
      type StoredCompletedRun = NonNullable<Awaited<ReturnType<typeof nativeStore.readCompletedRun>>>;
      type CompletedRun = StoredCompletedRun & { readonly providerSessionId?: string };
      const withProviderSession = async (stored: StoredCompletedRun): Promise<CompletedRun> => {
        const providerSessionId = await nativeStore.readProviderSessionId();
        return {
          ...stored,
          ...(providerSessionId ? { providerSessionId } : {}),
        };
      };
      let completedRun: CompletedRun | null = null;
      let resolveTerminal!: (value: CompletedRun) => void;
      const terminalEvent = new Promise<CompletedRun>((resolveTerminalPromise) => {
        resolveTerminal = resolveTerminalPromise;
      });
      const authority = new DurablePrpControlPlane({
        stateDirectory: resolve(stateRoot, input.runId),
        identity: {
          runnerInstanceId: input.runnerInstanceId,
          environmentLeaseId: input.environmentLeaseId,
          runId: input.runId,
          normalizedSessionId: input.normalizedSessionId,
          turnId: input.turnId,
          itemId: input.itemId,
        },
        expectedRunnerVersion: input.runnerVersion,
        expectedRunnerDigest: input.runnerDigest,
        connectionLeaseTtlMs,
        onCommittedEvent: async (event) => {
          await nativeStore.appendEvent(event);
          await nativeStore.reconcileTerminalEvent(event);
          if (event.eventType === "run.terminal") {
            const stored = await nativeStore.readCompletedRun();
            if (!stored) throw new Error("native_terminal_result_missing");
            completedRun = await withProviderSession(stored);
            resolveTerminal(completedRun);
          }
        },
        onSemanticToolInput: async (call) => {
          await options.onSemanticToolInputCommitted?.({
            callId: call.callId,
            operationId: call.operationId,
          });
          const result = await semanticAuthority.dispatch({
            callId: call.callId,
            operationId: call.operationId,
            correlation: call.correlation,
            input: call.input,
          });
          return { result, isError: !result.ok };
        },
      });

      const registration = await registerRunnerPrpAuthority({
        companyId: input.companyId,
        runId: input.runId,
        authority,
      });
      let bootstrapTicket: string;
      try {
        bootstrapTicket = authority.issueBootstrapTicket(bootstrapTtlMs);
      } catch (error) {
        authority.disconnectActiveRunner();
        await registration.release();
        throw error;
      }
      let released = false;
      return {
        connectUrl: registration.connectUrl,
        bootstrapTicket,
        issueBootstrapTicket: () => {
          if (released) throw new Error("runner_prp_session_released");
          return authority.issueBootstrapTicket(bootstrapTtlMs);
        },
        semanticTools,
        queueCommand: (type, payload = {}, commandId) => {
          if (released) throw new Error("runner_prp_session_released");
          const command = authority.queueCommand(
            type,
            payload,
            commandId,
            true,
          );
          return {
            commandId: command.commandId,
            controllerSeq: command.controllerSeq,
          };
        },
        completeRun: (completeInput) => {
          if (released) throw new Error("runner_prp_session_released");
          return nativeStore.completeRun(completeInput);
        },
        waitForTerminal: async (timeoutMs = 60 * 60 * 1_000) => {
          if (released) throw new Error("runner_prp_session_released");
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 24 * 60 * 60 * 1_000) {
            throw new Error("runner_prp_terminal_timeout_invalid");
          }
          if (completedRun) return completedRun;
          const stored = await nativeStore.readCompletedRun();
          if (stored) {
            completedRun = await withProviderSession(stored);
            return completedRun;
          }
          let timer: NodeJS.Timeout | null = null;
          try {
            return await Promise.race([
              terminalEvent,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("runner_prp_terminal_timeout")),
                  timeoutMs,
                );
                timer.unref();
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          authority.disconnectActiveRunner();
          await registration.release();
        },
      };
    },
  };
}

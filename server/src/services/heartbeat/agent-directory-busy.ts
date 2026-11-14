import type { Db } from "@paperclipai/db";
import { AgentDirectoryOperationBusyError } from "../agent-directory-working-copies.js";
import { deferNativeRunForBusyAgentDirectory } from "../native-runtime/native-controller-recovery.js";
import { AGENT_DIRECTORY_WAIT_RETRY_REASON } from "../execution-recovery-attempt.js";

export const AGENT_DIRECTORY_BUSY_RETRY_REASON = AGENT_DIRECTORY_WAIT_RETRY_REASON;
export const AGENT_DIRECTORY_BUSY_RETRY_WAKE_REASON = "agent_directory_busy_retry";
export const AGENT_DIRECTORY_BUSY_ERROR_CODE = "agent_directory_busy";
export const AGENT_DIRECTORY_BUSY_MAX_DEFERRALS = 30;
export const AGENT_DIRECTORY_BUSY_RETRY_MIN_MS = 5_000;
export const AGENT_DIRECTORY_BUSY_RETRY_JITTER_MS = 10_000;

export class AgentDirectoryPreparationDeferral extends Error {
  readonly code = AGENT_DIRECTORY_BUSY_ERROR_CODE;
  constructor(cause: AgentDirectoryOperationBusyError) {
    super("Another run of this agent is still using its files", { cause });
    this.name = "AgentDirectoryPreparationDeferral";
  }
}

export const REATTACH_AGENT_DIRECTORY_WAIT_MS = 30_000;

export async function prepareWithAgentDirectoryDeferral<T>(prepare: () => Promise<T>, options: {
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let delayMs = 100; ; delayMs = Math.min(delayMs * 2, 2_000)) {
    try {
      return await prepare();
    } catch (error) {
      if (!(error instanceof AgentDirectoryOperationBusyError)) throw error;
      if (Date.now() + delayMs > deadline) throw new AgentDirectoryPreparationDeferral(error);
      await sleep(delayMs);
    }
  }
}

export function agentDirectoryBusyRetryDelayMs(random: () => number = Math.random): number {
  return AGENT_DIRECTORY_BUSY_RETRY_MIN_MS + Math.floor(Math.min(Math.max(random(), 0), 0.999) * AGENT_DIRECTORY_BUSY_RETRY_JITTER_MS);
}

export type AgentDirectoryDeferralOutcome = "not_applicable" | "deferred" | "pre_admission" | "refused";

export async function deferRunForBusyAgentDirectory(db: Db, input: {
  run: { id: string; companyId: string };
  error: unknown;
  leaseOwner?: string;
  restartRecovery?: { leaseOwner: string };
  schedule: (runId: string, retryAt: Date, mode?: "restart") => void;
  record: (retryAt: Date) => Promise<void>;
  random?: () => number;
}): Promise<AgentDirectoryDeferralOutcome> {
  if (!(input.error instanceof AgentDirectoryPreparationDeferral)) return "not_applicable";
  const retryAt = new Date(Date.now() + agentDirectoryBusyRetryDelayMs(input.random));
  const outcome = await deferNativeRunForBusyAgentDirectory(db, {
    companyId: input.run.companyId, runId: input.run.id, leaseOwner: input.leaseOwner ?? input.restartRecovery?.leaseOwner,
    retryAt, maxDeferrals: AGENT_DIRECTORY_BUSY_MAX_DEFERRALS,
  });
  if (outcome !== "deferred") return outcome;
  await input.record(retryAt).catch(() => undefined);
  input.schedule(input.run.id, retryAt, input.restartRecovery ? "restart" : undefined);
  return "deferred";
}

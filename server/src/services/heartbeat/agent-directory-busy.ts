import type { Db } from "@paperclipai/db";
import { AgentDirectoryOperationBusyError } from "../agent-directory-working-copies.js";
import { deferNativeRunForBusyAgentDirectory } from "../native-runtime/native-controller-recovery.js";

export const AGENT_DIRECTORY_BUSY_RETRY_MIN_MS = 5_000;
export const AGENT_DIRECTORY_BUSY_RETRY_JITTER_MS = 10_000;

export async function deferRunForBusyAgentDirectory(db: Db, input: {
  run: { id: string; companyId: string };
  error: unknown;
  schedule: (runId: string, retryAt: Date) => void;
  record: (retryAt: Date) => Promise<void>;
  random?: () => number;
}): Promise<boolean> {
  if (!(input.error instanceof AgentDirectoryOperationBusyError)) return false;
  const retryAt = new Date(Date.now() + AGENT_DIRECTORY_BUSY_RETRY_MIN_MS
    + Math.floor((input.random ?? Math.random)() * AGENT_DIRECTORY_BUSY_RETRY_JITTER_MS));
  if (!await deferNativeRunForBusyAgentDirectory(db, { companyId: input.run.companyId, runId: input.run.id, retryAt })) return false;
  await input.record(retryAt).catch(() => undefined);
  input.schedule(input.run.id, retryAt);
  return true;
}

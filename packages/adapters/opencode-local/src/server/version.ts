import {
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

export async function usesOpenCodeV2(input: {
  runId: string;
  target: AdapterExecutionTarget | null;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  let result;
  try {
    result = await runAdapterExecutionTargetProcess(
      input.runId,
      input.target,
      input.command,
      ["--version"],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 10) : 10,
        graceSec: 1,
        onLog: async () => {},
      },
    );
  } catch {
    input.signal?.throwIfAborted();
    return false;
  }
  input.signal?.throwIfAborted();
  if (result.signal && !result.timedOut) throw new Error("OpenCode version check was interrupted");
  return result.exitCode === 0 && !result.timedOut && /^\s*(?:opencode\s+)?v?2\./i.test(result.stdout);
}

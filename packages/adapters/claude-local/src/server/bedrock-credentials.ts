import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { isClaudeExpiredCredentialError } from "./parse.js";

/**
 * Bounded pre-flight AWS/Bedrock credential probe for the claude_local adapter.
 *
 * An expired AWS/Bedrock security token makes the Claude CLI spawn do zero work
 * and exit `403 The security token included in the request is expired`, burning
 * a heartbeat. Running a cheap `aws sts get-caller-identity` before the spawn
 * lets us positively detect an expired token and defer the run instead.
 *
 * The probe is deliberately fail-open: only a *positive* expiry detection blocks
 * the spawn. Any other outcome (timeout, missing CLI, AccessDenied, unknown
 * error) returns `indeterminate` so the caller proceeds to spawn as normal and
 * never hangs a heartbeat on the probe itself.
 */
export type BedrockCredentialProbeStatus = "valid" | "expired" | "indeterminate";

export interface BedrockCredentialProbeResult {
  status: BedrockCredentialProbeStatus;
  detail?: string;
}

/** Default short timeout for the STS probe (seconds). Kept small so it can never hang a heartbeat. */
export const DEFAULT_BEDROCK_PREFLIGHT_TIMEOUT_SEC = 5;

interface ProbeProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function firstNonEmptyLine(...texts: Array<string | null | undefined>): string {
  for (const text of texts) {
    const line = (text ?? "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (line) return line;
  }
  return "";
}

/**
 * Classify a completed `aws sts get-caller-identity` probe.
 * - exit 0                         => valid
 * - non-zero AND expiry wording    => expired (defer)
 * - timed out / non-expiry failure => indeterminate (fail-open, spawn as normal)
 */
export function classifyBedrockCredentialProbe(proc: ProbeProcessOutcome): BedrockCredentialProbeResult {
  if (proc.timedOut) {
    return { status: "indeterminate", detail: "sts probe timed out" };
  }
  if ((proc.exitCode ?? 0) === 0) {
    return { status: "valid" };
  }
  if (isClaudeExpiredCredentialError({ stdout: proc.stdout, stderr: proc.stderr })) {
    return {
      status: "expired",
      detail: firstNonEmptyLine(proc.stderr, proc.stdout) || "expired security token",
    };
  }
  return {
    status: "indeterminate",
    detail: firstNonEmptyLine(proc.stderr, proc.stdout) || `sts probe exited ${proc.exitCode ?? -1}`,
  };
}

/**
 * Run the bounded credential probe against the execution target using the same
 * env/cwd the Claude CLI would use. Never throws — a probe error resolves to
 * `indeterminate` so the caller can fail open.
 */
export async function runBedrockCredentialPreflight(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
}): Promise<BedrockCredentialProbeResult> {
  const timeoutSec = input.timeoutSec && input.timeoutSec > 0
    ? input.timeoutSec
    : DEFAULT_BEDROCK_PREFLIGHT_TIMEOUT_SEC;
  try {
    const proc = await runAdapterExecutionTargetProcess(
      input.runId,
      input.target ?? null,
      "aws",
      ["sts", "get-caller-identity", "--output", "json"],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    return classifyBedrockCredentialProbe(proc);
  } catch (err) {
    return {
      status: "indeterminate",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { logSandboxProbeDiagnostic } from "./probe-diagnostics.js";
import {
  detectClaudeLoginRequired,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

export const CLAUDE_HELLO_PROMPT = "Respond with hello.";

/**
 * Run the fixed, read-only provider round trip shared by the Claude CLI and ACP
 * Test lanes. The function parses raw process output only to select fixed public
 * checks. It never copies stdout, stderr, thrown messages, credentials, or
 * session paths into a check or log.
 */
export async function runClaudeHelloProbe(input: {
  runId: string;
  target: AdapterExecutionTarget | null;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
}): Promise<AdapterEnvironmentCheck[]> {
  let probe: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
  try {
    probe = await runAdapterExecutionTargetProcess(
      input.runId,
      input.target,
      input.command,
      input.args,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: 5,
        stdin: CLAUDE_HELLO_PROMPT,
        onLog: async () => {},
      },
    );
  } catch {
    logSandboxProbeDiagnostic("Claude hello probe could not run", "spawn_error");
    return [
      {
        code: "claude_hello_probe_failed",
        level: "warn",
        message: "Claude hello probe could not run.",
        hint: "Verify that the Claude CLI is executable in this environment and retry the Test.",
      },
    ];
  }

  if (probe.timedOut) {
    return [
      {
        code: "claude_hello_probe_timed_out",
        level: "warn",
        message: "Claude hello probe timed out.",
        hint: "Retry the probe. If this persists, verify Claude can run the fixed hello check from this directory.",
      },
    ];
  }

  const parsedStream = parseClaudeStreamJson(probe.stdout);
  const parsed = parsedStream.resultJson;
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: probe.stdout,
    stderr: probe.stderr,
  });
  if (loginMeta.requiresLogin) {
    logSandboxProbeDiagnostic("Claude hello probe reported login required", "auth_required");
    return [
      {
        code: "claude_hello_probe_auth_required",
        level: "warn",
        message: "Claude login is required.",
        // A provider-supplied URL can carry an opaque session identifier in its
        // path even when its host is trusted. Keep the public check fully fixed.
        hint: "Run `claude login` in this environment, then retry the probe.",
      },
    ];
  }

  if ((probe.exitCode ?? 1) === 0) {
    const hasHello = /\bhello\b/i.test(parsedStream.summary);
    if (!hasHello) {
      logSandboxProbeDiagnostic(
        "Claude hello probe returned unexpected output",
        "unexpected_output",
      );
    }
    return [
      {
        code: hasHello
          ? "claude_hello_probe_passed"
          : "claude_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Claude hello probe succeeded."
          : "Claude probe ran but did not return `hello` as expected.",
        ...(hasHello
          ? {}
          : { hint: "Retry after verifying the provider response for the fixed hello check." }),
      },
    ];
  }

  logSandboxProbeDiagnostic("Claude hello probe failed", "nonzero_exit", {
    exitCode: probe.exitCode ?? null,
  });
  if (isClaudeProviderQuotaError({ parsed, stdout: probe.stdout, stderr: probe.stderr })) {
    return [
      {
        code: "claude_hello_probe_usage_limited",
        level: "warn",
        message: "Claude hello probe hit the subscription usage limit.",
        hint: "Wait for the usage window to reset and retry the Test.",
      },
    ];
  }
  if (isClaudeTransientUpstreamError({ parsed, stdout: probe.stdout, stderr: probe.stderr })) {
    return [
      {
        code: "claude_hello_probe_transient_upstream",
        level: "warn",
        message: "Claude hello probe hit a transient upstream error.",
        hint: "Wait a moment and retry the Test.",
      },
    ];
  }
  return [
    {
      code: "claude_hello_probe_failed",
      level: "error",
      message: "Claude hello probe failed.",
      hint: `Exit code ${probe.exitCode ?? "unknown"}. Retry after verifying the Claude CLI and credentials.`,
    },
  ];
}

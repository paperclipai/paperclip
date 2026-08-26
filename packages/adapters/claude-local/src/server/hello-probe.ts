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

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * Rebuild the provider-probe argv from a deliberately small allowlist. A Test
 * configuration may normally opt into tools, Chrome, plugins, hooks, or broad
 * permission modes for a real agent run. None of those belong in the fixed
 * hello round trip: the probe only needs the selected model/effort and a text
 * response. Rebuilding instead of appending safety flags prevents a later
 * caller argument from overriding the no-tool contract.
 */
export function buildClaudeHelloProbeArgs(args: string[]): string[] {
  let model: string | null = null;
  let effort: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--model" && value && !value.startsWith("-")) {
      model = value;
      index += 1;
      continue;
    }
    if (
      arg === "--effort" &&
      value &&
      ["low", "medium", "high", "xhigh", "max"].includes(value)
    ) {
      effort = value;
      index += 1;
    }
  }

  return [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--tools",
    "",
  ];
}

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
  const probeArgs = buildClaudeHelloProbeArgs(input.args);
  let probe: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
  try {
    probe = await runAdapterExecutionTargetProcess(
      input.runId,
      input.target,
      input.command,
      probeArgs,
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

  // Child-process exit codes are integers. Treat every other transport value
  // as unknown before it reaches a public hint or structured diagnostic.
  const exitCode =
    typeof probe.exitCode === "number" && Number.isSafeInteger(probe.exitCode)
      ? probe.exitCode
      : null;

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

  if (exitCode === 0) {
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
    exitCode,
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
      hint: `Exit code ${exitCode ?? "unknown"}. Retry after verifying the Claude CLI and credentials.`,
    },
  ];
}

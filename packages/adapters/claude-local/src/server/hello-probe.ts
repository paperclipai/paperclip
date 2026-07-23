import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { asString, parseJson } from "@paperclipai/adapter-utils/server-utils";
import {
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeInvalidCredentialError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";
import { claudeCommandSupportsEffortFlag } from "./cli-capabilities.js";
import { isBedrockModelId } from "./models.js";
import { buildClaudeProbePermissionArgs } from "./permissions.js";

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function lastNonInitStdoutLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const parsed = parseJson(line);
    if (parsed && asString(parsed.type, "") === "system" && asString(parsed.subtype, "") === "init") {
      continue;
    }
    return line;
  }
  return "";
}

function truncateDetail(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || lastNonInitStdoutLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export interface ClaudeHelloProbeInput {
  runId: string;
  target: AdapterExecutionTarget | null;
  /** The `claude` CLI command itself, distinct from any ACP server binary. */
  command: string;
  cwd: string;
  /** Resolved (secret_ref already expanded to plaintext), string-only env. */
  env: Record<string, string>;
  model: string;
  effort: string;
  chrome: boolean;
  maxTurns: number;
  dangerouslySkipPermissions: boolean;
  extraArgs: string[];
  hasBedrock: boolean;
  targetIsSandbox: boolean;
  targetIsRemote: boolean;
  helloProbeTimeoutSec: number;
}

/**
 * Live "say hello to Claude" probe: actually invokes the `claude` CLI with
 * the resolved credential env and classifies the real provider response via
 * parse.ts's `detectClaudeLoginRequired`/`isClaudeInvalidCredentialError`.
 *
 * Shared by BOTH Claude execution lanes (the CLI lane in test.ts, and the
 * ACP lane in acp.ts). ACP has no protocol-level equivalent of this
 * validation step, so its environment check reuses this CLI-binary probe
 * rather than inventing a parallel ACP-specific one: the `claude` binary is
 * present in the runtime image regardless of which engine ultimately
 * executes real agent runs, so invoking it purely to validate a credential
 * is a legitimate, low-risk shortcut rather than a layering violation.
 *
 * Returns the check(s) this probe attempt produced (normally one; two when
 * the sandbox's Claude CLI doesn't support --effort, which adds its own
 * informational warning alongside the eventual pass/fail check). Never
 * throws for a classification/provider-side outcome, every branch resolves
 * to a check. A genuinely unexpected exception (e.g. the process runner
 * itself throwing) is the caller's responsibility to catch and treat as an
 * infra failure, consistent with "the check cannot run stays permissive".
 */
export async function runClaudeCredentialHelloProbe(
  input: ClaudeHelloProbeInput,
): Promise<AdapterEnvironmentCheck[]> {
  const checks: AdapterEnvironmentCheck[] = [];
  const {
    runId,
    target,
    command,
    cwd,
    env,
    model,
    hasBedrock,
    targetIsSandbox,
    targetIsRemote,
    dangerouslySkipPermissions,
    extraArgs,
    maxTurns,
    chrome,
    helloProbeTimeoutSec,
  } = input;

  let effectiveEffort = input.effort;
  if (targetIsSandbox && effectiveEffort) {
    const supportsEffort = await claudeCommandSupportsEffortFlag({
      runId,
      command,
      target,
      cwd,
      env,
      timeoutSec: 45,
      graceSec: 5,
    });
    if (supportsEffort === false) {
      effectiveEffort = "";
      checks.push({
        code: "claude_effort_flag_unsupported",
        level: "warn",
        message:
          "Claude CLI in the sandbox does not advertise --effort; the probe omitted the configured reasoning effort.",
        hint: "Upgrade the sandbox CLI/template to a newer Claude Code release to restore reasoning-effort control.",
      });
    }
  }

  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  args.push(...buildClaudeProbePermissionArgs({ dangerouslySkipPermissions, targetIsRemote }));
  if (chrome) args.push("--chrome");
  // For Bedrock: only pass --model when the ID is a Bedrock-native identifier.
  if (model && (!hasBedrock || isBedrockModelId(model))) {
    args.push("--model", model);
  }
  if (effectiveEffort) args.push("--effort", effectiveEffort);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  if (extraArgs.length > 0) args.push(...extraArgs);

  const probe = await runAdapterExecutionTargetProcess(runId, target, command, args, {
    cwd,
    env,
    timeoutSec: helloProbeTimeoutSec,
    graceSec: 5,
    stdin: "Respond with hello.",
    onLog: async () => {},
  });

  const parsedStream = parseClaudeStreamJson(probe.stdout);
  const parsed = parsedStream.resultJson;
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: probe.stdout,
    stderr: probe.stderr,
  });
  const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

  if (probe.timedOut) {
    checks.push({
      code: "claude_hello_probe_timed_out",
      level: "warn",
      message: "Claude hello probe timed out.",
      hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
    });
    return checks;
  }

  if (loginMeta.requiresLogin) {
    // The CLI's generic "please log in" prompt also fires for a just-pasted
    // invalid API key (its message literally says "Invalid API key ... run
    // /login" regardless of root cause). When the message specifically told
    // us the credential is invalid, treat it as a hard failure rather than
    // the soft "you haven't signed in yet" nudge below, or a mangled/expired
    // BYOK key sails through onboarding as "Connected" and only fails on the
    // agent's first run.
    checks.push(
      loginMeta.credentialRejected
        ? {
            code: "claude_hello_probe_credential_rejected",
            level: "error",
            message: "Claude rejected the provided credential.",
            ...(detail ? { detail } : {}),
            authFailure: true,
            hint: "Paste a fresh, valid Claude API key or subscription token, then retry.",
          }
        : {
            code: "claude_hello_probe_auth_required",
            level: "warn",
            message: "Claude CLI is installed, but login is required.",
            ...(detail ? { detail } : {}),
            hint: loginMeta.loginUrl
              ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
              : "Run `claude login` in this environment, then retry the probe.",
          },
    );
    return checks;
  }

  if ((probe.exitCode ?? 1) === 0) {
    const summary = parsedStream.summary.trim();
    const hasHello = /\bhello\b/i.test(summary);
    checks.push({
      code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
      level: hasHello ? "info" : "warn",
      message: hasHello
        ? "Claude hello probe succeeded."
        : "Claude probe ran but did not return `hello` as expected.",
      ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
      ...(hasHello
        ? {}
        : {
            hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose`) and prompt `Respond with hello`.",
          }),
    });
    return checks;
  }

  // Surface the actual failure instead of the leading stream-json
  // `system/init` line: the real error lives in the final `result` event
  // (parsed) or, when the CLI dies before emitting one, the last non-init
  // stdout line, never the first one `summarizeProbeDetail` returns.
  const stdoutFallback = lastNonInitStdoutLine(probe.stdout);
  const failureDetail =
    (parsed ? describeClaudeFailure(parsed) : null) ||
    (firstNonEmptyLine(probe.stderr) ? truncateDetail(firstNonEmptyLine(probe.stderr)) : "") ||
    (stdoutFallback ? truncateDetail(stdoutFallback) : "") ||
    detail ||
    "";
  const transient = isClaudeTransientUpstreamError({
    parsed,
    stdout: probe.stdout,
    stderr: probe.stderr,
  });
  // Some invalid-credential payloads (raw 401 / "invalid x-api-key" /
  // authentication_error) never match the login-prompt wording above, so
  // loginMeta.requiresLogin is false and execution falls straight here.
  // Still flag authFailure so the client can distinguish a rejected
  // credential from any other hard failure (bad command, crashed CLI, etc.).
  const invalidCredential =
    !transient &&
    isClaudeInvalidCredentialError({
      parsed,
      stdout: probe.stdout,
      stderr: probe.stderr,
      errorMessage: failureDetail || null,
    });
  checks.push(
    transient
      ? {
          code: "claude_hello_probe_transient_upstream",
          level: "warn",
          message: "Claude hello probe hit a transient upstream error (rate limit or overload).",
          ...(failureDetail ? { detail: failureDetail } : {}),
          hint: "This is usually temporary. Wait a moment and re-run Test.",
        }
      : {
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          ...(failureDetail ? { detail: failureDetail } : {}),
          ...(invalidCredential ? { authFailure: true } : {}),
          hint: invalidCredential
            ? "Paste a fresh, valid Claude API key or subscription token, then retry."
            : `Exit code ${probe.exitCode ?? "unknown"}. Run \`claude --print - --output-format stream-json --verbose\` manually in this directory and prompt \`Respond with hello\` to debug.`,
        },
  );
  return checks;
}

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import path from "node:path";
import { describeClaudeFailure, detectClaudeLoginRequired, parseClaudeStreamJson } from "./parse.js";
import { isBedrockModelId } from "./models.js";
import { buildClaudeProbePermissionArgs } from "./permissions.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "claude_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Detect if config explicitly mentions ANTHROPIC_API_KEY (even with non-string
  // value like { type: "plain", value: "" } from the "Unset" UI action). When
  // the config explicitly overrides it, the host env should not be considered.
  const configExplicitlyHasAnthropicApiKey = "ANTHROPIC_API_KEY" in envConfig;

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "claude",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  // When probing a remote target, the Paperclip host's process.env does not
  // reflect what the agent will actually see at runtime. Only consider env
  // vars from the adapter config in that case; the probe itself will surface
  // any auth issues on the remote box.
  const considerHostEnv = !targetIsRemote;
  const hasBedrock =
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "1") ||
    (considerHostEnv && process.env.CLAUDE_CODE_USE_BEDROCK === "true") ||
    isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL) ||
    (considerHostEnv && isNonEmpty(process.env.ANTHROPIC_BEDROCK_BASE_URL));

  const configApiKey = env.ANTHROPIC_API_KEY;
  // When config explicitly has ANTHROPIC_API_KEY (even as an override with empty
  // value), it takes precedence over the host env.
  const hostApiKey =
    considerHostEnv && !configExplicitlyHasAnthropicApiKey
      ? process.env.ANTHROPIC_API_KEY
      : undefined;
  if (hasBedrock) {
    const source =
      env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      env.CLAUDE_CODE_USE_BEDROCK === "true" ||
      isNonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "claude_bedrock_auth",
      level: "info",
      message: "AWS Bedrock auth detected. Claude will use Bedrock for inference.",
      detail: `Detected in ${source}.`,
      hint: "Ensure AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE) and AWS_REGION are configured.",
    });
  } else if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription credentials.",
      detail: `Detected in ${source}.`,
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "claude_subscription_mode_possible",
      level: "info",
      message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
    });
  }

  // Build the env actually passed to the probe process. Since runChildProcess
  // merges with process.env, explicitly set ANTHROPIC_API_KEY to empty string
  // when the config overrides it, so the host env value doesn't leak through.
  const probeEnv: Record<string, string> = { ...env };
  if (configExplicitlyHasAnthropicApiKey && !isNonEmpty(configApiKey)) {
    probeEnv.ANTHROPIC_API_KEY = "";
  }

  const canRunProbe =
    checks.every((check) => check.code !== "claude_cwd_invalid" && check.code !== "claude_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      args.push(...buildClaudeProbePermissionArgs({ dangerouslySkipPermissions, targetIsSandbox }));
      if (chrome) args.push("--chrome");
      // For Bedrock: only pass --model when the ID is a Bedrock-native identifier.
      if (model && (!hasBedrock || isBedrockModelId(model))) {
        args.push("--model", model);
      }
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      async function runSingleProbe(
        probeRunEnv: Record<string, string>,
      ): Promise<{
        probeResult: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
        parsedStream: ReturnType<typeof parseClaudeStreamJson>;
        parsed: Record<string, unknown> | null;
        detail: string | null;
      }> {
        const probeResult = await runAdapterExecutionTargetProcess(
          runId,
          target,
          command,
          args,
          {
            cwd,
            env: probeRunEnv,
            timeoutSec: 45,
            graceSec: 5,
            stdin: "Respond with hello.",
            onLog: async () => {},
          },
        );

        const parsedStream = parseClaudeStreamJson(probeResult.stdout);
        const parsed = parsedStream.resultJson;
        const detail = summarizeProbeDetail(probeResult.stdout, probeResult.stderr);
        return { probeResult, parsedStream, parsed, detail };
      }

      function addProbeCheck(
        parsed: Record<string, unknown> | null,
        detail: string | null,
        loginMeta: ReturnType<typeof detectClaudeLoginRequired>,
        probeResult: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>,
        parsedStream: ReturnType<typeof parseClaudeStreamJson>,
      ) {
        if (probeResult.timedOut) {
          checks.push({
            code: "claude_hello_probe_timed_out",
            level: "warn",
            message: "Claude hello probe timed out.",
            hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
          });
          return;
        }

        if (loginMeta.requiresLogin) {
          checks.push({
            code: "claude_hello_probe_auth_required",
            level: "warn",
            message: "Claude CLI is installed, but login is required.",
            ...(detail ? { detail } : {}),
            hint: loginMeta.loginUrl
              ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
              : "Run `claude login` in this environment, then retry the probe.",
          });
          return;
        }

        if ((probeResult.exitCode ?? 1) === 0) {
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
          return;
        }

        // Probe failed — try to surface a specific error from the structured
        // JSON output before falling back to the generic stderr line.
        const failureMessage = parsed
          ? describeClaudeFailure(parsed)
          : null;
        checks.push({
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          ...(failureMessage || detail ? { detail: failureMessage ?? detail } : {}),
          hint: "Run `claude --print - --output-format stream-json --verbose` manually in this directory and prompt `Respond with hello` to debug.",
        });
      }

      const initial = await runSingleProbe(probeEnv);
      const loginMeta = detectClaudeLoginRequired({
        parsed: initial.parsed,
        stdout: initial.probeResult.stdout,
        stderr: initial.probeResult.stderr,
      });

      // Problem 1: automatic API-key → subscription fallback.
      // When the probe failed AND ANTHROPIC_API_KEY came from the host env
      // (not from the adapter config), retry without it. If the fallback
      // probe succeeds using subscription auth, report the probe as a
      // warning-level pass instead of an error-level failure.
      const apiKeyCameFromHost =
        isNonEmpty(hostApiKey) &&
        !isNonEmpty(configApiKey) &&
        !configExplicitlyHasAnthropicApiKey;
      const shouldRetryWithoutApiKey =
        apiKeyCameFromHost &&
        !initial.probeResult.timedOut &&
        !loginMeta.requiresLogin &&
        (initial.probeResult.exitCode ?? 1) !== 0;

      if (shouldRetryWithoutApiKey) {
        const retryEnv = { ...probeEnv, ANTHROPIC_API_KEY: "" };
        const retry = await runSingleProbe(retryEnv);
        const retryLoginMeta = detectClaudeLoginRequired({
          parsed: retry.parsed,
          stdout: retry.probeResult.stdout,
          stderr: retry.probeResult.stderr,
        });

        if ((retry.probeResult.exitCode ?? 1) === 0 && /\bhello\b/i.test(retry.parsedStream.summary.trim())) {
          // Fallback succeeded — report a warning-level pass
          checks.push({
            code: "claude_hello_probe_passed_fallback",
            level: "warn",
            message:
              "Claude hello probe succeeded via subscription fallback after host ANTHROPIC_API_KEY failed.",
            detail:
              "The ANTHROPIC_API_KEY from the host environment had insufficient credits or permissions. Paperclip retried with subscription-based auth, which succeeded.",
            hint:
              "Unset ANTHROPIC_API_KEY from your shell environment to avoid this fallback on future probes.",
          });
        } else {
          // Fallback also failed — report the original failure (prefer specific JSON error)
          addProbeCheck(
            initial.parsed,
            initial.detail,
            loginMeta,
            initial.probeResult,
            initial.parsedStream,
          );
        }
      } else {
        addProbeCheck(
          initial.parsed,
          initial.detail,
          loginMeta,
          initial.probeResult,
          initial.parsedStream,
        );
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

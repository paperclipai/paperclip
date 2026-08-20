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
  runAdapterExecutionTargetProcess,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import {
  detectClaudeLoginRequired,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";
import { claudeCommandLooksLike, claudeCommandSupportsEffortFlag } from "./cli-capabilities.js";
import { isBedrockModelId } from "./models.js";
import { buildClaudeProbePermissionArgs } from "./permissions.js";
import { prepareSandboxClaudeProbeRuntime } from "./claude-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveClaudeExecutionEngineForRun, testClaudeAcpEnvironment } from "./acp.js";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";
import {
  buildAdapterTestTargetCheck,
  buildClaudeLoginRequiredHint,
  logSandboxProbeDiagnostic,
} from "./probe-diagnostics.js";
import { buildLocalAdapterTestProbeEnv } from "./probe-env.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const engineSelection = await resolveClaudeExecutionEngineForRun({
    config: parseObject(ctx.config),
    executionTarget: ctx.executionTarget,
  });
  if (engineSelection.engine === "acp") {
    return testClaudeAcpEnvironment(ctx);
  }

  const checks: AdapterEnvironmentCheck[] = [];
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    checks.push({
      code: "claude_acp_default_fallback",
      level: "warn",
      message: "Claude ACP default is unavailable; testing the Claude CLI fallback lane.",
      detail: engineSelection.fallbackReason,
      hint: "Fix the ACP prerequisite to use the default ACP lane, or set engine=cli to pin the CLI lane.",
    });
  }
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // Always name the target the Test probed, so a pass result never hides which
  // target it checked. A local probe reports the fixed host label.
  checks.push(
    buildAdapterTestTargetCheck({ targetIsRemote, environmentName: ctx.environmentName }),
  );

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
  // For a local probe, resolve the trusted `claude` executable and a
  // deny-by-default child env from the shared builder, so a hostile caller
  // value can neither select the executable nor reach the child. A remote
  // target keeps the caller command and env; the remote transport owns its own
  // env sanitization.
  const localProbe = targetIsRemote
    ? null
    : await buildLocalAdapterTestProbeEnv({ callerEnv: env, trustedEnv: process.env });
  checks.push(
    ...(await prepareSandboxClaudeProbeRuntime({
      runId,
      target,
      cwd,
      companyId: ctx.companyId,
      env,
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      targetIsRemote,
      targetIsSandbox,
      helloProbeTimeoutSec: asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45),
    })),
  );
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
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
  const hostApiKey = considerHostEnv ? process.env.ANTHROPIC_API_KEY : undefined;
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
  } else if (
    isNonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN) ||
    (considerHostEnv && isNonEmpty(process.env.CLAUDE_CODE_OAUTH_TOKEN))
  ) {
    const source = isNonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN)
      ? "configured environment variables"
      : "server environment";
    checks.push({
      code: "claude_oauth_token_configured",
      level: "info",
      message:
        "CLAUDE_CODE_OAUTH_TOKEN is set. Claude will authenticate with the configured subscription token; no stored login is needed on the execution target.",
      detail: `Detected in ${source}.`,
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "claude_subscription_mode_possible",
      level: "info",
      message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
    });
  }

  const canRunProbe =
    checks.every(
      (check) =>
        check.code !== "claude_cwd_invalid" &&
        check.code !== "claude_command_unresolvable" &&
        check.code !== "claude_managed_config_dir_failed",
    );
  if (canRunProbe) {
    if (!claudeCommandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else if (localProbe && !localProbe.command) {
      // The trusted server PATH holds no `claude`, so the local probe cannot
      // run. Report a warn, never a silent pass.
      checks.push({
        code: "claude_hello_probe_skipped_unresolved_command",
        level: "warn",
        message: "Skipped the Claude hello probe because `claude` is not installed on the Paperclip host.",
        hint: "Install the `claude` CLI on the Paperclip host, then retry the Test.",
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

      let effectiveEffort = effort;
      if (targetIsSandbox && effort) {
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
      args.push(...buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions,
        targetIsRemote,
        localProcessUid: process.getuid?.() ?? null,
      }));
      if (chrome) args.push("--chrome");
      // For Bedrock: only pass --model when the ID is a Bedrock-native identifier.
      if (model && (!hasBedrock || isBedrockModelId(model))) {
        args.push("--model", model);
      }
      if (effectiveEffort) args.push("--effort", effectiveEffort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      // Sandbox bridges still add lease warmup and transport overhead, but
      // the standard-2 Cloudflare tier now probes fast enough that a 90s
      // budget leaves headroom without masking real hangs.
      const helloProbeTimeoutSec = Math.max(
        1,
        asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45),
      );

      // A local probe uses the trusted resolved executable and the
      // deny-by-default child env. A remote probe uses the caller command and
      // env, because the remote transport owns its own env sanitization.
      const probeCommand = localProbe?.command ?? command;
      const probeEnv = localProbe ? localProbe.env : env;
      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        probeCommand,
        args,
        {
          cwd,
          env: probeEnv,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );

      const parsedStream = parseClaudeStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const loginMeta = detectClaudeLoginRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (probe.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        // The raw probe output is untrusted. Log only the fixed context and the
        // allowlisted classification. Return only a fixed public message and a
        // safe hint.
        logSandboxProbeDiagnostic(
          "Claude CLI hello probe reported login required",
          "auth_required",
        );
        checks.push({
          code: "claude_hello_probe_auth_required",
          level: "warn",
          message: "Claude CLI is installed, but login is required.",
          hint: buildClaudeLoginRequiredHint(loginMeta.loginUrl),
        });
        if (targetIsSandbox) {
          // Emit the neutral canonical check so the user interface can decide
          // login eligibility from a stable code. The user interface does not
          // read the message text or the top-level status.
          checks.push({
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn",
            message: "The sandbox has no ready authentication for this adapter.",
            hint: "Provide credentials for this adapter, or start login in the sandbox.",
          });
        }
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        if (!hasHello) {
          // The unexpected summary is untrusted probe output. Log only the fixed
          // context and the allowlisted classification. Keep the check text
          // fixed.
          logSandboxProbeDiagnostic(
            "Claude CLI hello probe returned unexpected output",
            "unexpected_output",
          );
        }
        checks.push({
          code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claude hello probe succeeded."
            : "Claude probe ran but did not return `hello` as expected.",
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose`) and prompt `Respond with hello`.",
              }),
        });
      } else {
        // The failure diagnostic is untrusted. Log only the fixed context, the
        // allowlisted classification, and the safe exit code. Return only a
        // fixed public message and hint.
        logSandboxProbeDiagnostic("Claude CLI hello probe failed", "nonzero_exit", {
          exitCode: probe.exitCode ?? null,
        });
        // Provider-quota exhaustion (usage/session limit) is classified
        // separately from generic transient upstream errors: auth works, the
        // subscription's usage window is just spent. Surface it as its own
        // warning instead of a hard probe failure.
        const usageLimited = isClaudeProviderQuotaError({
          parsed,
          stdout: probe.stdout,
          stderr: probe.stderr,
        });
        const transient = isClaudeTransientUpstreamError({
          parsed,
          stdout: probe.stdout,
          stderr: probe.stderr,
        });
        checks.push(
          usageLimited
            ? {
                code: "claude_hello_probe_usage_limited",
                level: "warn",
                message: "Claude hello probe hit the subscription usage limit.",
                hint: "Authentication works; the account's usage window is exhausted. Wait for the limit to reset and re-run Test.",
              }
            : transient
              ? {
                  code: "claude_hello_probe_transient_upstream",
                  level: "warn",
                  message: "Claude hello probe hit a transient upstream error (rate limit or overload).",
                  hint: "This is usually temporary. Wait a moment and re-run Test.",
                }
              : {
                  code: "claude_hello_probe_failed",
                  level: "error",
                  message: "Claude hello probe failed.",
                  hint: `Exit code ${probe.exitCode ?? "unknown"}. Run \`claude --print - --output-format stream-json --verbose\` manually in this directory and prompt \`Respond with hello\` to debug.`,
                },
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

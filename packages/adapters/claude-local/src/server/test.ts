import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  parseJson,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  adapterExecutionTargetUsesManagedHome,
} from "@paperclipai/adapter-utils/execution-target";
import {
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";
import { claudeCommandLooksLike, claudeCommandSupportsEffortFlag } from "./cli-capabilities.js";
import { isBedrockModelId } from "./models.js";
import { buildClaudeProbePermissionArgs } from "./permissions.js";
import { materializeRemoteClaudeConfig, prepareClaudeConfigSeed } from "./claude-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveClaudeExecutionEngineForRun, testClaudeAcpEnvironment } from "./acp.js";

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
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "claude",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
  const hasExplicitClaudeConfigDir = isNonEmpty(env.CLAUDE_CONFIG_DIR);
  if (targetIsRemote && adapterExecutionTargetUsesManagedHome(target) && !hasExplicitClaudeConfigDir) {
    let tempWorkspaceDir: string | null = null;
    let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
    try {
      const seedDir = await prepareClaudeConfigSeed(process.env, async () => {}, ctx.companyId);
      const managedRemoteCwd = target?.kind === "remote" ? target.remoteCwd : cwd;
      tempWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-envtest-workspace-"));
      preparedRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "claude",
        workspaceLocalDir: tempWorkspaceDir,
        workspaceRemoteDir: managedRemoteCwd,
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45)),
        assets: [
          {
            key: "config-seed",
            localDir: seedDir,
            followSymlinks: true,
          },
        ],
      });
      const runtimeRootDir =
        preparedRuntime.runtimeRootDir ?? path.posix.join(managedRemoteCwd, ".paperclip-runtime", "claude");
      const remoteClaudeConfigSeedDir =
        preparedRuntime.assetDirs["config-seed"] ?? path.posix.join(runtimeRootDir, "config-seed");
      const remoteClaudeConfigDir = path.posix.join(runtimeRootDir, "config");
      env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      await materializeRemoteClaudeConfig({
        runId,
        target,
        remoteClaudeConfigDir,
        remoteClaudeConfigSeedDir,
        options: {
          cwd,
          env,
          timeoutSec: Math.max(15, asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45)),
          graceSec: 5,
          onLog: async () => {},
        },
      });
      checks.push({
        code: "claude_managed_config_dir",
        level: "info",
        message: "Sandbox probe is using Paperclip-managed Claude config materialization.",
        detail: remoteClaudeConfigDir,
      });
    } catch (err) {
      checks.push({
        code: "claude_managed_config_dir_failed",
        level: "error",
        message: "Could not materialize Paperclip-managed Claude config for the sandbox probe.",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await preparedRuntime?.restoreWorkspace().catch(() => undefined);
      if (tempWorkspaceDir) {
        await fs.rm(tempWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
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
      args.push(...buildClaudeProbePermissionArgs({ dangerouslySkipPermissions, targetIsRemote }));
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

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env,
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
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        checks.push({
          code: "claude_hello_probe_auth_required",
          level: "warn",
          message: "Claude CLI is installed, but login is required.",
          ...(detail ? { detail } : {}),
          hint: loginMeta.loginUrl
            ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
            : "Run `claude login` in this environment, then retry the probe.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
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
      } else {
        // Surface the actual failure instead of the leading stream-json
        // `system/init` line: the real error lives in the final `result`
        // event (parsed) or, when the CLI dies before emitting one, the last
        // non-init stdout line — never the first one `summarizeProbeDetail`
        // returns.
        const stdoutFallback = lastNonInitStdoutLine(probe.stdout);
        const failureDetail =
          (parsed ? describeClaudeFailure(parsed) : null) ||
          (firstNonEmptyLine(probe.stderr)
            ? truncateDetail(firstNonEmptyLine(probe.stderr))
            : "") ||
          (stdoutFallback ? truncateDetail(stdoutFallback) : "") ||
          detail ||
          "";
        const transient = isClaudeTransientUpstreamError({
          parsed,
          stdout: probe.stdout,
          stderr: probe.stderr,
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

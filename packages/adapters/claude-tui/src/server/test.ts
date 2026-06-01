import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude-p");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `claude-tui-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetIsRemote) {
    checks.push({
      code: "claude_tui_environment_target",
      level: "info",
      message: `Probing inside environment: ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({ code: "claude_tui_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "claude_tui_cwd_invalid",
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
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "claude-p",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({ code: "claude_tui_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "claude_tui_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: `Install claude-p with \`${SANDBOX_INSTALL_COMMAND}\`. It also needs the \`claude\` CLI installed (it drives the real Claude Code TUI).`,
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "claude_tui_cwd_invalid" && check.code !== "claude_tui_command_unresolvable",
  );
  if (canRunProbe) {
    if (!commandLooksLike(command, "claude-p")) {
      checks.push({
        code: "claude_tui_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude-p`.",
        detail: command,
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = asString(config.effort, "").trim();
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json", "--verbose", "--timeout", "45"];
      if (dangerouslySkipPermissions) {
        args.push(
          ...(targetIsSandbox ? ["--allowedTools", "Read"] : ["--dangerously-skip-permissions"]),
        );
      }
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runAdapterExecutionTargetProcess(runId, target, command, args, {
        cwd,
        env,
        timeoutSec: 60,
        graceSec: 5,
        stdin: "Respond with hello.",
        onLog: async () => {},
      });

      const parsedStream = parseClaudeStreamJson(probe.stdout);
      const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);

      if (probe.timedOut) {
        checks.push({
          code: "claude_tui_hello_probe_timed_out",
          level: "warn",
          message: "claude-p hello probe timed out.",
          hint: "The PTY driver may be slow to boot. Retry; if it persists, verify `claude` runs interactively in this environment.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "claude_tui_hello_probe_passed" : "claude_tui_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "claude-p hello probe succeeded."
            : "claude-p ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } else {
        checks.push({
          code: "claude_tui_hello_probe_failed",
          level: "error",
          message: "claude-p hello probe failed.",
          ...(detail ? { detail: detail.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          hint: "Ensure both `claude-p` and `claude` are installed and `claude` is logged in (or ANTHROPIC_API_KEY is set).",
        });
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

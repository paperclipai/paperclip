import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "kimi").trim() || "kimi";
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `kimi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "kimi_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "kimi_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "kimi_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const cwdInvalid = checks.some((check) => check.code === "kimi_cwd_invalid");
  if (!cwdInvalid) {
    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, process.env as Record<string, string>);
      checks.push({
        code: "kimi_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "kimi_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  } else {
    checks.push({
      code: "kimi_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  }

  const canRunProbe = !cwdInvalid && checks.some((c) => c.code === "kimi_command_resolvable");

  if (canRunProbe) {
    const stdin = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: "envtest-1",
      params: {
        protocol_version: "1.9",
        client: { name: "paperclip", version: "0.1" },
      },
    }) + "\n";

    try {
      const probe = await runAdapterExecutionTargetProcess(runId, target, command, ["--wire"], {
        cwd,
        env: process.env as Record<string, string>,
        stdin,
        timeoutSec: 15,
        graceSec: 3,
        onLog: async () => {},
      });

      const firstLine = firstNonEmptyLine(probe.stdout);
      if (firstLine) {
        try {
          const msg = JSON.parse(firstLine);
          if (msg.result?.protocol_version) {
            checks.push({
              code: "kimi_wire_init_passed",
              level: "info",
              message: `Kimi Wire protocol initialized (version ${msg.result.protocol_version}).`,
            });
          } else if (msg.error) {
            checks.push({
              code: "kimi_wire_init_error",
              level: "warn",
              message: `Kimi Wire init returned error: ${msg.error.message}`,
              detail: firstLine,
            });
          }
        } catch {
          checks.push({
            code: "kimi_wire_output_unexpected",
            level: "warn",
            message: "Kimi Wire did not return JSON. Is the CLI version recent enough?",
            detail: firstLine.slice(0, 240),
          });
        }
      } else {
        checks.push({
          code: "kimi_wire_no_output",
          level: "warn",
          message: "Kimi Wire produced no output during init probe.",
        });
      }
    } catch (err) {
      checks.push({
        code: "kimi_wire_probe_failed",
        level: "error",
        message: err instanceof Error ? err.message : "Kimi Wire probe failed.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

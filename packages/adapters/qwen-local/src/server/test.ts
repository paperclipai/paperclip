import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
} from "@paperclipai/adapter-utils/execution-target";
import { type as adapterType, SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveQwenConfig, QwenAdapterConfigError } from "./runtime-config.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

// Phase 2 v0.1 environment probe. Verifies the qwen binary is reachable on the
// execution target and the agent config has the required vLLM fields. Does not
// yet make a live request to the vLLM endpoint — that comes in Phase 5.
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  try {
    const resolved = resolveQwenConfig(ctx.config ?? {});
    checks.push({
      code: "config_valid",
      level: "info",
      message: `Config resolved: model=${resolved.model}, baseUrl=${resolved.baseUrl}`,
    });
  } catch (err) {
    checks.push({
      code: "config_invalid",
      level: "error",
      message: err instanceof QwenAdapterConfigError ? err.message : String(err),
      hint: "Set baseUrl and apiKey in the agent config.",
    });
  }

  const target = ctx.executionTarget ?? null;
  try {
    await ensureAdapterExecutionTargetCommandResolvable("qwen", target, process.cwd(), process.env, {
      installCommand: SANDBOX_INSTALL_COMMAND,
    });
    checks.push({
      code: "qwen_command",
      level: "info",
      message: `qwen CLI resolvable on ${describeAdapterExecutionTarget(target)}`,
    });
  } catch (err) {
    checks.push({
      code: "qwen_command_missing",
      level: "error",
      message: `qwen CLI not found on ${describeAdapterExecutionTarget(target)}: ${(err as Error).message}`,
      hint: `Install with: ${SANDBOX_INSTALL_COMMAND}`,
    });
  }

  return {
    adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

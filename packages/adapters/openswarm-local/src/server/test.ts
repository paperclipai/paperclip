import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "openswarm");
  const flavor = config.flavor === "vrsen" ? "vrsen" : "unohee";
  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(
    target,
    asString(config.cwd, ""),
    process.cwd(),
  );

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  checks.push({
    code: "openswarm_flavor",
    level: "info",
    message: `Flavor: ${flavor}`,
    detail:
      flavor === "unohee"
        ? "unohee/OpenSwarm (npm @intrect/openswarm)"
        : "VRSEN/OpenSwarm (npm @vrsen/openswarm)",
  });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(
      command,
      target,
      cwd,
      runtimeEnv,
    );
    checks.push({
      code: "openswarm_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "openswarm_command_unresolvable",
      level: "error",
      message:
        err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: `Install with \`${flavor === "unohee" ? SANDBOX_INSTALL_COMMAND : "npm install -g @vrsen/openswarm"}\` or set adapterConfig.command to an absolute path.`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";
import { isMuseAuthError, parseMuseJsonl } from "./parse.js";
import { readCompanyMuseApiKey } from "./muse-home.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function clip(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(input))) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "muse");
  const target = ctx.executionTarget ?? null;
  const result = (): AdapterEnvironmentTestResult => ({
    adapterType: "muse_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  });


  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `muse-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env: {}, createIfMissing: true });
    checks.push({ code: "muse_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({ code: "muse_cwd_invalid", level: "error", message: err instanceof Error ? err.message : "Invalid working directory", detail: cwd });
  }

  const env: Record<string, string> = { ...normalizeEnv(config.env), MUSE_NO_AUTO_UPDATE: "1" };
  // Same credential precedence as execute: a bound key or managed connection
  // wins, then the company key from a sandbox device login, then host login.
  const boundKey = env.META_API_KEY?.trim() || process.env.META_API_KEY?.trim();
  if (!config.managedAiConnection && !boundKey && ctx.companyId) {
    const companyKey = await readCompanyMuseApiKey(process.env, ctx.companyId);
    if (companyKey) env.META_API_KEY = companyKey;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({ code: "muse_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "muse_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Muse Code: curl -fsSL https://api.meta.ai/muse-launcher.sh | bash",
    });
  }
  if (checks.some((c) => c.code === "muse_cwd_invalid" || c.code === "muse_command_unresolvable")) return result();

  const model = asString(config.model, DEFAULT_MUSE_LOCAL_MODEL).trim() || DEFAULT_MUSE_LOCAL_MODEL;
  const probe = await runAdapterExecutionTargetProcess(
    runId,
    target,
    command,
    [
      "exec", "--json", "--no-session-log", "--approval-mode", "never",
      "--model", model, "--reasoning-effort", "low", "--workspace", cwd,
      "Respond with exactly hello.",
    ],
    { cwd, env, timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 60)), graceSec: 5, onLog: async () => {} },
  );
  const parsed = parseMuseJsonl(probe.stdout);
  const detail = clip(parsed.reason ?? probe.stderr);
  if (probe.timedOut) {
    checks.push({
      code: "muse_hello_probe_timed_out",
      level: "warn",
      message: "Muse hello probe timed out.",
      hint: "Retry; if it persists run `muse exec \"say hello\"` manually.",
    });
  } else if ((probe.exitCode ?? 1) !== 0 || parsed.terminal !== "completed") {
    const auth = isMuseAuthError(`${parsed.reason ?? ""}\n${probe.stderr}`);
    checks.push({
      code: auth ? "muse_hello_probe_auth_required" : "muse_hello_probe_failed",
      level: auth ? "warn" : "error",
      message: auth ? "Muse Code is not authenticated." : "Muse hello probe failed.",
      ...(detail ? { detail } : {}),
      hint: auth ? "Run `muse login` on this host, or bind META_API_KEY in the agent env." : undefined,
    });
  } else if (/\bhello\b/i.test(parsed.summary)) {
    checks.push({ code: "muse_hello_probe_passed", level: "info", message: `Muse hello probe succeeded (${parsed.model ?? model}).` });
  } else {
    checks.push({
      code: "muse_hello_probe_unexpected_output",
      level: "warn",
      message: "Muse hello probe returned unexpected output.",
      ...(detail ? { detail } : {}),
    });
  }
  return result();
}

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_LM_STUDIO_BASE_URL } from "../index.js";
import { listLmStudioModels } from "./models.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): "pass" | "warn" | "fail" {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const cwd = asString(config.cwd, process.cwd());
  const baseUrl = asString(config.baseUrl, DEFAULT_LM_STUDIO_BASE_URL);

  // Check cwd
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({ code: "cwd_valid", level: "info", message: `Working directory: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "cwd_invalid",
      level: "error",
      message: `Invalid working directory "${cwd}"`,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Check codex command
  try {
    const runtimeEnv = ensurePathInEnv({ ...process.env });
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({ code: "command_ok", level: "info", message: `Codex command resolved: ${command}` });
  } catch (err) {
    checks.push({
      code: "command_missing",
      level: "error",
      message: `Cannot resolve command "${command}"`,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Check LM Studio connectivity
  try {
    const models = await listLmStudioModels(baseUrl);
    if (models.length > 0) {
      checks.push({
        code: "lm_studio_connected",
        level: "info",
        message: `LM Studio connected at ${baseUrl} — ${models.length} model(s) available`,
      });
    } else {
      checks.push({
        code: "lm_studio_no_models",
        level: "warn",
        message: `Connected to LM Studio at ${baseUrl} but no models found`,
        hint: "Load a model in LM Studio.",
      });
    }
  } catch {
    checks.push({
      code: "lm_studio_unreachable",
      level: "warn",
      message: `Cannot reach LM Studio at ${baseUrl}`,
      hint: "Ensure LM Studio is running with the API server enabled.",
    });
  }

  return {
    adapterType: "lm_studio_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

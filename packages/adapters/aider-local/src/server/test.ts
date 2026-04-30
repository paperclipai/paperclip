import path from "node:path";
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
import {
  DEFAULT_AIDER_LOCAL_MODEL,
  DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL,
} from "../index.js";
import { ensureAiderInstalled, ensureOllamaModelPulled } from "./prepare.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

async function probeOllamaReachable(baseUrl: string): Promise<{ ok: boolean; detail?: string; models?: string[] }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { ok: false, detail: `Ollama responded with HTTP ${res.status}` };
    }
    const body = (await res.json()) as OllamaTagsResponse;
    const names = (body.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null))
      .filter((s): s is string => s != null);
    return { ok: true, models: names };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

function modelTagFromAiderId(aiderModel: string): string | null {
  // Aider model ids for Ollama look like "ollama/llama3.1:8b". Strip the
  // provider prefix to get the bare ollama tag.
  const m = aiderModel.match(/^ollama\/(.+)$/);
  return m ? m[1] ?? null : null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "aider");
  const cwd = path.resolve(asString(config.cwd, process.cwd()));
  const model = asString(config.model, DEFAULT_AIDER_LOCAL_MODEL);
  const ollamaBaseUrl = asString(config.ollamaBaseUrl, DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL);

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "aider_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "aider_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { OLLAMA_API_BASE: ollamaBaseUrl };
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  // Test environment is also "Prepare environment". If anything is missing
  // we install/pull it before reporting status — Barry's feedback was that
  // good software should "just work" and not require users to know secret
  // setup commands. The prep helpers stream their progress through onLog,
  // which the Test Environment dialog tee's into a buffer that becomes the
  // check `detail`.
  let prepLog = "";
  const onLog = async (_stream: "stdout" | "stderr", chunk: string) => {
    prepLog += chunk;
  };

  try {
    await ensureAiderInstalled({ command, cwd, env: runtimeEnv, onLog });
    checks.push({
      code: "aider_command_resolvable",
      level: "info",
      message: `Aider CLI is on PATH: ${command}`,
      detail: prepLog.trim() ? prepLog.trim().slice(-2000) : null,
    });
  } catch (err) {
    checks.push({
      code: "aider_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Aider CLI is not executable",
      detail: prepLog.trim() ? prepLog.trim().slice(-2000) : command,
      hint: "Install Python 3.10+ from https://python.org if it isn't on PATH; otherwise run `pip install --user aider-chat` manually and retry.",
    });
    // Fall back to ensureCommandResolvable to keep the error consistent with
    // the older check code if prep failed for an upstream reason.
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
    } catch {
      /* already reported above */
    }
  }

  prepLog = "";
  const ollama = await probeOllamaReachable(ollamaBaseUrl);
  if (ollama.ok) {
    checks.push({
      code: "ollama_reachable",
      level: "info",
      message: `Ollama is reachable at ${ollamaBaseUrl}`,
      detail: ollama.models && ollama.models.length > 0
        ? `Models pulled: ${ollama.models.join(", ")}`
        : "No models are pulled yet.",
    });
    const tag = modelTagFromAiderId(model);
    if (tag && ollama.models && !ollama.models.some((name) => name === tag || name.startsWith(`${tag}@`))) {
      try {
        await ensureOllamaModelPulled({ aiderModel: model, ollamaBaseUrl, onLog });
        checks.push({
          code: "ollama_model_pulled",
          level: "info",
          message: `Pulled model "${tag}" successfully.`,
          detail: prepLog.trim() ? prepLog.trim().slice(-2000) : null,
        });
      } catch (err) {
        checks.push({
          code: "ollama_model_pull_failed",
          level: "warn",
          message: `Could not auto-pull "${tag}".`,
          detail: prepLog.trim() ? prepLog.trim().slice(-2000) : (err instanceof Error ? err.message : null),
          hint: `Run \`ollama pull ${tag}\` manually and retry.`,
        });
      }
    }
  } else {
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Cannot reach Ollama at ${ollamaBaseUrl}`,
      detail: ollama.detail ?? null,
      hint: "Start Ollama with `ollama serve` or update ollamaBaseUrl in adapter config.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

/**
 * Lightweight check used by the Adapters page sign-in/auth-status badge. Ollama
 * has no auth concept, so "logged in" means "reachable + at least one model
 * pulled". This is what the user actually cares about: whether the runtime is
 * usable right now.
 */
export async function readAiderAuthStatus(ollamaBaseUrl: string = DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL): Promise<{
  loggedIn: boolean;
  authMethod: string;
  modelsCount: number;
  baseUrl: string;
}> {
  const probe = await probeOllamaReachable(ollamaBaseUrl);
  return {
    loggedIn: probe.ok && (probe.models?.length ?? 0) > 0,
    authMethod: "Local Ollama",
    modelsCount: probe.models?.length ?? 0,
    baseUrl: ollamaBaseUrl,
  };
}

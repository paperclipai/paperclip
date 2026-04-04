import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim();

  checks.push({
    code: "ollama_base_url",
    level: "info",
    message: `Ollama base URL: ${baseUrl}`,
  });

  // Check 1: Is Ollama reachable?
  try {
    const versionRes = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (versionRes.ok) {
      const body = (await versionRes.json().catch(() => ({}))) as Record<string, unknown>;
      const version = typeof body.version === "string" ? ` v${body.version}` : "";
      checks.push({
        code: "ollama_reachable",
        level: "info",
        message: `Ollama is running${version} at ${baseUrl}`,
      });
    } else {
      checks.push({
        code: "ollama_unreachable",
        level: "error",
        message: `Ollama returned HTTP ${versionRes.status} at ${baseUrl}/api/version`,
        hint: "Ensure Ollama is running: ollama serve",
      });
      return {
        adapterType: ctx.adapterType,
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Cannot reach Ollama at ${baseUrl}: ${msg}`,
      hint: "Start Ollama with: ollama serve",
    });
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Check 2: Is the configured model available?
  try {
    const tagsRes = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (tagsRes.ok) {
      const body = (await tagsRes.json().catch(() => ({ models: [] }))) as Record<
        string,
        unknown
      >;
      const installed: string[] = Array.isArray(body.models)
        ? (body.models as Record<string, unknown>[])
            .filter((m) => typeof m.name === "string")
            .map((m) => (m.name as string).split(":")[0])
        : [];
      const modelBase = model.split(":")[0];
      const found =
        installed.includes(modelBase) || installed.some((m) => m.startsWith(modelBase));
      if (found) {
        checks.push({
          code: "ollama_model_available",
          level: "info",
          message: `Model "${model}" is available locally.`,
        });
      } else {
        checks.push({
          code: "ollama_model_missing",
          level: "warn",
          message: `Model "${model}" was not found in the local Ollama model list.`,
          detail:
            installed.length > 0
              ? `Installed models: ${installed.slice(0, 10).join(", ")}`
              : "No models installed.",
          hint: `Run: ollama pull ${model}`,
        });
      }
    } else {
      checks.push({
        code: "ollama_tags_unavailable",
        level: "warn",
        message: `Could not fetch model list from Ollama (HTTP ${tagsRes.status}).`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "ollama_tags_error",
      level: "warn",
      message: `Could not fetch Ollama model list: ${msg}`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

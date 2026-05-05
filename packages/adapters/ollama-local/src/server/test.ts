import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { fetchOllamaTags, isOllamaCloudHost, resolveOllamaApiKey, resolveOllamaHost } from "./models.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const host = resolveOllamaHost(asString(config.host, ""));
  const apiKey = resolveOllamaApiKey(asString(config.apiKey, ""));
  const wantedModel = asString(config.model, "").trim();
  const cloud = isOllamaCloudHost(host);

  const checks: AdapterEnvironmentCheck[] = [];

  if (cloud && !apiKey) {
    checks.push({
      code: "ollama_cloud_missing_api_key",
      level: "error",
      message: `Ollama Cloud host ${host} requires an API key.`,
      hint: "Set OLLAMA_API_KEY env var (from https://ollama.com/settings/keys) or the apiKey adapter field.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const tags = await fetchOllamaTags(host, { signal: controller.signal, apiKey });
    const installed = (tags.models ?? [])
      .map((m) => (m.name ?? m.model ?? "").trim())
      .filter((id) => id.length > 0);

    checks.push({
      code: "ollama_reachable",
      level: "info",
      message: `Reached Ollama at ${host}.`,
      detail: `Found ${installed.length} installed model${installed.length === 1 ? "" : "s"}.`,
    });

    if (wantedModel.length > 0 && !installed.includes(wantedModel)) {
      checks.push({
        code: "ollama_model_missing",
        level: "warn",
        message: `Configured model "${wantedModel}" is not installed on this Ollama host.`,
        hint: `Run: ollama pull ${wantedModel}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Could not reach Ollama at ${host}.`,
      detail: message,
      hint: "Start the daemon with `ollama serve`, or set the `host` adapter field / OLLAMA_HOST env var.",
    });
  } finally {
    clearTimeout(timeout);
  }

  return {
    adapterType: "ollama_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

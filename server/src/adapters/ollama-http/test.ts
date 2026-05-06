import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https:\/[^/]/i.test(trimmed)) return trimmed.replace(/^https:\//i, "https://");
  if (/^http:\/[^/]/i.test(trimmed)) return trimmed.replace(/^http:\//i, "http://");
  return trimmed;
}

function resolveHttpUrl(value: string): URL | null {
  try {
    const url = new URL(normalizeBaseUrl(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrlValue = asString(config.baseUrl, asString(config.url, ""));

  if (!baseUrlValue.trim()) {
    checks.push({
      code: "ollama_http_base_url_missing",
      level: "error",
      message: "Ollama HTTP adapter requires a base URL.",
      hint: "Set adapterConfig.baseUrl (or url) to your Ollama endpoint, for example https://host.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const baseUrl = resolveHttpUrl(baseUrlValue);
  if (!baseUrl) {
    checks.push({
      code: "ollama_http_base_url_invalid",
      level: "error",
      message: `Invalid Ollama base URL: ${baseUrlValue}`,
      hint: "Use an absolute http:// or https:// endpoint.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const tagsUrlValue = asString(config.tagsUrl, new URL("/api/tags", baseUrl).toString());
  const tagsUrl = resolveHttpUrl(tagsUrlValue);
  checks.push({
    code: "ollama_http_base_url_valid",
    level: "info",
    message: `Configured Ollama endpoint: ${baseUrl.toString()}`,
  });
  if (tagsUrl) {
    checks.push({
      code: "ollama_http_tags_url_valid",
      level: "info",
      message: `Model discovery endpoint: ${tagsUrl.toString()}`,
    });
  } else {
    checks.push({
      code: "ollama_http_tags_url_invalid",
      level: "warn",
      message: `Configured tagsUrl is invalid: ${tagsUrlValue}`,
    });
  }

  if (tagsUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(tagsUrl, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        checks.push({
          code: "ollama_http_tags_probe_unexpected_status",
          level: "warn",
          message: `Model discovery probe returned HTTP ${response.status}.`,
          hint: "Verify the Paperclip server can reach the Ollama /api/tags endpoint.",
        });
      } else {
        const payload = parseObject(await response.json().catch(() => null));
        const count = Array.isArray(payload.models) ? payload.models.length : 0;
        checks.push({
          code: "ollama_http_tags_probe_ok",
          level: "info",
          message: count > 0
            ? `Discovered ${count} Ollama model${count === 1 ? "" : "s"}.`
            : "Model discovery endpoint responded.",
        });
      }
    } catch (err) {
      checks.push({
        code: "ollama_http_tags_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Model discovery probe failed",
        hint: "This may be expected in restricted networks; verify connectivity when invoking runs.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
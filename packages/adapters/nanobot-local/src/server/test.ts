import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function isLoopbackHost(hostname: string): boolean {
  const v = hostname.trim().toLowerCase();
  return v === "localhost" || v === "127.0.0.1" || v === "::1";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "").trim().replace(/\/+$/, "");

  if (!urlValue) {
    checks.push({
      code: "nanobot_url_missing",
      level: "error",
      message: "Nanobot adapter requires a URL.",
      hint: "Set adapterConfig.url to the nanobot's Paperclip channel URL (e.g. http://localhost:9800).",
    });
    return { adapterType: ctx.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "nanobot_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
    return { adapterType: ctx.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "nanobot_url_protocol",
      level: "error",
      message: `Unsupported protocol: ${url.protocol} — use http:// or https://.`,
    });
    return { adapterType: ctx.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  checks.push({
    code: "nanobot_url_valid",
    level: "info",
    message: `Configured nanobot URL: ${url.toString()}`,
  });

  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    checks.push({
      code: "nanobot_plaintext_remote",
      level: "warn",
      message: "URL uses plaintext http:// on a non-loopback host.",
      hint: "Prefer https:// for remote nanobot instances.",
    });
  }

  const apiKey = asString(config.apiKey, "");
  if (apiKey) {
    checks.push({ code: "nanobot_auth_present", level: "info", message: "API key is configured." });
  } else {
    checks.push({
      code: "nanobot_auth_missing",
      level: "warn",
      message: "No API key configured.",
      hint: "Set adapterConfig.apiKey if the nanobot's Paperclip channel requires authentication.",
    });
  }

  // Probe /api/status
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${urlValue}/api/status`, { headers, signal: controller.signal });
      const text = await res.text();

      if (res.ok) {
        checks.push({
          code: "nanobot_probe_ok",
          level: "info",
          message: `Status probe succeeded: ${text.slice(0, 200)}`,
        });
      } else {
        checks.push({
          code: "nanobot_probe_http_error",
          level: "warn",
          message: `Status probe returned HTTP ${res.status}.`,
          hint: "Verify the nanobot is running with the Paperclip channel enabled.",
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "nanobot_probe_failed",
      level: "warn",
      message: `Could not reach nanobot: ${msg}`,
      hint: "Verify the nanobot is running and the URL is reachable from the Paperclip server.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

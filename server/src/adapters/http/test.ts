import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";
import { guardedHttpAdapterFetch } from "./remote-fetch.js";
import { validateHttpRunAttestationKey, RUN_ATTESTATION_HEADER } from "./run-attestation.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeMethod(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : "POST";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "");
  const method = normalizeMethod(asString(config.method, "POST"));
  const attest = config.runAttestation === true;

  if (config.runAttestation !== undefined && typeof config.runAttestation !== "boolean") {
    checks.push({ code: "http_run_attestation_invalid", level: "error", message: "runAttestation must be a boolean." });
  }

  if (!urlValue) {
    checks.push({
      code: "http_url_missing",
      level: "error",
      message: "HTTP adapter requires a URL.",
      hint: "Set adapterConfig.url to an absolute http(s) endpoint.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "http_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "http_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use an http:// or https:// endpoint.",
    });
  }

  if (url) {
    checks.push({
      code: "http_url_valid",
      level: "info",
      message: `Configured endpoint: ${url.toString()}`,
    });
  }

  checks.push({
    code: "http_method_configured",
    level: "info",
    message: `Configured method: ${method}`,
  });

  if (attest) {
    const headers = parseObject(config.headers);
    const payloadTemplate = parseObject(config.payloadTemplate);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.hash ||
        method !== "POST" || Object.keys(headers).length > 0 ||
        Object.keys(payloadTemplate).length > 0) {
      checks.push({
        code: "http_run_attestation_config_invalid",
        level: "error",
        message: "Attested runs require HTTPS, POST, no URL credentials or fragment, and no custom headers or payload template.",
      });
    }
    if (Object.keys(headers).some((key) => key.toLowerCase() === RUN_ATTESTATION_HEADER)) {
      checks.push({ code: "http_run_attestation_header_reserved", level: "error", message: "The run attestation header is reserved." });
    }
    try {
      validateHttpRunAttestationKey();
    } catch (error) {
      checks.push({
        code: "http_run_attestation_key_invalid",
        level: "error",
        message: error instanceof Error ? error.message : "Attestation key invalid.",
      });
    }
    checks.push({
      code: "http_run_attestation_probe_skipped",
      level: "info",
      message: "Authenticated endpoint was not probed; reachability is checked on invocation.",
    });
    return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
  }

  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await guardedHttpAdapterFetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 405 && response.status !== 501) {
        checks.push({
          code: "http_endpoint_probe_unexpected_status",
          level: "warn",
          message: `Endpoint probe returned HTTP ${response.status}.`,
          hint: "Verify the endpoint is reachable from the Paperclip server host.",
        });
      } else {
        checks.push({
          code: "http_endpoint_probe_ok",
          level: "info",
          message: "Endpoint responded to a HEAD probe.",
        });
      }
    } catch (err) {
      checks.push({
        code: "http_endpoint_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Endpoint probe failed",
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

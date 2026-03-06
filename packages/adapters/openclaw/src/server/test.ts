import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end).toLowerCase() : trimmed.toLowerCase();
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon > -1) return trimmed.slice(0, firstColon).toLowerCase();
  return trimmed.toLowerCase();
}

function pushDeploymentDiagnostics(
  checks: AdapterEnvironmentCheck[],
  ctx: AdapterEnvironmentTestContext,
  endpointUrl: URL | null,
) {
  const mode = ctx.deployment?.mode;
  const exposure = ctx.deployment?.exposure;
  const bindHost = normalizeHostname(ctx.deployment?.bindHost ?? null);
  const allowSet = new Set(
    (ctx.deployment?.allowedHostnames ?? [])
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
  const endpointHost = endpointUrl ? normalizeHostname(endpointUrl.hostname) : null;

  if (!mode) return;

  checks.push({
    code: "openclaw_deployment_context",
    level: "info",
    message: `Deployment context: mode=${mode}${exposure ? ` exposure=${exposure}` : ""}`,
  });

  if (mode === "authenticated" && exposure === "private") {
    if (bindHost && !isLoopbackHost(bindHost) && !allowSet.has(bindHost)) {
      checks.push({
        code: "openclaw_private_bind_hostname_not_allowed",
        level: "warn",
        message: `Paperclip bind host "${bindHost}" is not in allowed hostnames.`,
        hint: `Run pnpm paperclipai allowed-hostname ${bindHost} so remote OpenClaw callbacks can pass host checks.`,
      });
    }

    if (!bindHost || isLoopbackHost(bindHost)) {
      checks.push({
        code: "openclaw_private_bind_loopback",
        level: "warn",
        message: "Paperclip is bound to loopback in authenticated/private mode.",
        hint: "Bind to a reachable private hostname/IP so remote OpenClaw agents can call back.",
      });
    }

    if (endpointHost && !isLoopbackHost(endpointHost) && allowSet.size === 0) {
      checks.push({
        code: "openclaw_private_no_allowed_hostnames",
        level: "warn",
        message: "No explicit allowed hostnames are configured for authenticated/private mode.",
        hint: "Set one with pnpm paperclipai allowed-hostname <host> when OpenClaw runs on another machine.",
      });
    }
  }

  if (mode === "authenticated" && exposure === "public" && endpointUrl && endpointUrl.protocol !== "https:") {
    checks.push({
      code: "openclaw_public_http_endpoint",
      level: "warn",
      message: "OpenClaw endpoint uses HTTP in authenticated/public mode.",
      hint: "Prefer HTTPS for public deployments.",
    });
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "");

  if (!urlValue) {
    checks.push({
      code: "openclaw_url_missing",
      level: "error",
      message: "OpenClaw adapter requires a webhook URL.",
      hint: "Set adapterConfig.url to your OpenClaw webhook endpoint.",
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
      code: "openclaw_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "openclaw_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use an http:// or https:// endpoint.",
    });
  }

  if (url) {
    checks.push({
      code: "openclaw_url_valid",
      level: "info",
      message: `Configured endpoint: ${url.toString()}`,
    });

    if (isLoopbackHost(url.hostname)) {
      checks.push({
        code: "openclaw_loopback_endpoint",
        level: "warn",
        message: "Endpoint uses loopback hostname. Remote OpenClaw workers cannot reach localhost on the Paperclip host.",
        hint: "Use a reachable hostname/IP (for example Tailscale/private hostname or public domain).",
      });
    }
  }

  pushDeploymentDiagnostics(checks, ctx, url);

  const method = asString(config.method, "POST").trim().toUpperCase() || "POST";
  checks.push({
    code: "openclaw_method_configured",
    level: "info",
    message: `Configured method: ${method}`,
  });

  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, { method: "HEAD", signal: controller.signal });
      if (!response.ok && response.status !== 405 && response.status !== 501) {
        checks.push({
          code: "openclaw_endpoint_probe_unexpected_status",
          level: "warn",
          message: `Endpoint probe returned HTTP ${response.status}.`,
          hint: "Verify OpenClaw webhook reachability and auth/network settings.",
        });
      } else {
        checks.push({
          code: "openclaw_endpoint_probe_ok",
          level: "info",
          message: "Endpoint responded to a HEAD probe.",
        });
      }
    } catch (err) {
      checks.push({
        code: "openclaw_endpoint_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Endpoint probe failed",
        hint: "This may be expected in restricted networks; validate from the Paperclip server host.",
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

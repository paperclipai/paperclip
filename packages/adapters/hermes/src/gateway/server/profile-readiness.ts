import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

const NAMED_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function matchesNamedProfile(baseUrl: URL, profile: unknown): boolean {
  return typeof profile === "string" &&
    NAMED_PROFILE.test(profile) &&
    profile !== "default" &&
    profile !== "hermes" &&
    !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash &&
    baseUrl.pathname.replace(/\/+$/, "").endsWith(`/p/${profile}`);
}

function failure(code: string, message: string): AdapterEnvironmentCheck {
  return { level: "error", code: `hermes_gateway_${code}`, message };
}

export async function testNamedProfile(baseUrl: URL, apiKey: string): Promise<AdapterEnvironmentCheck> {
  const url = `${baseUrl.toString().replace(/\/+$/, "")}/health/detailed`;
  const options = {
    redirect: "error" as const,
    signal: AbortSignal.timeout(2_000),
  };

  try {
    const anonymous = await fetch(url, options);
    await anonymous.body?.cancel();
    if (anonymous.status === 404) {
      return failure("profile_not_served", "Hermes Gateway does not serve the expected named profile.");
    }
    if (anonymous.status !== 401) {
      return failure("profile_auth_unverified", "The named Hermes profile did not require authentication.");
    }

    const response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 401 || response.status === 403
        ? failure("profile_auth_failed", "Hermes Gateway rejected the saved credential.")
        : failure("profile_probe_failed", `Hermes Gateway readiness returned HTTP ${response.status}.`);
    }

    // Hermes validates the /p/<name> prefix against the runtime it can serve,
    // then authenticates that route. A model label or a public health response
    // cannot establish either property.
    const health = parseObject(await response.json());
    const readiness = parseObject(health.readiness);
    const queues = parseObject(parseObject(readiness.checks).background_queues);
    if (
      health.platform !== "hermes-agent" || health.status !== "ok" ||
      readiness.status !== "ok" || health.gateway_state !== "running" ||
      health.gateway_busy !== false || health.active_agents !== 0 ||
      queues.status !== "ok" || queues.active_api_runs !== 0 ||
      queues.active_delegations !== 0 || queues.process_completions !== 0
    ) {
      return failure("profile_not_ready", "The authenticated Hermes profile did not report a ready, idle gateway.");
    }

    return { level: "info", code: "hermes_gateway_profile_ready", message: "The named Hermes profile authenticated and is ready." };
  } catch {
    return failure("profile_probe_failed", "Could not verify the named Hermes profile readiness response.");
  }
}

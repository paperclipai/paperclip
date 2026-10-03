import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { redactDiagnosticText } from "@paperclipai/adapter-utils/command-redaction";
import { agentsApi } from "../api/agents";

/** ACP readiness checks do not authenticate a provider. Verify credentials with
 * the adapter's existing read-only CLI hello probe before calling setup connected. */
export async function testAgentSetup(input: {
  companyId: string;
  agentId?: string;
  adapterType: string;
  providerAdapter: string;
  adapterConfig: Record<string, unknown>;
  aiConnection?: import("@paperclipai/shared").AiConnectionBinding;
  testCredentials?: Record<string, string>;
  environmentId: string | null;
}): Promise<AdapterEnvironmentTestResult> {
  const payload = {
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.aiConnection ? { aiConnection: input.aiConnection } : {}),
    adapterConfig: input.adapterConfig,
    ...(input.testCredentials ? { testCredentials: input.testCredentials } : {}),
    environmentId: input.environmentId,
  };
  const runtime = await agentsApi.testEnvironment(
    input.companyId,
    input.adapterType,
    payload,
  );
  if (
    runtime.status === "fail" ||
    runtime.checks.some(
      (check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE,
    ) ||
    runtime.checks.some((check) => check.code.includes("hello_probe")) ||
    !["claude_local", "codex_local", "grok_local"].includes(input.providerAdapter)
  )
    return runtime;
  const provider = await agentsApi.testEnvironment(
    input.companyId,
    input.providerAdapter,
    {
      ...payload,
      adapterConfig: {
        ...input.adapterConfig,
        engine: "cli",
        ...(input.adapterType === "paperclip_runner" && input.providerAdapter === "grok_local"
          ? { command: "/opt/paperclip/providers/grok/1.0.13/grok" }
          : {}),
      },
    },
  );
  const checks = [
    ...new Map(
      [...runtime.checks, ...provider.checks].map((check) => [
        check.code,
        check,
      ]),
    ).values(),
  ];
  return {
    adapterType: input.adapterType,
    testedAt: provider.testedAt,
    status:
      provider.status === "fail"
        ? "fail"
        : runtime.status === "warn" || provider.status === "warn"
          ? "warn"
          : "pass",
    checks,
  };
}

const MAX_FAILURE_DETAIL_LENGTH = 300;

/** Probe details are often a provider's raw JSON error line; show only its message. */
function readableCheckDetail(detail: string): string {
  const trimmed = detail.trim();
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    const message =
      typeof parsed.error === "object" && typeof parsed.error?.message === "string"
        ? parsed.error.message
        : typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.message === "string"
            ? parsed.message
            : null;
    if (message?.trim()) return message.trim();
  } catch {
    // Not JSON; use the detail text as-is.
  }
  return trimmed;
}

/** Describe the failing setup check, including the provider's reason when the
 * adapter reported one, so the user knows what to fix. */
export function describeSetupFailure(
  checks: AdapterEnvironmentTestResult["checks"] | undefined,
): string | undefined {
  const check =
    checks?.find((candidate) => candidate.level === "error") ??
    checks?.find(
      (candidate) =>
        candidate.code.includes("hello_probe") && candidate.level === "warn",
    );
  if (!check) return undefined;
  // Probe details can echo provider stderr; redact before display and bound
  // the length after redaction.
  const detail = check.detail
    ? redactDiagnosticText(readableCheckDetail(check.detail))
    : "";
  if (!detail || detail === check.message) return check.message;
  const clipped =
    detail.length > MAX_FAILURE_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH)}…`
      : detail;
  return `${check.message} ${clipped}`;
}

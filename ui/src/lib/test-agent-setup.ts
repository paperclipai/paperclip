import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";

/** ACP readiness checks do not authenticate a provider. Verify credentials with
 * the adapter's existing read-only CLI hello probe before calling setup connected. */
export async function testAgentSetup(input: {
  companyId: string;
  adapterType: string;
  providerAdapter: string;
  adapterConfig: Record<string, unknown>;
  agentId?: string;
  testCredentials?: Record<string, string>;
  environmentId: string | null;
}): Promise<AdapterEnvironmentTestResult> {
  const payload = {
    adapterConfig: input.adapterConfig,
    ...(input.agentId ? { agentId: input.agentId } : {}),
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
    !["claude_local", "codex_local"].includes(input.providerAdapter)
  )
    return runtime;
  const provider = await agentsApi.testEnvironment(
    input.companyId,
    input.providerAdapter,
    {
      ...payload,
      adapterConfig: { ...input.adapterConfig, engine: "cli" },
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

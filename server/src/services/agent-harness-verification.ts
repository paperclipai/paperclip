import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import { isForbiddenConfigEnvKey, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { requireServerAdapter } from "../adapters/index.js";
import { agentEnvironmentTestService } from "./agent-environment-test.js";
import { aiConnectionRouterService } from "./ai-connection-router.js";
import { aiConnectionService } from "./ai-connections.js";
import { withManagedAiProbe, stripAiAuthBindings } from "./ai-connection-runtime.js";
import { PLUGIN_RUNNER_AI_CONNECTION_REQUIRED, pluginEnvironmentRunnerTaskDriver, pluginRunnerAiConnectionRequiredFailure } from "./plugin-runner-ai-connection.js";
import { environmentService } from "./environments.js";
import { secretService } from "./secrets.js";
import { instanceSettingsService } from "./instance-settings.js";
import { assertProviderApiPlacementPolicy, resolveProviderApiPlacement } from "./native-runtime/provider-api-placement.js";
import { museRunnerBroker } from "./muse-runner-broker.js";
import { RUNNER_REVISION_MISMATCH_CODE } from "./runner-revision-mismatch.js";
import { dotRunnerBroker } from "./dot-runner-broker.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { LifecycleAgent } from "../modules/agent-lifecycle/index.js";
import { canonicalizeEffectiveRunConfigCategory } from "./effective-run-config-fingerprints.js";
import { sandboxBinding } from "./environment-probe.js";
import type { RuntimeSecretManifestEntry } from "./secrets.js";
import { serverVersion } from "../version.js";

/**
 * Digest of what a passed harness test proves: the agent's effective
 * configuration (secret references by version, never by value), its AI
 * binding and environment, and the runner image it ran in. Null when the
 * runner image has no immutable identity, so such a pass is never reused.
 */
export function harnessVerificationDigest(input: {
  adapterType: string; config: Record<string, unknown>; binding: unknown; environmentId: string | null;
  secretManifest: readonly RuntimeSecretManifestEntry[]; runner: Record<string, unknown> | null;
}): string | null {
  if (!input.runner) return null;
  const effective = canonicalizeEffectiveRunConfigCategory({ category: "session",
    value: { adapterType: input.adapterType, config: input.config, binding: input.binding ?? null, environmentId: input.environmentId },
    secretManifest: input.secretManifest });
  const canonical = JSON.stringify({ v: 1, effective, runner: input.runner }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : value);
  return `v1:sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertHarnessTestPassed(result: AdapterEnvironmentTestResult) {
  const verified = result.checks.some(check => check.level === "info" &&
    (/hello_probe_(passed|succeeded)$/.test(check.code) || check.code === "ai_connection_api_key_reverified" || check.code === "copilot_metadata_verified"
      || (result.adapterType === "paperclip_runner" && check.code === "cursor_cloud_account_ready")));
  const authenticationFailed = result.checks.some(check =>
    check.code === ADAPTER_AUTH_MISSING_CHECK_CODE || check.code === "COPILOT_AUTH_REQUIRED" || /_hello_probe_auth_required$/.test(check.code));
  const incomplete = !verified && (result.status === "warn" || result.checks.some(check => check.code.includes("hello_probe")));
  if (result.status === "fail" || authenticationFailed || incomplete) {
    const has = (suffix: string) => result.checks.some(check => check.code.endsWith(suffix));
    const code = result.checks.some(check => check.code === PLUGIN_RUNNER_AI_CONNECTION_REQUIRED) ? PLUGIN_RUNNER_AI_CONNECTION_REQUIRED
      : result.checks.some(check => check.code === RUNNER_REVISION_MISMATCH_CODE) ? RUNNER_REVISION_MISMATCH_CODE
      : result.checks.some(check => check.level === "error" && check.retryable === true) ? "test_environment_unavailable"
      : authenticationFailed ? "harness_auth_failed"
      : has("_hello_probe_model_unavailable") || has("_model_invalid") ? "harness_model_unavailable"
      : has("_command_unresolvable") ? "harness_command_unavailable"
      : has("_cwd_invalid") ? "harness_cwd_invalid"
      : has("_hello_probe_timed_out") ? "harness_probe_timed_out"
      : has("_hello_probe_unexpected_output") ? "harness_probe_unexpected_output"
      : "harness_test_failed";
    throw Object.assign(new Error("The harness test failed"), { code });
  }
}

export function agentHarnessVerificationService(db: Db, manager: PluginWorkerManager) {
  const tests = agentEnvironmentTestService(db, manager);
  const secrets = secretService(db);
  const environments = environmentService(db);
  async function verify(snapshot: LifecycleAgent): Promise<"complete" | "pending" | "waiting"> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, snapshot.id), eq(agents.lifecycleVersion, snapshot.lifecycleVersion)));
    if (!agent) return "pending";
    if (agent.adapterType === "paperclip_runner" && ["openai_dot", "grok_bot"].includes(String(agent.adapterConfig.provider))) {
      const binding = await dotRunnerBroker(db).bindingForAgent(agent.companyId, agent.id);
      return binding?.status === "ready" && binding.wakeVerified && binding.id === agent.adapterConfig[agent.adapterConfig.provider === "grok_bot" ? "externalBindingId" : "dotBindingId"] ? "complete" : "pending";
    }
    if (agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "muse") {
      const binding = await museRunnerBroker(db).bindingForAgent(agent.companyId,agent.id);
      // A successful read of these external facts has no retry deadline. The
      // real confirmation/configuration producer rechecks this phase durably.
      return binding?.status === "ready" && binding.paired && binding.receiverDetected && binding.backgroundReplyVerified && binding.id === agent.adapterConfig.museBindingId ? "complete" : "waiting";
    }
    const providerApi = resolveProviderApiPlacement({ agent });
    if (providerApi) assertProviderApiPlacementPolicy(await instanceSettingsService(db).getGeneral());
    const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
    const responsibleUserId = agent.lifecycleOperation?.responsibleUserId ?? company.defaultResponsibleUserId;
    const context = { consumerType: "agent" as const, consumerId: agent.id, actorType: "system" as const,
      actorId: "agent-lifecycle", responsibleUserId };
    let binding = agent.runtimeConfig.aiConnection ? aiRuntimeConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
    let config = agent.adapterConfig;
    if (binding?.mode === "router") {
      const selected = await aiConnectionRouterService(db, manager).resolve({ companyId: agent.companyId,
        poolId: binding.connectionId, agentId: agent.id, userId: responsibleUserId,
        adapterType: agent.adapterType, taskKey: `lifecycle:${agent.lifecycleOperation!.id}` });
      binding = selected.binding;
      config = { ...config, ...selected.runtimeConfig };
    }
    if (binding) config = { ...config, env: stripAiAuthBindings(config.env) };
    const resolvedConfig = await secrets.resolveAdapterConfigForRuntime(agent.companyId, config, context, { adapterType: agent.adapterType });
    config = resolvedConfig.config;
    const secretManifest: RuntimeSecretManifestEntry[] = [...(resolvedConfig.manifest ?? [])];
    let runner: Record<string, unknown> | null = providerApi ? { kind: "provider_api" } : { kind: "local", version: serverVersion };
    const environmentId = providerApi ? null : await tests.resolveAdapterTestEnvironmentId(agent.companyId, agent.defaultEnvironmentId, agent.adapterType === "paperclip_runner" && config.provider === "acpx" && config.acpxAgent === "copilot");
    if (environmentId) {
      await tests.assertAdapterTestEnvironmentForCompany(agent.companyId, environmentId, agent.adapterType);
      const environment = await environments.getById(environmentId);
      if (environment && environment.driver !== "local") {
        const image = environment.driver === "sandbox" ? await sandboxBinding(db, environment, agent.companyId).catch(() => null) : null;
        runner = image ? { kind: "sandbox", environmentId, ...image } : null;
      }
      // Run admission refuses these agents before any lease, so verification must too.
      const preconfiguredHome = agent.adapterType === "paperclip_runner" && config.homeMode === "preconfigured";
      if (agent.adapterType === "paperclip_runner" && environment && (preconfiguredHome || !binding)
        && await pluginEnvironmentRunnerTaskDriver(db, environment)) throw pluginRunnerAiConnectionRequiredFailure(preconfiguredHome);
      const env = Object.fromEntries(Object.entries(binding ? stripAiAuthBindings(environment?.envVars) : parseObject(environment?.envVars))
        .filter(([key]) => !isForbiddenConfigEnvKey(key)));
      const resolved = await secrets.resolveEnvBindings(agent.companyId, env,
        { ...context, consumerType: "environment", consumerId: environmentId });
      config = { ...config, env: { ...resolved.env, ...parseObject(config.env) } };
      secretManifest.push(...(resolved.manifest ?? []));
    }
    if (binding) await aiConnectionService(db).select({
      companyId: agent.companyId, userId: responsibleUserId, agentId: agent.id,
      adapterType: agent.adapterType, model: config.model, runnerProvider: config.provider,
      acpxAgent: config.acpxAgent, binding,
    });
    // A configuration that already passed in this runner image is verified:
    // a restart or a return to verifying never boots another test sandbox.
    const digest = harnessVerificationDigest({ adapterType: agent.adapterType, config, binding: binding ?? null,
      environmentId, secretManifest, runner });
    if (digest && agent.harnessVerifiedDigest === digest) return "complete";
    const target = providerApi
      ? { executionTarget: null, environmentName: null, fallbackChecks: [], release: async (_status?: "released" | "failed") => {} }
      : await tests.resolveAdapterTestExecutionContext({ agentId: agent.id, companyId: agent.companyId, adapterType: agent.adapterType, environmentId });
    let status: "released" | "failed" = "failed";
    try {
      if (target.fallbackChecks.length) throw Object.assign(new Error("The test environment is unavailable"), { code: "test_environment_unavailable" });
      const input = { companyId: agent.companyId, adapterType: agent.adapterType, config,
        executionTarget: target.executionTarget, environmentName: target.environmentName };
      const result = binding ? await withManagedAiProbe(db, { ...input, agentId: agent.id, responsibleUserId, binding },
        managed => tests.testManagedEnvironment(agent.adapterType, { ...input, config: managed.config }, binding!, managed, agent.id))
        : await requireServerAdapter(agent.adapterType).testEnvironment(input);
      assertHarnessTestPassed(result);
      status = "released";
      // Record the pass before the lifecycle step completes, so a restart in
      // between reuses it instead of testing again.
      if (digest) await db.update(agents).set({ harnessVerifiedDigest: digest, harnessVerifiedAt: new Date() })
        .where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, snapshot.lifecycleVersion)));
      return "complete";
    } finally { await target.release(status); }
  }
  return { verify };
}

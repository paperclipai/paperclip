import { connectionIntentService } from "./connection-intents.js";
import { readAiConnectionConfigurationFailure } from "./ai-connection-configuration-failure.js";
import { logger } from "../middleware/logger.js";
import { createHmac } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, companies, companySecrets, type Db } from "@paperclipai/db";
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
import { resolveDecisionSigningSecret } from "./decision-signing.js";
import { sandboxBinding } from "./environment-probe.js";
import { serverVersion } from "../version.js";

/**
 * Digest of what a passed harness test proves: the agent's fully resolved
 * effective configuration (every value the test used, including cwd and
 * resolved credentials), the AI account and credential generation it selected,
 * its environment, and the runner image it ran in. Keyed with the instance's
 * signing secret, so the stored value never verifies a guessed credential
 * offline. Null when the runner image has no immutable identity: such a pass
 * is never reused.
 */
export function harnessVerificationDigest(input: {
  adapterType: string; config: Record<string, unknown>; account: unknown; environmentId: string | null;
  runner: Record<string, unknown> | null;
}): string | null {
  if (!input.runner) return null;
  const canonical = JSON.stringify({ v: 2, adapterType: input.adapterType, config: input.config, account: input.account ?? null,
    environmentId: input.environmentId, runner: input.runner }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : value);
  return `v2:hmac-sha256:${createHmac("sha256", resolveDecisionSigningSecret()).update("harness-verification-v2:").update(canonical).digest("hex")}`;
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
    config = (await secrets.resolveAdapterConfigForRuntime(agent.companyId, config, context, { adapterType: agent.adapterType })).config;
    let runner: Record<string, unknown> | null = providerApi ? { kind: "provider_api" } : { kind: "local", version: serverVersion };
    const environmentId = providerApi ? null : await tests.resolveAdapterTestEnvironmentId(agent.companyId, agent.defaultEnvironmentId, agent.adapterType === "paperclip_runner" && config.provider === "acpx" && config.acpxAgent === "copilot");
    if (environmentId) {
      await tests.assertAdapterTestEnvironmentForCompany(agent.companyId, environmentId, agent.adapterType);
      const environment = await environments.getById(environmentId);
      if (environment && environment.driver !== "local") {
        const image = environment.driver === "sandbox" ? await sandboxBinding(db, environment, agent.companyId).catch(() => null) : null;
        // Only an immutable image digest names the image a test ran in; a snapshot
        // name may be re-pointed without the allocation pinning it, so it never counts.
        const immutable = image && "image" in image;
        runner = immutable ? { kind: "sandbox", environmentId, ...image } : null;
      } else if (environment && (await instanceSettingsService(db).getExperimental()).enableManagedSandboxOnly === true) {
        // The test runs in the managed sandbox instead, whose image is not named here.
        runner = null;
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
    }
    const selectAccount = () => aiConnectionService(db).select({
      companyId: agent.companyId, userId: responsibleUserId, agentId: agent.id,
      adapterType: agent.adapterType, model: config.model, runnerProvider: config.provider,
      acpxAgent: config.acpxAgent, binding: binding!,
    });
    const selected = binding ? await selectAccount() : null;
    // The account and credential generation the binding selected, never the
    // credential: the selected connection and grant, and the current version
    // (and AI session epoch) of every secret its credential reads. Timestamps
    // that change on every use are left out, so a pass stays reusable.
    const connection = selected?.connection;
    const credentialRefs = [...(connection?.credentialSecretRefs ?? []), ...(selected?.grant?.credentialSecretRefs ?? [])];
    const credentialSecretIds = [...new Set(credentialRefs.map(ref => ref.secretId))];
    const readCredentialVersions = async () => credentialSecretIds.length ? await db.select({ id: companySecrets.id,
      latestVersion: companySecrets.latestVersion, aiSessionEpoch: companySecrets.aiSessionEpoch })
      .from(companySecrets).where(and(eq(companySecrets.companyId, agent.companyId), inArray(companySecrets.id, credentialSecretIds)))
      .then(rows => rows.sort((a, b) => a.id.localeCompare(b.id))) : [];
    const accountWith = (credentialVersions: Awaited<ReturnType<typeof readCredentialVersions>>) => selected ? { ...selected.attribution,
      credentialSecretRefs: credentialRefs, externalCredential: connection?.externalCredential ?? null,
      credentialVersions } : null;
    const credentialVersions = await readCredentialVersions();
    // A configuration that already passed in this runner image is verified:
    // a restart or a return to verifying never boots another test sandbox.
    // A local probe without a managed AI connection can use the host's own
    // credentials (environment variables, a CLI login) that no saved
    // configuration names, so such a pass is never reused.
    if (runner?.kind === "local" && !binding) runner = null;
    const digest = harnessVerificationDigest({ adapterType: agent.adapterType, config, account: accountWith(credentialVersions), environmentId, runner });
    if (digest && agent.harnessVerifiedDigest === digest) return "complete";
    const target = providerApi
      ? { executionTarget: null, environmentName: null, fallbackChecks: [], release: async (_status?: "released" | "failed") => {} }
      : await tests.resolveAdapterTestExecutionContext({ agentId: agent.id, companyId: agent.companyId, adapterType: agent.adapterType, environmentId });
    let status: "released" | "failed" = "failed";
    // A holder, so the account the probe callback records survives control-flow narrowing.
    const probed: { account: { connectionId: string; grantId: string } | null } = { account: null };
    try {
      if (target.fallbackChecks.length) throw Object.assign(new Error("The test environment is unavailable"), { code: "test_environment_unavailable" });
      const input = { companyId: agent.companyId, adapterType: agent.adapterType, config,
        executionTarget: target.executionTarget, environmentName: target.environmentName };
      const result = binding ? await withManagedAiProbe(db, { ...input, agentId: agent.id, responsibleUserId, binding },
        managed => {
          // The account this probe actually uses; the recorded digest must describe it.
          probed.account = { connectionId: managed.attribution.connectionId, grantId: managed.attribution.grantId };
          return tests.testManagedEnvironment(agent.adapterType, { ...input, config: managed.config }, binding!, managed, agent.id);
        })
        : await requireServerAdapter(agent.adapterType).testEnvironment(input);
      assertHarnessTestPassed(result);
      status = "released";
      // A passing subscription probe can save the credential it refreshed, which
      // advances the version but keeps the AI session epoch; a person's rotation
      // bumps the epoch. Record the generation the probe left, unless any epoch
      // moved: then the pass is not recorded and the next check tests again.
      const verifiedVersions = await readCredentialVersions();
      const sameEpochs = verifiedVersions.length === credentialVersions.length && verifiedVersions.every((row, index) =>
        row.id === credentialVersions[index]!.id && row.aiSessionEpoch === credentialVersions[index]!.aiSessionEpoch);
      // The managed probe selects the account again when it starts. Record the
      // pass only for the account it actually tested.
      const sameAccount = !selected || (probed.account?.connectionId === selected.attribution.connectionId
        && probed.account?.grantId === selected.attribution.grantId);
      const verifiedDigest = digest && sameEpochs && sameAccount
        ? harnessVerificationDigest({ adapterType: agent.adapterType, config, account: accountWith(verifiedVersions), environmentId, runner })
        : null;
      // Record the pass before the lifecycle step completes, so a restart in
      // between reuses it instead of testing again.
      if (verifiedDigest) await db.update(agents).set({ harnessVerifiedDigest: verifiedDigest, harnessVerifiedAt: new Date() })
        .where(and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, snapshot.lifecycleVersion)));
      return "complete";
    } finally { await target.release(status); }
  }
  return { async verify(snapshot: LifecycleAgent) {
    try { return await verify(snapshot); }
    catch (error) {
      if (readAiConnectionConfigurationFailure(error)) await connectionIntentService(db)
        .requestForQueuedAgentSetup(snapshot.companyId, snapshot.id)
        .catch(() => logger.warn({ agentId: snapshot.id }, "Could not attach queued agent setup connection request"));
      throw error;
    }
  } };
}

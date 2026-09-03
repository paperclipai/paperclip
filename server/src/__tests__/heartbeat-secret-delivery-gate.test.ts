import { describe, expect, it, vi } from "vitest";
import {
  ConfigurationIncompleteFailure,
  resolveExecutionRunAdapterConfig,
} from "../services/heartbeat.ts";
import { LOW_TRUST_REVIEW_PRESET } from "../services/trust-preset-resolver.ts";

/**
 * BRO-2367 — a grant is not proof of delivery.
 *
 * An agent can hold an `env.<KEY>` secret binding and still start a run without
 * that key, because the binding row and the adapter config can drift apart. The
 * run then dies inside the agent with an opaque provider error ("OpenAI API key
 * is missing"), which is recorded as `adapter_failed` — a configuration fault
 * wearing a runtime fault's clothes. The gate below turns that silent absence
 * into a named, pre-dispatch configuration failure.
 */
describe("resolveExecutionRunAdapterConfig delivery gate", () => {
  const undeliveredBinding = (envKey: string, consumerId: string, consumerType = "agent") => ({
    consumerType,
    consumerId,
    configPath: `env.${envKey}`,
    envKey,
    bindingType: "secret_ref" as const,
    secretId: "secret-1",
    secretName: envKey,
    errorCode: "binding_not_delivered" as const,
  });

  const passThroughSecretsSvc = (env: Record<string, string>) => ({
    resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({
      config: { env },
      secretKeys: new Set<string>(),
      manifest: [],
    }),
    resolveEnvBindings: vi.fn().mockResolvedValue({
      env: {},
      secretKeys: new Set<string>(),
      manifest: [],
    }),
  });

  it("fails the run when a declared env binding never reaches the run environment", async () => {
    const collectUndeliveredEnvBindings = vi
      .fn()
      .mockResolvedValue([undeliveredBinding("OPENAI_API_KEY", "agent-1")]);

    const call = resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      secretsSvc: {
        ...passThroughSecretsSvc({}),
        collectUndeliveredEnvBindings,
      } as any,
    });

    await expect(call).rejects.toBeInstanceOf(ConfigurationIncompleteFailure);
    await call.catch((err: ConfigurationIncompleteFailure) => {
      expect(err.message).toContain("OPENAI_API_KEY did not reach the run environment");
      expect(err.resultJson).toMatchObject({
        configurationIncomplete: {
          reason: "secret_binding_not_delivered",
          agentId: "agent-1",
          missingBindings: [expect.objectContaining({ configPath: "env.OPENAI_API_KEY" })],
        },
      });
    });

    expect(collectUndeliveredEnvBindings).toHaveBeenCalledWith(
      "company-1",
      { consumerType: "agent", consumerId: "agent-1" },
      [],
      { allowedBindingIds: null },
    );
  });

  it("never puts a secret value in the failure it raises", async () => {
    const call = resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: { UNRELATED: "sk-live-do-not-log" } },
      secretsSvc: {
        ...passThroughSecretsSvc({ UNRELATED: "sk-live-do-not-log" }),
        collectUndeliveredEnvBindings: vi
          .fn()
          .mockResolvedValue([undeliveredBinding("OPENAI_API_KEY", "agent-1")]),
      } as any,
    });

    await expect(call).rejects.toThrow(ConfigurationIncompleteFailure);
    await call.catch((err: ConfigurationIncompleteFailure) => {
      const serialized = `${err.message}${JSON.stringify(err.resultJson)}`;
      expect(serialized).not.toContain("sk-live-do-not-log");
      expect(serialized).toContain("OPENAI_API_KEY");
    });
  });

  it("passes the fully resolved env keys so a plain value at the same key counts as delivered", async () => {
    const collectUndeliveredEnvBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: { OPENAI_API_KEY: "resolved" } },
      secretsSvc: {
        ...passThroughSecretsSvc({ OPENAI_API_KEY: "resolved" }),
        collectUndeliveredEnvBindings,
      } as any,
    });

    expect(collectUndeliveredEnvBindings).toHaveBeenCalledWith(
      "company-1",
      { consumerType: "agent", consumerId: "agent-1" },
      ["OPENAI_API_KEY"],
      { allowedBindingIds: null },
    );
    expect(result.resolvedConfig.env).toMatchObject({ OPENAI_API_KEY: "resolved" });
  });

  /**
   * A low-trust run is deliberately narrowed to `allowedSecretBindingIds`. A
   * binding outside that boundary is one the run must NOT receive — resolution
   * rejects it as `binding_not_allowed` when the config declares it. If the gate
   * demanded delivery of it anyway, a run that is correctly withholding the
   * credential would abort as `configuration_incomplete`.
   */
  it("carries the low-trust boundary into the gate so a forbidden binding is not required", async () => {
    const collectUndeliveredEnvBindings = vi.fn().mockResolvedValue([]);

    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: {} },
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["binding-1"],
        },
        sourcePresets: {},
      } as any,
      secretsSvc: {
        ...passThroughSecretsSvc({}),
        collectUndeliveredEnvBindings,
      } as any,
    });

    expect(collectUndeliveredEnvBindings).toHaveBeenCalledWith(
      "company-1",
      { consumerType: "agent", consumerId: "agent-1" },
      [],
      { allowedBindingIds: ["binding-1"] },
    );
  });

  it("checks every consumer scope that contributed env to the run", async () => {
    const collectUndeliveredEnvBindings = vi.fn().mockResolvedValue([]);

    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: "project-1",
      environmentId: "environment-1",
      routineId: "routine-1",
      executionRunConfig: { env: {} },
      secretsSvc: {
        ...passThroughSecretsSvc({}),
        collectUndeliveredEnvBindings,
      } as any,
    });

    expect(collectUndeliveredEnvBindings.mock.calls.map((call) => call[1])).toEqual([
      { consumerType: "agent", consumerId: "agent-1" },
      { consumerType: "project", consumerId: "project-1" },
      { consumerType: "environment", consumerId: "environment-1" },
      { consumerType: "routine", consumerId: "routine-1" },
    ]);
  });

  it("skips the gate when the secrets service does not implement it", async () => {
    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        executionRunConfig: { env: {} },
        secretsSvc: passThroughSecretsSvc({}) as any,
      }),
    ).resolves.toMatchObject({ resolvedConfig: { env: {} } });
  });
});

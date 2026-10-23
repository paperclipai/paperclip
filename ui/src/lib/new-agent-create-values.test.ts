// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "../components/agent-config-defaults";
import {
  buildNewAgentDefaultCreateValues,
  createValuesForAdapterType,
  NEW_AGENT_RUNNER_PROVIDERS,
  resolveNewAgentDefaultAdapterType,
  resolveNewAgentDefaultRunnerProvider,
} from "./new-agent-create-values";

describe("new agent create values", () => {
  it("inherits the CEO adapter type when no explicit preset is provided", () => {
    expect(
      resolveNewAgentDefaultAdapterType({
        companyAgents: [
          { role: "ceo", adapterType: "pi_local" },
          { role: "engineer", adapterType: "codex_local" },
        ],
      }),
    ).toBe("pi_local");
  });

  it("prefers an explicit preset adapter type over the CEO adapter type", () => {
    expect(
      resolveNewAgentDefaultAdapterType({
        companyAgents: [{ role: "ceo", adapterType: "pi_local" }],
        presetAdapterType: "codex_local",
      }),
    ).toBe("codex_local");
  });

  it("falls back to the global default when no CEO adapter is available", () => {
    expect(resolveNewAgentDefaultAdapterType()).toBe(defaultCreateValues.adapterType);
  });

  it("builds pi-local create values without codex-specific defaults", () => {
    const values = createValuesForAdapterType("pi_local");
    expect(values.adapterType).toBe("pi_local");
    expect(values.model).toBe("");
    expect(values.dangerouslyBypassSandbox).toBe(defaultCreateValues.dangerouslyBypassSandbox);
  });

  it("builds new-agent defaults from the CEO adapter type", () => {
    const values = buildNewAgentDefaultCreateValues({
      companyAgents: [{ role: "ceo", adapterType: "pi_local" }],
    });
    expect(values.adapterType).toBe("pi_local");
  });
});

describe("new agent default runner provider", () => {
  const allowedProviders = NEW_AGENT_RUNNER_PROVIDERS.map(option => option.value);

  it("inherits a Grok harness from a paperclip_runner CEO", () => {
    expect(
      resolveNewAgentDefaultRunnerProvider({
        companyAgents: [
          { role: "ceo", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "grok" } },
        ],
        allowedProviders,
      }),
    ).toBe("grok");
  });

  it("inherits an OpenCode harness from a paperclip_runner CEO", () => {
    expect(
      resolveNewAgentDefaultRunnerProvider({
        companyAgents: [
          { role: "ceo", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } },
        ],
        allowedProviders,
      }),
    ).toBe("opencode");
  });

  it("falls back to the first offered harness when the CEO provider is not offered", () => {
    expect(
      resolveNewAgentDefaultRunnerProvider({
        companyAgents: [
          { role: "ceo", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } },
        ],
        allowedProviders,
      }),
    ).toBe(allowedProviders[0]);
  });

  it("falls back to the first offered harness when the CEO has no adapter config", () => {
    expect(
      resolveNewAgentDefaultRunnerProvider({
        companyAgents: [{ role: "ceo", adapterType: "paperclip_runner" }],
        allowedProviders,
      }),
    ).toBe(allowedProviders[0]);
    expect(resolveNewAgentDefaultRunnerProvider()).toBe(allowedProviders[0]);
  });

  it("prefers an explicit preset harness over the CEO harness", () => {
    expect(
      resolveNewAgentDefaultRunnerProvider({
        companyAgents: [
          { role: "ceo", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } },
        ],
        presetRunnerProvider: "grok",
        allowedProviders,
      }),
    ).toBe("grok");
  });
});

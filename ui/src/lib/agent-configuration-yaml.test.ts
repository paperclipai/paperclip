import { describe, expect, it } from "vitest";
import { appearanceForPalette, type AgentConfigurationSource } from "@paperclipai/shared";
import { agentConfigurationPatch, parseAgentConfigurationYaml, serializeAgentConfiguration } from "./agent-configuration-yaml";

export const configuration: AgentConfigurationSource = {
  id: "11111111-1111-4111-8111-111111111111", name: "Codie", role: "engineer", title: null,
  icon: null, appearance: appearanceForPalette("bubblegum-sky"), reportsTo: null,
  capabilities: "Write code\nReview changes\n", adapterType: "codex_local",
  adapterConfig: { model: "gpt-5", env: { API_KEY: { type: "plain", value: "***REDACTED***" } }, extra: { enabled: true } },
  runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600 }, custom: { nested: [1, "on", false] } },
  defaultEnvironmentId: null, budgetMonthlyCents: 12000, metadata: null,
};

describe("agent configuration YAML", () => {
  it("round trips the full configuration, multiline text, redactions and adapter extensions", () => {
    const text = serializeAgentConfiguration(configuration);
    expect(text).toContain("apiVersion: paperclip/v1");
    expect(text).toContain("capabilities: |");
    expect(agentConfigurationPatch(parseAgentConfigurationYaml(text), configuration)).toEqual({});
  });

  it("sends only changed fields and replaces the adapter map when a key is removed", () => {
    const doc = parseAgentConfigurationYaml(serializeAgentConfiguration(configuration));
    delete doc.spec.adapterConfig.extra;
    doc.spec.budgetMonthlyCents = 20000;
    expect(agentConfigurationPatch(doc, configuration)).toEqual({
      adapterConfig: { model: "gpt-5", env: configuration.adapterConfig.env },
      replaceAdapterConfig: true, budgetMonthlyCents: 20000,
    });
  });

  it("treats formatting, comments and reordered maps as a no-op", () => {
    const text = serializeAgentConfiguration({ ...configuration, adapterConfig: { extra: { enabled: true }, env: configuration.adapterConfig.env, model: "gpt-5" } });
    expect(agentConfigurationPatch(parseAgentConfigurationYaml(`# comment\n${text}`), configuration)).toEqual({});
  });

  it.each([
    ["unknown version", (text: string) => text.replace("paperclip/v1", "paperclip/v2")],
    ["unknown field", (text: string) => `${text}  typo: true\n`],
    ["missing field", (text: string) => text.replace("  name: Codie\n", "")],
    ["invalid budget", (text: string) => text.replace("budgetMonthlyCents: 12000", "budgetMonthlyCents: -1")],
    ["invalid environment", (text: string) => text.replace("defaultEnvironmentId: null", "defaultEnvironmentId: unknown")],
    ["duplicate key", (text: string) => `${text}  name: duplicate\n`],
    ["second document", (text: string) => `${text}---\nkind: Agent\n`],
    ["alias", (text: string) => text.replace("metadata: null", "metadata: {a: &a [1], b: *a}")],
    ["NaN", (text: string) => text.replace("metadata: null", "metadata: {value: .nan}")],
    ["merge key", (text: string) => text.replace("metadata: null", "metadata: {<<: {name: Other}}")],
    ["reserved key", (text: string) => text.replace("metadata: null", "metadata: {__proto__: {bad: true}}")],
    ["permission mutation", (text: string) => `${text}  permissions: {canCreateAgents: true}\n`],
    ["status mutation", (text: string) => `${text}  status: idle\n`],
  ])("rejects %s before saving", (_name, modify) => {
    expect(() => parseAgentConfigurationYaml(modify(serializeAgentConfiguration(configuration)))).toThrow();
  });
});

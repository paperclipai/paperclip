import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { getAgentConfigDirtyDetails } from "./AgentConfigForm";
import {
  AgentConfigurationRail,
  EffectiveConfigurationStrip,
  buildEffectiveConfigurationChips,
  filterAgentConfigurationSections,
  resolveEffectiveConfiguration,
} from "./agent-configuration-shell";

describe("agent configuration shell", () => {
  it("matches section names, field metadata, help copy, and synonyms", () => {
    expect([...filterAgentConfigurationSections("")].slice(0, 2)).toEqual(["runtime", "environment"]);
    expect([...filterAgentConfigurationSections("heartbeat")]).toEqual(["runtime", "schedule"]);
    expect([...filterAgentConfigurationSections("API Keys")]).toEqual(["keys"]);
    expect([...filterAgentConfigurationSections("sandbox")]).toEqual(["danger"]);
    expect([...filterAgentConfigurationSections("filesystem")]).toEqual(["danger"]);
    expect([...filterAgentConfigurationSections("cron")]).toEqual(["schedule"]);
    expect([...filterAgentConfigurationSections("periodic tasks")]).toEqual(["schedule"]);
  });

  it("does not guess an inherited adapter model from available choices", () => {
    const agent = {
      adapterType: "claude_local",
      adapterConfig: { modelReasoningEffort: "high", env: { EXAMPLE: "value" } },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
      permissions: { trustPreset: "standard" },
      defaultEnvironmentId: null,
    } as unknown as Agent;

    expect(resolveEffectiveConfiguration(agent, 2)).toMatchObject({
      model: "Adapter default · high",
      modelInherited: true,
      environmentInherited: true,
      apiKeyCount: 2,
      environmentVariableCount: 1,
    });
  });

  it("counts draft fields and assigns dirty section dots", () => {
    expect(getAgentConfigDirtyDetails({
      identity: { defaultEnvironmentId: "env-1" },
      adapterConfig: { model: "claude-fable-5", dangerouslySkipPermissions: true },
      heartbeat: { intervalSec: 300 },
      runtime: {},
    })).toEqual({
      count: 4,
      sections: ["environment", "runtime", "danger", "schedule"],
    });
  });

  it("builds the effective chips in spec order without a separate Variables chip", () => {
    const agent = {
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra" },
      runtimeConfig: { heartbeat: { enabled: false } },
      permissions: { trustPreset: "standard" },
      defaultEnvironmentId: null,
    } as unknown as Agent;

    expect(buildEffectiveConfigurationChips(resolveEffectiveConfiguration(agent, 2)).map((chip) => chip.label)).toEqual([
      "Adapter",
      "Model",
      "Cost saver",
      "Environment",
      "Cadence",
      "Trust",
      "API keys",
    ]);
  });

  it("explains the rail status glyphs", () => {
    const markup = renderToStaticMarkup(createElement(AgentConfigurationRail, {
      query: "",
      onQueryChange: () => undefined,
      visibleSections: filterAgentConfigurationSections(""),
      dirtySections: new Set(["runtime"]),
    }));

    expect(markup).toContain(">●</span> = unsaved change in section");
    expect(markup).toContain(">⚡</span> = changes apply immediately");
  });

  it("keeps inherited chip metadata compact and the strip reachable", () => {
    const markup = renderToStaticMarkup(createElement(EffectiveConfigurationStrip, {
      chips: [
        { label: "Adapter", value: "Codex", section: "runtime" },
        { label: "Model", value: "Adapter default", section: "runtime", inherited: true },
      ],
    }));

    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('title="Model is inherited"');
    expect(markup).toContain('aria-label="Model: Adapter default, inherited"');
    expect(markup).not.toContain("sr-only");
  });
});

import { describe, expect, it } from "vitest";
import { diffConfigSnapshot } from "../services/agents.js";

describe("agent config revision diff", () => {
  it("records editor-level paths instead of broad config objects", () => {
    const before = {
      name: "Coder",
      role: "engineer",
      title: null,
      icon: null,
      reportsTo: null,
      capabilities: null,
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5", env: { DEBUG: "0" } },
      runtimeConfig: { heartbeat: { intervalSec: 300 }, modelProfiles: { cheap: { enabled: false } } },
      defaultEnvironmentId: null,
      budgetMonthlyCents: 1000,
      metadata: null,
    };
    const after = {
      ...before,
      adapterConfig: { model: "gpt-5.5", env: { DEBUG: "1" } },
      runtimeConfig: { heartbeat: { intervalSec: 600 }, modelProfiles: { cheap: { enabled: true } } },
    };

    expect(diffConfigSnapshot(before, after)).toEqual([
      "adapterConfig.env",
      "adapterConfig.model",
      "runtimeConfig.heartbeat.intervalSec",
      "runtimeConfig.modelProfiles.cheap",
    ]);
  });
});

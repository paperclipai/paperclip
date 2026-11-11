import { describe, expect, it } from "vitest";
import {
  MARKETING_AGENT_TEMPLATES, MARKETING_AGENT_TYPE_IDS, createMarketingAgentProfile,
  marketingAgentInstructions, marketingAgentRole, readMarketingAgentProfile,
} from "./marketing-agents.js";
import { createAgentSchema, updateAgentSchema } from "./validators/agent.js";

describe("marketing agent contracts", () => {
  it("offers exactly the twelve distinct agreed roles", () => {
    expect(MARKETING_AGENT_TEMPLATES.map(item => item.label)).toEqual([
      "CMO", "VP de Estratégia", "Designer", "Redação / Copywriting", "Analista de Mídia Paga",
      "Analista de Mídia Orgânica", "Social Media", "Tecnologia / Desenvolvimento", "Motion Designer",
      "BI & Data Analytics", "Pesquisa e Insights", "Coordenador de Performance",
    ]);
    expect(new Set(MARKETING_AGENT_TYPE_IDS).size).toBe(12);
  });
  it.each(MARKETING_AGENT_TYPE_IDS)("persists a validated snapshot for %s independently of the runtime", typeId => {
    const profile = createMarketingAgentProfile(typeId);
    const parsed = createAgentSchema.parse({ name: "Minha equipe", adapterType: "codex_local",
      adapterConfig: { model: "chosen-model" }, metadata: { unrelated: true, marketingAgent: profile } });
    expect(readMarketingAgentProfile(parsed.metadata)).toEqual(profile);
    expect(parsed.adapterConfig).toEqual({ model: "chosen-model" });
    expect(parsed.metadata?.unrelated).toBe(true);
    expect(marketingAgentInstructions(profile)).toContain(profile.qualityCriteria);
  });
  it("keeps custom snapshots independent of other agents and future defaults", () => {
    const first = createMarketingAgentProfile("paid_media");
    first.instructions = "Instruções personalizadas do projeto.";
    first.specialization = "Meta Ads";
    const persisted = JSON.parse(JSON.stringify({ marketingAgent: first }));
    const second = createMarketingAgentProfile("paid_media");
    second.specialization = "Google Ads";
    expect(readMarketingAgentProfile(persisted)?.instructions).toBe(first.instructions);
    expect(second.instructions).not.toBe(first.instructions);
    expect(createMarketingAgentProfile("paid_media").specialization).toBe("");
  });
  it("rejects unknown types, incomplete profiles and blank instructions on writes", () => {
    const profile = createMarketingAgentProfile("copywriter");
    for (const invalid of [{ ...profile, typeId: "ceo" }, { typeId: "cmo" }, { ...profile, instructions: " " }]) {
      expect(createAgentSchema.safeParse({ name: "X", adapterType: "codex_local", metadata: { marketingAgent: invalid } }).success).toBe(false);
      expect(updateAgentSchema.safeParse({ metadata: { marketingAgent: invalid } }).success).toBe(false);
    }
  });
  it("preserves existing upstream agents and unrelated runtime updates", () => {
    expect(createAgentSchema.safeParse({ name: "Imported", adapterType: "codex_local" }).success).toBe(true);
    expect(updateAgentSchema.parse({ adapterConfig: { model: "another-model" } })).not.toHaveProperty("metadata");
    expect(readMarketingAgentProfile(null)).toBeNull();
  });
  it("maps only the first CMO to the internal coordinator role", () => {
    expect(marketingAgentRole("cmo", false)).toBe("ceo");
    expect(marketingAgentRole("cmo", true)).toBe("cmo");
    expect(marketingAgentRole("copywriter", false)).toBe("general");
  });
});

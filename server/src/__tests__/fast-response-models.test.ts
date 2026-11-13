import { afterEach, expect, it, vi } from "vitest";
import { fastResponseCatalogModels } from "../services/fast-response-models.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps direct Anthropic models independent of host Bedrock and adapter overrides", () => {
  vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
  vi.stubEnv("PAPERCLIP_ADAPTER_MODELS", JSON.stringify({ claude_local: [{ id: "host-private-model" }] }));
  const models = fastResponseCatalogModels({ provider: "anthropic" });
  expect(models.length).toBeGreaterThan(0);
  expect(models.every(model => model.id.startsWith("claude-"))).toBe(true);
});

it("uses only a routed connection's configured model IDs", () => {
  const routing = { kind: "bedrock" as const, protocol: "bedrock" as const, auth: "bearer" as const, region: "us-east-1", models: [] };
  expect(fastResponseCatalogModels({ provider: "anthropic", routing })).toEqual([]);
  const models = [{ id: "us.anthropic.custom", label: "Configured model" }];
  expect(fastResponseCatalogModels({ provider: "anthropic", routing: { ...routing, models } })).toEqual(models);
});

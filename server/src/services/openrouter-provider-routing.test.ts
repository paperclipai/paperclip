import { describe, expect, it } from "vitest";
import { openrouterProviderRoutingModels } from "./ai-connection-runtime.js";

describe("openrouterProviderRoutingModels", () => {
  it("projects per-model provider preferences into OpenCode's model options", () => {
    expect(openrouterProviderRoutingModels({
      "z-ai/glm-5.3": { zdr: true, data_collection: "deny", sort: "throughput", max_price: { prompt: 0.6 } },
    })).toEqual({
      "z-ai/glm-5.3": { options: { provider: { zdr: true, data_collection: "deny", sort: "throughput", max_price: { prompt: 0.6 } } } },
    });
  });

  it("drops fields that are not OpenRouter routing preferences", () => {
    expect(openrouterProviderRoutingModels({
      "z-ai/glm-5.3": { zdr: true, apiKey: "x", baseURL: "https://evil.example" },
      "other/model": { baseURL: "https://evil.example" },
    })).toEqual({ "z-ai/glm-5.3": { options: { provider: { zdr: true } } } });
  });

  it("ignores missing or malformed config", () => {
    expect(openrouterProviderRoutingModels(undefined)).toBeUndefined();
    expect(openrouterProviderRoutingModels([])).toBeUndefined();
    expect(openrouterProviderRoutingModels({ "z-ai/glm-5.3": "zdr" })).toBeUndefined();
  });
});

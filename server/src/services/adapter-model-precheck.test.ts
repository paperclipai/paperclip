import { describe, expect, it } from "vitest";
import {
  describeUnknownModel,
  precheckAdapterModel,
  usesUnenumerableModelSource,
} from "./adapter-model-precheck.js";

const MODELS = [{ id: "gpt-5.3-codex" }, { id: "gpt-5.1-codex-mini" }, { id: "o3" }];

describe("precheckAdapterModel", () => {
  it("rejects a model id that the adapter does not offer", () => {
    const outcome = precheckAdapterModel({
      adapterConfig: { model: "gpt-5.3-codex-spark" },
      knownModels: MODELS,
    });
    expect(outcome.kind).toBe("unknown_model");
    if (outcome.kind !== "unknown_model") return;
    expect(outcome.model).toBe("gpt-5.3-codex-spark");
    expect(outcome.knownModels).toEqual(["gpt-5.3-codex", "gpt-5.1-codex-mini", "o3"]);
  });

  it("accepts a model the picker offers", () => {
    expect(
      precheckAdapterModel({ adapterConfig: { model: "gpt-5.3-codex" }, knownModels: MODELS }).kind,
    ).toBe("ok");
  });

  it("trims before matching so trailing whitespace is not a rejection", () => {
    expect(
      precheckAdapterModel({ adapterConfig: { model: "  o3  " }, knownModels: MODELS }).kind,
    ).toBe("ok");
  });

  it("treats model ids as case-sensitive, matching provider behaviour", () => {
    expect(
      precheckAdapterModel({ adapterConfig: { model: "O3" }, knownModels: MODELS }).kind,
    ).toBe("unknown_model");
  });

  it("stands down when no model is configured, since the adapter default applies", () => {
    expect(precheckAdapterModel({ adapterConfig: {}, knownModels: MODELS }).kind).toBe("skipped");
    expect(
      precheckAdapterModel({ adapterConfig: { model: "   " }, knownModels: MODELS }).kind,
    ).toBe("skipped");
  });

  // The failure mode this guards against: discovery is a network call. If it
  // returns nothing we have no evidence the model is wrong, and blocking the
  // save would make a provider outage look like a config error.
  it("stands down when discovery returned no models", () => {
    const outcome = precheckAdapterModel({
      adapterConfig: { model: "gpt-5.3-codex-spark" },
      knownModels: [],
    });
    expect(outcome.kind).toBe("skipped");
  });

  it("stands down for a custom gateway, whose catalog is not enumerable here", () => {
    for (const adapterConfig of [
      { model: "cx/gpt-5.3-codex", env: { PAPERCLIP_CODEX_PROVIDERS: '{"providers":{}}' } },
      { model: "oc/x", env: { PAPERCLIP_OPENCODE_PROVIDERS: "{}" } },
      { model: "pi/x", env: { PAPERCLIP_PI_PROVIDERS: "{}" } },
      { model: "anything", env: { ANTHROPIC_BASE_URL: "http://gateway.example/v1" } },
      { model: "anything", env: { OPENAI_BASE_URL: "http://gateway.example/v1" } },
      { model: "anything", baseUrl: "http://gateway.example/v1" },
      { model: "anything", modelProvider: "gw" },
    ]) {
      const outcome = precheckAdapterModel({ adapterConfig, knownModels: MODELS });
      expect(outcome.kind, JSON.stringify(adapterConfig)).toBe("skipped");
    }
  });

  it("still checks the model when env exists but carries no gateway key", () => {
    const outcome = precheckAdapterModel({
      adapterConfig: { model: "gpt-5.3-codex-spark", env: { OPENAI_API_KEY: "sk-x" } },
      knownModels: MODELS,
    });
    expect(outcome.kind).toBe("unknown_model");
  });

  it("ignores a gateway key present but empty", () => {
    expect(usesUnenumerableModelSource({ env: { ANTHROPIC_BASE_URL: "   " } })).toBeNull();
  });

  it("does not crash when env is not an object", () => {
    expect(usesUnenumerableModelSource({ env: "nope" })).toBeNull();
    expect(usesUnenumerableModelSource({ env: null })).toBeNull();
    expect(usesUnenumerableModelSource({ env: ["ANTHROPIC_BASE_URL"] })).toBeNull();
  });

  it("does not crash on malformed model entries from discovery", () => {
    const outcome = precheckAdapterModel({
      adapterConfig: { model: "o3" },
      knownModels: [{ id: "" }, { id: "o3" }] as { id: string }[],
    });
    expect(outcome.kind).toBe("ok");
  });
});

describe("describeUnknownModel", () => {
  it("names the field, the value, and the route that lists valid ids", () => {
    const message = describeUnknownModel({
      adapterType: "codex_local",
      model: "gpt-5.3-codex-spark",
      knownModels: ["gpt-5.3-codex", "o3"],
      companyId: "company-1",
    });
    expect(message).toContain("adapterConfig.model");
    expect(message).toContain("gpt-5.3-codex-spark");
    expect(message).toContain("/api/companies/company-1/adapters/codex_local/models");
    expect(message).toContain("gpt-5.3-codex");
  });

  it("caps the suggestion list so a 127-model catalog does not flood the error", () => {
    const knownModels = Array.from({ length: 127 }, (_, i) => `model-${i}`);
    const message = describeUnknownModel({
      adapterType: "codex_local",
      model: "nope",
      knownModels,
    });
    expect(message).toContain("and 119 more");
    expect(message).not.toContain("model-9,");
    expect(message).toContain("{companyId}");
  });
});

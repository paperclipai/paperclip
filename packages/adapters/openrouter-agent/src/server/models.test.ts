import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelLabel, detectModel, listModels, refreshModels } from "./models.js";
import { models as staticModels } from "../index.js";

const STATIC_MODEL_IDS = staticModels.map((m) => m.id);

function makeModel(overrides: {
  id?: string;
  name?: string;
  pricingPrompt?: string;
  pricingCompletion?: string;
  supported_parameters?: string[];
  input_modalities?: string[];
  expiration_date?: string | null;
}) {
  return {
    id: overrides.id ?? "provider/model",
    name: overrides.name ?? "Provider: Model",
    pricing: {
      prompt: overrides.pricingPrompt ?? "0.000001",
      completion: overrides.pricingCompletion ?? "0.000002",
    },
    supported_parameters: overrides.supported_parameters ?? ["tools"],
    architecture: {
      input_modalities: overrides.input_modalities ?? ["text"],
    },
    expiration_date: overrides.expiration_date ?? null,
  };
}

// ── buildModelLabel ───────────────────────────────────────────────────────────

describe("buildModelLabel", () => {
  it("adds [free] tag when both prompt and completion are zero", () => {
    const model = makeModel({ name: "Free Model", pricingPrompt: "0", pricingCompletion: "0" });
    expect(buildModelLabel(model)).toBe("Free Model [free]");
  });

  it("adds [thinking] tag when supported_parameters includes reasoning", () => {
    const model = makeModel({
      name: "Thinker",
      supported_parameters: ["tools", "reasoning"],
    });
    expect(buildModelLabel(model)).toBe("Thinker [thinking]");
  });

  it("adds [thinking] tag when supported_parameters includes include_reasoning", () => {
    const model = makeModel({
      name: "Thinker2",
      supported_parameters: ["tools", "include_reasoning"],
    });
    expect(buildModelLabel(model)).toBe("Thinker2 [thinking]");
  });

  it("adds [free, thinking] when both conditions hold", () => {
    const model = makeModel({
      name: "Free Thinker",
      pricingPrompt: "0",
      pricingCompletion: "0",
      supported_parameters: ["tools", "reasoning"],
    });
    expect(buildModelLabel(model)).toBe("Free Thinker [free, thinking]");
  });

  it("returns bare name when no tags apply", () => {
    const model = makeModel({ name: "Plain Model", supported_parameters: ["tools"] });
    expect(buildModelLabel(model)).toBe("Plain Model");
  });

  it("adds [vision] tag when image is in input_modalities", () => {
    const model = makeModel({ name: "Vision", input_modalities: ["text", "image"] });
    expect(buildModelLabel(model)).toBe("Vision [vision]");
  });

  it("adds [structured] tag when structured_outputs in supported_parameters", () => {
    const model = makeModel({
      name: "Structured",
      supported_parameters: ["tools", "structured_outputs"],
    });
    expect(buildModelLabel(model)).toBe("Structured [structured]");
  });

  it("adds [parallel-tools] tag when parallel_tool_calls in supported_parameters", () => {
    const model = makeModel({
      name: "Parallel",
      supported_parameters: ["tools", "parallel_tool_calls"],
    });
    expect(buildModelLabel(model)).toBe("Parallel [parallel-tools]");
  });
});

// ── listModels filtering ──────────────────────────────────────────────────────

describe("listModels", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_DEFAULT_MODEL"] as const;

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_DEFAULT_MODEL;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    // Clear the cache while the mock fetch is still active so we don't make real network calls.
    // Override the mock to reject so refreshModels won't populate the cache with stale data.
    vi.mocked(fetch).mockRejectedValue(new Error("cleanup"));
    await refreshModels().catch(() => {}); // clears cache; fetch rejection leaves cache null
    // Restore env and unmock
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.unstubAllGlobals();
  });

  function mockFetch(models: ReturnType<typeof makeModel>[]) {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: models }),
    } as Response);
  }

  it("excludes models without tools in supported_parameters", async () => {
    mockFetch([
      makeModel({ id: "a/no-tools", name: "No Tools", supported_parameters: [] }),
      makeModel({ id: "b/with-tools", name: "With Tools", supported_parameters: ["tools"] }),
    ]);
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual(["b/with-tools"]);
  });

  it("excludes expired models", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    mockFetch([
      makeModel({ id: "a/expired", name: "Expired", expiration_date: past }),
      makeModel({ id: "b/active", name: "Active", expiration_date: future }),
    ]);
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual(["b/active"]);
  });

  it("includes non-expired models with tools", async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    mockFetch([
      makeModel({ id: "a/model", name: "A Model", expiration_date: future }),
    ]);
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual(["a/model"]);
  });

  // ── fallback ───────────────────────────────────────────────────────────────

  it("returns static models when fetch throws", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network failure"));
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual(STATIC_MODEL_IDS);
  });

  it("appends OPENROUTER_MODEL to fallback list when fetch throws", async () => {
    process.env.OPENROUTER_MODEL = "deepseek/deepseek-r1";
    vi.mocked(fetch).mockRejectedValue(new Error("network failure"));
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual([...STATIC_MODEL_IDS, "deepseek/deepseek-r1"]);
  });

  it("appends OPENROUTER_DEFAULT_MODEL to fallback list when fetch throws", async () => {
    process.env.OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o";
    vi.mocked(fetch).mockRejectedValue(new Error("network failure"));
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual([...STATIC_MODEL_IDS, "openai/gpt-4o"]);
  });

  it("deduplicates env vars already present in static models in fallback", async () => {
    process.env.OPENROUTER_MODEL = "openrouter/auto"; // already in staticModels
    vi.mocked(fetch).mockRejectedValue(new Error("network failure"));
    const result = await listModels();
    expect(result.map((m) => m.id)).toEqual(STATIC_MODEL_IDS);
  });

  // ── caching ────────────────────────────────────────────────────────────────

  it("calls fetch only once across two listModels calls (cache hit)", async () => {
    mockFetch([makeModel({ id: "a/model", name: "A Model" })]);
    await refreshModels(); // prime fresh
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [makeModel({ id: "a/model", name: "A Model" })] }),
    } as Response);

    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await listModels();
    await listModels();
    // No additional fetch calls after cache is warm
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  // ── no API key → sentinel ─────────────────────────────────────────────────

  it("returns sentinel entry when OPENROUTER_API_KEY is not set", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await refreshModels().catch(() => {}); // clear cache from previous test
    const result = await listModels();
    expect(result).toEqual([
      { id: "", label: "Non-OpenRouter endpoint — enter model name manually" },
    ]);
  });
});

// ── detectModel ───────────────────────────────────────────────────────────────

describe("detectModel", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
  });

  afterEach(() => {
    if (savedEnv.OPENROUTER_MODEL === undefined) {
      delete process.env.OPENROUTER_MODEL;
    } else {
      process.env.OPENROUTER_MODEL = savedEnv.OPENROUTER_MODEL;
    }
  });

  it("returns correct shape when OPENROUTER_MODEL is set", async () => {
    process.env.OPENROUTER_MODEL = "deepseek/deepseek-r1";
    const result = await detectModel();
    expect(result).toEqual({
      model: "deepseek/deepseek-r1",
      provider: "openrouter",
      source: "env_OPENROUTER_MODEL",
    });
  });

  it("returns null when OPENROUTER_MODEL is not set", async () => {
    delete process.env.OPENROUTER_MODEL;
    const result = await detectModel();
    expect(result).toBeNull();
  });

  it("returns null when OPENROUTER_MODEL is empty string", async () => {
    process.env.OPENROUTER_MODEL = "";
    const result = await detectModel();
    expect(result).toBeNull();
  });

  it("trims whitespace from OPENROUTER_MODEL", async () => {
    process.env.OPENROUTER_MODEL = "  openai/gpt-4o  ";
    const result = await detectModel();
    expect(result?.model).toBe("openai/gpt-4o");
  });
});

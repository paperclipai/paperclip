import { afterEach, describe, expect, it } from "vitest";
import {
  __setAuggieDiscoveryImplForTests,
  discoverAuggieModelsCached,
  listAuggieModels,
  parseAuggieModelsJson,
  resetAuggieModelsCacheForTests,
} from "./models.js";

const SAMPLE_STDOUT = JSON.stringify({
  registryAvailable: true,
  defaultModelId: "claude-sonnet-4-5-agent",
  models: [
    {
      displayName: "Haiku 4.5",
      shortName: "haiku4.5",
      description: "Fast",
      modelGroupPriority: 1,
      costTier: 1,
    },
    {
      displayName: "Opus 4.7",
      shortName: "opus4.7",
      modelGroupPriority: 1,
      costTier: 3,
      isDefault: true,
    },
    {
      displayName: "Sonnet 4.6",
      shortName: "sonnet4.6",
      modelGroupPriority: 1,
      costTier: 2,
    },
    {
      displayName: "Sonnet 4.5",
      shortName: "sonnet4.5",
      costTier: 2,
      isLegacyModel: true,
    },
    {
      displayName: "GPT-5",
      shortName: "gpt5",
      costTier: 2,
      isLegacyModel: true,
    },
  ],
});

describe("parseAuggieModelsJson", () => {
  it("puts the auto sentinel first, sorts current models by priority/cost/id, and legacy last", () => {
    const parsed = parseAuggieModelsJson(SAMPLE_STDOUT);
    expect(parsed[0]).toEqual({ id: "auto", label: "Auto (account default)" });
    // Non-legacy sorted by costTier asc (priority all == 1): haiku(1), sonnet(2), opus(3)
    expect(parsed.slice(1, 4).map((m) => m.id)).toEqual([
      "haiku4.5",
      "sonnet4.6",
      "opus4.7",
    ]);
    // Legacy tail, suffixed
    const legacy = parsed.slice(4);
    expect(legacy.map((m) => m.id).sort()).toEqual(["gpt5", "sonnet4.5"]);
    expect(legacy.every((m) => m.label.endsWith("(legacy)"))).toBe(true);
  });

  it("uses displayName for label and falls back to shortName when missing", () => {
    const stdout = JSON.stringify({
      models: [
        { shortName: "foo" },
        { shortName: "bar", displayName: "Bar Model" },
      ],
    });
    const parsed = parseAuggieModelsJson(stdout);
    // auto + 2 entries
    expect(parsed).toHaveLength(3);
    const byId = Object.fromEntries(parsed.map((m) => [m.id, m.label]));
    expect(byId.foo).toBe("foo");
    expect(byId.bar).toBe("Bar Model");
  });

  it("returns [] when JSON is invalid", () => {
    expect(parseAuggieModelsJson("not json")).toEqual([]);
  });

  it("returns [] when models array is empty", () => {
    expect(parseAuggieModelsJson(JSON.stringify({ models: [] }))).toEqual([]);
  });

  it("skips entries without a shortName", () => {
    const stdout = JSON.stringify({
      models: [
        { shortName: "", displayName: "Empty" },
        { displayName: "NoShort" },
        { shortName: "ok", displayName: "Ok" },
      ],
    });
    const parsed = parseAuggieModelsJson(stdout);
    expect(parsed.map((m) => m.id)).toEqual(["auto", "ok"]);
  });
});

describe("listAuggieModels", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_AUGGIE_COMMAND;
    resetAuggieModelsCacheForTests();
  });

  it("returns [] when discovery command is unavailable (so the server falls back to static models)", async () => {
    process.env.PAPERCLIP_AUGGIE_COMMAND =
      "__paperclip_missing_auggie_command__";
    await expect(listAuggieModels()).resolves.toEqual([]);
  });
});

describe("discoverAuggieModelsCached singleflight", () => {
  afterEach(() => {
    resetAuggieModelsCacheForTests();
  });

  it("coalesces concurrent cache misses into a single discovery call", async () => {
    let callCount = 0;
    const sampleModels = [{ id: "auto", label: "Auto (account default)" }];
    __setAuggieDiscoveryImplForTests(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sampleModels;
    });
    const results = await Promise.all([
      discoverAuggieModelsCached(),
      discoverAuggieModelsCached(),
      discoverAuggieModelsCached(),
    ]);
    expect(callCount).toBe(1);
    for (const result of results) {
      expect(result).toEqual(sampleModels);
    }
  });

  it("clears the in-flight entry after rejection so subsequent calls retry", async () => {
    let callCount = 0;
    __setAuggieDiscoveryImplForTests(async () => {
      callCount++;
      throw new Error("boom");
    });
    await expect(discoverAuggieModelsCached()).rejects.toThrow("boom");
    await expect(discoverAuggieModelsCached()).rejects.toThrow("boom");
    expect(callCount).toBe(2);
  });
});

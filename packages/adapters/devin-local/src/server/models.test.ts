import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeVariant,
  parseCostSummary,
  costLabel,
  buildDiscoveredModels,
  resolveModelUidFrom,
  resolveDetectedBaseModelId,
  detectModel,
  discoverDevinModels,
  clearModelCache,
  type DevinModelFamily,
  type DevinModelVariant,
} from "./models.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

// ── Fixture catalog ──────────────────────────────────────────────────────────
// Shaped like `devin models list --format json`, small enough to reason about.
function variant(
  model_uid: string,
  label: string,
  cost_tier: string,
  cost_summary: string | null,
  opts: { is_new?: boolean; is_beta?: boolean } = {},
): DevinModelVariant {
  return {
    model_uid,
    label,
    max_context_tokens: 200_000,
    max_output_tokens: 8_192,
    cost_tier,
    cost_summary,
    is_new: opts.is_new ?? false,
    is_beta: opts.is_beta ?? false,
  };
}

const FIXTURE: DevinModelFamily[] = [
  {
    family_label: "SWE-1.7",
    family_uid: "swe-1.7",
    slug: "swe-1-7",
    aliases: [],
    variants: [
      variant("swe-1-7", "SWE-1.7 Max", "Free", null, { is_beta: true }),
      variant("swe-1-7-medium", "SWE-1.7 Medium", "Free", null),
      variant("swe-1-7-high", "SWE-1.7 High", "Free", null),
    ],
  },
  {
    family_label: "Claude Opus 4.8",
    family_uid: "claude-opus-4.8",
    slug: "claude-opus-4-8",
    aliases: [],
    variants: [
      variant("claude-opus-4-8-low", "Claude Opus 4.8 Low", "Premium", "$5 / MTok In · $25 / MTok Out"),
      variant("claude-opus-4-8-medium", "Claude Opus 4.8 Medium", "Premium", "$5 / MTok In · $25 / MTok Out"),
      variant("claude-opus-4-8-high", "Claude Opus 4.8 High", "Premium", "$5 / MTok In · $25 / MTok Out"),
      variant("claude-opus-4-8-high-1m", "Claude Opus 4.8 High 1M", "Premium", "$8 / MTok In · $40 / MTok Out"),
      variant("claude-opus-4-8-medium-fast", "Claude Opus 4.8 Medium Fast", "Premium", "$10 / MTok In · $50 / MTok Out"),
    ],
  },
  {
    // A second free family that sorts alphabetically before SWE-1.7,
    // so it becomes freeBase[0]. The default must still prefer the SWE-1.7 lane.
    family_label: "Gemini 3 Flash",
    family_uid: "gemini-3-flash",
    slug: "gemini-3-flash",
    aliases: [],
    variants: [variant("gemini-3-flash", "Gemini 3 Flash", "Free", null)],
  },
  {
    family_label: "Adaptive",
    family_uid: "adaptive",
    slug: "adaptive",
    aliases: [],
    variants: [variant("adaptive", "Adaptive", "", null)],
  },
  {
    // Legacy/one-off: model_uid does not cleanly decompose against the family slug,
    // so it is grouped under its family and exposed only as the default variant.
    family_label: "GPT-5.3-Codex",
    family_uid: "gpt-5.3-codex",
    slug: "gpt-5-3-codex",
    aliases: [],
    variants: [variant("gpt-5.3-codex", "GPT-5.3-Codex", "Premium", "$1.25 / MTok In · $10 / MTok Out")],
  },
];

describe("decodeVariant", () => {
  it("decodes the base (auto) variant when id equals the family slug", () => {
    expect(decodeVariant("swe-1-7", "swe-1.7")).toEqual({
      effort: "auto",
      fast: false,
      context1m: false,
      priority: false,
    });
  });

  it("decodes a single effort suffix", () => {
    expect(decodeVariant("swe-1-7-medium", "swe-1.7")).toEqual({
      effort: "medium",
      fast: false,
      context1m: false,
      priority: false,
    });
  });

  it("decodes effort plus the 1m context flag", () => {
    expect(decodeVariant("claude-opus-4-8-high-1m", "claude-opus-4.8")).toEqual({
      effort: "high",
      fast: false,
      context1m: true,
      priority: false,
    });
  });

  it("decodes effort plus the fast flag", () => {
    expect(decodeVariant("claude-opus-4-8-medium-fast", "claude-opus-4.8")).toEqual({
      effort: "medium",
      fast: true,
      context1m: false,
      priority: false,
    });
  });

  it("returns null when the id does not belong to the family", () => {
    expect(decodeVariant("gpt-5.3-codex", "MODEL_GPT_5_3_CODEX")).toBeNull();
  });

  it("treats unrecognized tokens as auto effort and keeps the variant in its family", () => {
    expect(decodeVariant("swe-1-7-turbo", "swe-1.7")).toEqual({
      effort: "auto",
      fast: false,
      context1m: false,
      priority: false,
    });
  });
});

describe("parseCostSummary", () => {
  it("marks the free tier as free", () => {
    const c = parseCostSummary("Free", null);
    expect(c.isFree).toBe(true);
    expect(c.isUnknown).toBeUndefined();
  });

  it("parses per-MTok input/output pricing", () => {
    const c = parseCostSummary("Premium", "$5 / MTok In · $25 / MTok Out");
    expect(c).toMatchObject({ inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false });
  });

  it("parses the current catalog format including the cached-input rate", () => {
    // Format since CLI 3000.6.12: "1M Input · 1M Cached input · 1M Output".
    const c = parseCostSummary(
      "Low cost",
      "$0.5 / 1M Input · $0.2 / 1M Cached input · $2.5 / 1M Output",
    );
    expect(c).toMatchObject({
      inputCostPerMTok: 0.5,
      cachedInputCostPerMTok: 0.2,
      outputCostPerMTok: 2.5,
      isFree: false,
    });
  });

  it("leaves the cached rate unset on the legacy format without one", () => {
    const c = parseCostSummary("Premium", "$5 / MTok In · $25 / MTok Out");
    expect(c.cachedInputCostPerMTok).toBeUndefined();
  });

  it("treats missing tier and summary as unknown (not free)", () => {
    const c = parseCostSummary("", "");
    expect(c).toMatchObject({ isFree: false, isUnknown: true });
  });

  it("treats a 'None' summary as free", () => {
    expect(parseCostSummary("Standard", "None").isFree).toBe(true);
  });

  it("falls back to unknown when the summary cannot be parsed", () => {
    expect(parseCostSummary("Premium", "priced somehow").isUnknown).toBe(true);
  });
});

describe("costLabel", () => {
  it("labels free, unknown, and priced costs", () => {
    expect(costLabel({ inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: true })).toBe("Free");
    expect(costLabel({ inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: false, isUnknown: true })).toBe(
      "cost varies",
    );
    expect(costLabel({ inputCostPerMTok: 5, outputCostPerMTok: 25, isFree: false })).toBe(
      "$5 / MTok In · $25 / MTok Out",
    );
  });
});

describe("buildDiscoveredModels", () => {
  const discovered = buildDiscoveredModels(FIXTURE);

  it("consolidates variants into one base model per family", () => {
    const ids = discovered.baseModels.map((b) => b.id).sort();
    expect(ids).toEqual([
      "adaptive",
      "claude-opus-4.8",
      "gemini-3-flash",
      "gpt-5.3-codex",
      "swe-1.7",
    ]);
  });

  it("captures the axes available across a family's variants", () => {
    const opus = discovered.baseById.get("claude-opus-4.8")!;
    expect(opus.availableEfforts).toEqual(["low", "medium", "high"]);
    expect(opus.has1m).toBe(true);
    expect(opus.hasFast).toBe(true);
    expect(opus.hasPriority).toBe(false);
  });

  it("groups non-decomposable variants under their family and exposes a defaultVariantId", () => {
    const codex = discovered.baseById.get("gpt-5.3-codex")!;
    expect(codex.defaultVariantId).toBe("gpt-5.3-codex");
    expect(codex.availableEfforts).toEqual(["auto"]);
  });

  it("collects free variant ids and a free default model", () => {
    expect(discovered.freeModelIds).toEqual(
      expect.arrayContaining(["swe-1-7", "swe-1-7-medium", "swe-1-7-high"]),
    );
    expect(discovered.baseById.get(discovered.defaultModelId)?.cost.isFree).toBe(true);
  });

  it("prefers the SWE-1.7 free lane as default even when another free family sorts first", () => {
    // gemini-3-flash is the first free family alphabetically, but the default
    // must still prefer the SWE-1.7 lane.
    expect(discovered.baseModels[0]?.id).toBe("gemini-3-flash");
    expect(discovered.defaultModelId).toBe("swe-1.7");
  });

  it("sorts free base models ahead of paid ones", () => {
    expect(discovered.baseModels[0]?.cost.isFree).toBe(true);
  });

  it("carries per-family efforts on the public model list entries", () => {
    const byId = new Map(discovered.models.map((m) => [m.id, m]));
    expect(byId.get("swe-1.7")?.efforts).toEqual(["auto", "medium", "high"]);
    expect(byId.get("claude-opus-4.8")?.efforts).toEqual(["low", "medium", "high"]);
    expect(byId.get("gpt-5.3-codex")?.efforts).toEqual(["auto"]);
  });
});

describe("resolveModelUidFrom", () => {
  const discovered = buildDiscoveredModels(FIXTURE);
  const resolve = (selection: Parameters<typeof resolveModelUidFrom>[1]) =>
    resolveModelUidFrom(discovered, selection);

  it("returns an empty string for an empty model", () => {
    expect(resolve({ model: "" })).toBe("");
  });

  it("resolves an exact effort + 1m combination", () => {
    expect(resolve({ model: "claude-opus-4.8", effort: "high", contextSize: "1m" })).toBe(
      "claude-opus-4-8-high-1m",
    );
  });

  it("resolves an exact effort on a free family", () => {
    expect(resolve({ model: "swe-1.7", effort: "medium" })).toBe("swe-1-7-medium");
  });

  it("degrades gracefully by dropping an unavailable fast combo", () => {
    // high+fast does not exist (only medium+fast), so it relaxes to plain high.
    expect(resolve({ model: "claude-opus-4.8", effort: "high", fast: true })).toBe(
      "claude-opus-4-8-high",
    );
  });

  it("maps Auto to a balanced medium when the family has no auto variant", () => {
    expect(resolve({ model: "claude-opus-4.8" })).toBe("claude-opus-4-8-medium");
  });

  it("returns the standalone default variant unchanged", () => {
    expect(resolve({ model: "gpt-5.3-codex" })).toBe("gpt-5.3-codex");
  });

  it("passes an unknown/legacy uid through unchanged", () => {
    expect(resolve({ model: "some-future-model-uid" })).toBe("some-future-model-uid");
  });

  it("rejects an explicit effort the family does not offer, naming the legal tiers", () => {
    expect(() => resolve({ model: "swe-1.7", effort: "max" })).toThrow(
      'thinkingEffort "max" is not available for swe-1.7 (available: medium, high)',
    );
  });

  it("rejects an unrecognized effort token instead of coercing it", () => {
    expect(() => resolve({ model: "swe-1.7", effort: "turbo" })).toThrow(
      /not available for swe-1\.7/,
    );
  });

  it("rejects an explicit effort on a family with no effort variants", () => {
    expect(() => resolve({ model: "gpt-5.3-codex", effort: "high" })).toThrow(
      /auto only/,
    );
  });

  it("validates effort against the family behind a concrete variant uid", () => {
    expect(() => resolve({ model: "swe-1-7-medium", effort: "max" })).toThrow(
      /not available for swe-1\.7/,
    );
    expect(resolve({ model: "swe-1-7-medium", effort: "high" })).toBe("swe-1-7-medium");
  });

  it("accepts auto for every family and passes unknown uids through without validation", () => {
    expect(resolve({ model: "swe-1.7", effort: "auto" })).toBe("swe-1-7");
    expect(resolve({ model: "gpt-5.3-codex", effort: "auto" })).toBe("gpt-5.3-codex");
    expect(resolve({ model: "some-future-model-uid", effort: "max" })).toBe(
      "some-future-model-uid",
    );
  });
});

describe("resolveDetectedBaseModelId", () => {
  const discovered = buildDiscoveredModels(FIXTURE);

  it("passes an exact base id through", () => {
    expect(resolveDetectedBaseModelId("swe-1.7", discovered)).toBe("swe-1.7");
  });

  it("maps a variant uid to its family base id", () => {
    expect(resolveDetectedBaseModelId("swe-1-7-high", discovered)).toBe("swe-1.7");
    expect(resolveDetectedBaseModelId("claude-opus-4-8-medium", discovered)).toBe(
      "claude-opus-4.8",
    );
  });

  it("matches case- and separator-insensitively", () => {
    expect(resolveDetectedBaseModelId("SWE-1-7", discovered)).toBe("swe-1.7");
    expect(resolveDetectedBaseModelId("swe_1_7", discovered)).toBe("swe-1.7");
  });

  it("prefers an exact base hit over normalized collisions", () => {
    const custom = buildDiscoveredModels([
      {
        family_label: "Kimi K3",
        family_uid: "kimi-k3",
        slug: "kimi-k3",
        aliases: [],
        variants: [variant("kimi-k3-high", "Kimi K3 High", "High cost", null)],
      },
    ]);
    expect(resolveDetectedBaseModelId("kimi-k3", custom)).toBe("kimi-k3");
    expect(resolveDetectedBaseModelId("kimi-k3-high", custom)).toBe("kimi-k3");
  });

  it("passes unknown values through unchanged", () => {
    expect(resolveDetectedBaseModelId("gpt-5.2-codex", discovered)).toBe(
      "gpt-5.2-codex",
    );
    expect(resolveDetectedBaseModelId("", discovered)).toBe("");
  });
});

describe("detectModel", () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "devin-detect-model-"));
    mkdirSync(path.join(tmpDir, "devin"), { recursive: true });
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;
    clearModelCache();
    // Default: discovery fails (no CLI), so detectModel must pass the raw
    // config value through unchanged.
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: (err: Error | null) => void) => {
        callback(new Error("devin not available"));
      },
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
  });

  it("returns null when no devin config exists", async () => {
    expect(await detectModel()).toBeNull();
  });

  it("reads agent.model from the devin config", async () => {
    const devinDir = path.join(tmpDir, "devin");
    const configPath = path.join(devinDir, "config.json");
    const config = { agent: { model: "swe-1-7" } };
    writeFileSync(configPath, JSON.stringify(config));
    expect(await detectModel()).toEqual({
      model: "swe-1-7",
      provider: "devin",
      source: configPath,
    });
  });

  it("falls back to top-level model when agent.model is missing", async () => {
    const devinDir = path.join(tmpDir, "devin");
    const configPath = path.join(devinDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ model: "claude-opus-4-8-medium" }));
    expect(await detectModel()).toEqual({
      model: "claude-opus-4-8-medium",
      provider: "devin",
      source: configPath,
    });
  });

  it("maps a variant uid from the config to its family base id", async () => {
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: JSON.stringify({ families: FIXTURE }), stderr: "" });
      },
    );
    const configPath = path.join(tmpDir, "devin", "config.json");
    writeFileSync(configPath, JSON.stringify({ agent: { model: "swe-1-7-high" } }));
    expect(await detectModel()).toEqual({
      model: "swe-1.7",
      provider: "devin",
      source: configPath,
      candidates: ["swe-1-7-high"],
    });
  });

  it("maps a dashed family spelling to the catalog's dotted base id", async () => {
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: JSON.stringify({ families: FIXTURE }), stderr: "" });
      },
    );
    const configPath = path.join(tmpDir, "devin", "config.json");
    writeFileSync(configPath, JSON.stringify({ agent: { model: "swe-1-7" } }));
    expect(await detectModel()).toEqual({
      model: "swe-1.7",
      provider: "devin",
      source: configPath,
      candidates: ["swe-1-7"],
    });
  });

  it("returns the base id unchanged when the config value already matches", async () => {
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: JSON.stringify({ families: FIXTURE }), stderr: "" });
      },
    );
    const configPath = path.join(tmpDir, "devin", "config.json");
    writeFileSync(configPath, JSON.stringify({ agent: { model: "swe-1.7" } }));
    expect(await detectModel()).toEqual({
      model: "swe-1.7",
      provider: "devin",
      source: configPath,
    });
  });
});

describe("discoverDevinModels cache", () => {
  beforeEach(() => {
    clearModelCache();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shares one in-flight promise for concurrent calls", async () => {
    const callbacks: ((err: Error | null, result?: { stdout: string; stderr: string }) => void)[] = [];
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        callbacks.push(callback);
      },
    );

    const p1 = discoverDevinModels();
    const p2 = discoverDevinModels();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(callbacks.length).toBe(1);

    callbacks[0](null, { stdout: JSON.stringify({ families: [] }), stderr: "" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns cached result for subsequent calls without invoking the CLI", async () => {
    execFileMock.mockImplementation(
      (_command: unknown, _args: unknown, _options: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: JSON.stringify({ families: [] }), stderr: "" });
      },
    );

    const first = await discoverDevinModels();
    const second = await discoverDevinModels();
    expect(first).toBe(second);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

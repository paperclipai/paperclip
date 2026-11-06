import { describe, expect, it, vi } from "vitest";
import { CHAT_OPENCODE_MODEL } from "../chat-runtime-profile.js";
import { HIRE_MODEL_METADATA_URL, HIRE_ORIGINAL_MODEL, proveHireModelChoice, readHireModelChoice, validHireModelChoice } from "./identity-hire-model-choice.js";

function fixture() {
  const original = { id: HIRE_ORIGINAL_MODEL.replace(/^openrouter\//, ""), pricing: { prompt: "0.00000066", completion: "0.00000198", input_cache_read: "0.000000022" } as Record<string, unknown> };
  const target = { id: CHAT_OPENCODE_MODEL.replace(/^openrouter\//, ""), pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003",
    overrides: [{ utc_days: ["monday"], utc_start: 100, utc_end: 400, prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" }] } as Record<string, unknown> };
  return { body: { data: [original, target] }, catalog: [HIRE_ORIGINAL_MODEL, CHAT_OPENCODE_MODEL].map(id => ({ id })), original, target };
}
describe("real catalog identity and every published price variant", () => {
  it("proves exact requested1017 using worst target and best original rates", () => {
    const f = fixture(), proof = proveHireModelChoice(f.body, f.catalog);
    expect(proof.originalModel).toBe(HIRE_ORIGINAL_MODEL); expect(proof.cheaperModel).toBe(CHAT_OPENCODE_MODEL);
    expect(proof.targetMaximumRates.prompt).toBe("0.0000003"); expect(proof.targetRateVariants).toBe(2);
    expect(proof.units).toBe("USD/token"); expect(proof).not.toHaveProperty("costUsd");
  });
  it.each([
    ["missing target catalog", (f: ReturnType<typeof fixture>) => { f.catalog.pop(); }],
    ["duplicate catalog identity", (f: ReturnType<typeof fixture>) => { f.catalog.push(f.catalog[0]!); }],
    ["missing official identity", (f: ReturnType<typeof fixture>) => { f.body.data.pop(); }],
    ["ambiguous official identity", (f: ReturnType<typeof fixture>) => { f.body.data.push(f.target); }],
    ["alias instead of fixed model", (f: ReturnType<typeof fixture>) => { f.target.id = "deepseek/deepseek-v4.1-flash"; }],
    ["missing amount", (f: ReturnType<typeof fixture>) => { delete f.target.pricing.prompt; }],
    ["unknown amount", (f: ReturnType<typeof fixture>) => { f.target.pricing.prompt = null; }],
    ["numeric amount", (f: ReturnType<typeof fixture>) => { f.target.pricing.prompt = 0; }],
    ["negative amount", (f: ReturnType<typeof fixture>) => { f.target.pricing.prompt = "-0.1"; }],
    ["nonfinite amount", (f: ReturnType<typeof fixture>) => { f.target.pricing.prompt = "NaN"; }],
    ["incompatible ancillary fee", (f: ReturnType<typeof fixture>) => { f.original.pricing.request = "0.1"; }],
    ["unknown new fee even zero", (f: ReturnType<typeof fixture>) => { f.target.pricing.request = "0"; }],
    ["missing ancillary price", (f: ReturnType<typeof fixture>) => { delete f.original.pricing.input_cache_read; }],
    ["unknown override set", (f: ReturnType<typeof fixture>) => { f.target.pricing.overrides = null; }],
    ["missing override price", (f: ReturnType<typeof fixture>) => { delete (f.target.pricing.overrides as Array<Record<string, unknown>>)[0]!.completion; }],
    ["unrecognized override fee", (f: ReturnType<typeof fixture>) => { (f.target.pricing.overrides as Array<Record<string, unknown>>)[0]!.request = "0.1"; }],
    ["base-only false cheap comparison", (f: ReturnType<typeof fixture>) => { (f.target.pricing.overrides as Array<Record<string, unknown>>)[0]!.prompt = "1"; }],
    ["expensive model sometimes cheaper", (f: ReturnType<typeof fixture>) => { f.original.pricing.overrides = [{ prompt: "0.00000001", completion: "0.00000001", input_cache_read: "0.000000001" }]; }],
    ["lower input but higher output", (f: ReturnType<typeof fixture>) => { f.target.pricing.completion = "1"; }],
    ["higher cached input fee", (f: ReturnType<typeof fixture>) => { f.target.pricing.input_cache_read = "1"; }],
  ])("rejects %s", (_label, mutate) => { const f = fixture(); mutate(f); expect(() => proveHireModelChoice(f.body, f.catalog)).toThrow(); });
  it("does not manufacture zero for unknown but preserves an explicitly published zero", () => {
    const f = fixture(); f.target.pricing.input_cache_read = "0";
    (f.target.pricing.overrides as Array<Record<string, unknown>>)[0]!.input_cache_read = "0";
    expect(proveHireModelChoice(f.body, f.catalog).targetMaximumRates.input_cache_read).toBe("0");
  });
  it("uses exact decimals beyond floating point precision", () => {
    const f = fixture(); delete f.target.pricing.overrides;
    for (const field of ["prompt", "completion", "input_cache_read"]) { f.original.pricing[field] = "0.100000000000000002"; f.target.pricing[field] = "0.100000000000000001"; }
    expect(proveHireModelChoice(f.body, f.catalog).targetMaximumRates.prompt).toBe("0.100000000000000001");
    f.original.pricing.prompt = f.target.pricing.prompt; f.original.pricing.completion = f.target.pricing.completion;
    expect(() => proveHireModelChoice(f.body, f.catalog)).toThrow("strictly cheaper");
  });
});
describe("bounded public metadata read and replay custody", () => {
  it("uses one credential-free GET and recomputable selected pricing", async () => {
    const f = fixture(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(f.body));
    const proof = await readHireModelChoice(f.catalog, fetcher);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(HIRE_MODEL_METADATA_URL, { method: "GET", headers: { Accept: "application/json" }, signal: expect.any(AbortSignal) });
    expect(validHireModelChoice(proof)).toBe(true);
    expect(validHireModelChoice({ ...proof, cheaperModel: "other" })).toBe(false);
    expect(validHireModelChoice({ ...proof, metadataSha256: "" })).toBe(false);
    expect(validHireModelChoice({ ...proof, retrievedAt: "unknown" })).toBe(false);
    expect(validHireModelChoice({ ...proof, targetMaximumRates: { ...proof.targetMaximumRates, prompt: "0" } })).toBe(false);
  });
  it("rejects an oversized metadata response without any model call", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(512 * 1024 + 1)));
    await expect(readHireModelChoice(fixture().catalog, fetcher)).rejects.toThrow("read limit"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects an unavailable public catalog without retry or credential fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(readHireModelChoice(fixture().catalog, fetcher)).rejects.toThrow("could not be read"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// Official credential-free metadata retrieved 2026-11-03T03:51:08Z from
// https://openrouter.ai/api/v1/models?q=deepseek-v4&output_modalities=text
// Full response SHA256: c0164b41a523e3deab39b09d8387fc7a313f5cf723c8f4d70e4461fec789d45c.
// This frozen regression is not a substitute for the case's fresh metadata GET.
const officialRecords: Array<{id: string; pricing: Record<string, unknown>}> = [
  {
    "id": "deepseek/deepseek-v4-pro-0813",
    "pricing": {
      "prompt": "0.000000115",
      "completion": "0.000004",
      "input_cache_read": "0.00000011"
    }
  },
  {
    "id": "deepseek/deepseek-v4-pro",
    "pricing": {
      "prompt": "0.0000016",
      "completion": "0.0000032",
      "input_cache_read": "0.000000135"
    }
  },
  {
    "id": "deepseek/deepseek-v4.1-flash-1017",
    "pricing": {
      "prompt": "0.0000003",
      "completion": "0.0000012",
      "input_cache_read": "0.000000006",
      "overrides": [
        {
          "utc_days": [
            "saturday",
            "sunday"
          ],
          "prompt": "0.00000015",
          "completion": "0.0000006",
          "input_cache_read": "0.000000003"
        },
        {
          "utc_days": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday"
          ],
          "utc_start": 0,
          "utc_end": 100,
          "prompt": "0.00000015",
          "completion": "0.0000006",
          "input_cache_read": "0.000000003"
        },
        {
          "utc_days": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday"
          ],
          "utc_start": 100,
          "utc_end": 400,
          "prompt": "0.0000003",
          "completion": "0.0000012",
          "input_cache_read": "0.000000006"
        },
        {
          "utc_days": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday"
          ],
          "utc_start": 400,
          "utc_end": 600,
          "prompt": "0.00000015",
          "completion": "0.0000006",
          "input_cache_read": "0.000000003"
        },
        {
          "utc_days": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday"
          ],
          "utc_start": 600,
          "utc_end": 1000,
          "prompt": "0.0000003",
          "completion": "0.0000012",
          "input_cache_read": "0.000000006"
        },
        {
          "utc_days": [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday"
          ],
          "utc_start": 1000,
          "utc_end": 0,
          "prompt": "0.00000015",
          "completion": "0.0000006",
          "input_cache_read": "0.000000003"
        }
      ]
    }
  }
];
it("the actual official rate records admit the genuine expensive starting model, not the dated counterpart", () => {
  const proof = proveHireModelChoice({ data: officialRecords }, officialRecords.map(row => ({ id: `openrouter/${row.id}` })));
  expect(proof.originalModel).toBe("openrouter/deepseek/deepseek-v4-pro");
  expect(proof.cheaperModel).toBe(CHAT_OPENCODE_MODEL);
  expect(proof.targetMaximumRates).toEqual({ prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000006" });
  expect(proof.originalMinimumRates).toEqual({ prompt: "0.0000016", completion: "0.0000032", input_cache_read: "0.000000135" });
  expect(proof.targetRateVariants).toBe(7);
});
it.each(["no longer cheaper", "unknown rate"])("the official-record comparison rejects %s instead of overriding price evidence", fault => {
  const data = structuredClone(officialRecords);
  if (fault === "no longer cheaper") data.find(row => row.id === "deepseek/deepseek-v4-pro")!.pricing.prompt = "0.00000001";
  else data.find(row => row.id === "deepseek/deepseek-v4.1-flash-1017")!.pricing.request = "0";
  expect(() => proveHireModelChoice({ data }, data.map(row => ({ id: `openrouter/${row.id}` })))).toThrow();
});

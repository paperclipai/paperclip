import { describe, expect, it } from "vitest";
import {
  buildOpenCodeSessionDigest,
  compactOpenCodeDigestForStorage,
  decideResumeCompaction,
  estimateOpenCodeSessionTokens,
  parseOpenCodeModelLimitsOutput,
} from "./session-compaction.js";

const VERBOSE_OUTPUT = [
  "litellm/qwen3.8-27b",
  JSON.stringify(
    { id: "qwen3.8-27b", name: "LiteLLM -> SGLang", limit: { context: 128000, output: 32768 } },
    null,
    2,
  ),
  "openai/gpt-5",
  JSON.stringify({ id: "gpt-5", name: "GPT-5", limit: { context: 272000, output: 128000 } }),
].join("\n");

describe("parseOpenCodeModelLimitsOutput", () => {
  it("finds exact provider/model entries in multi-model output", () => {
    expect(parseOpenCodeModelLimitsOutput(VERBOSE_OUTPUT, "litellm/qwen3.8-27b")).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 32768,
    });
    expect(parseOpenCodeModelLimitsOutput(VERBOSE_OUTPUT, "openai/gpt-5")).toEqual({
      contextWindow: 272000,
      maxOutputTokens: 128000,
    });
  });

  it("returns null for uncovered or malformed output", () => {
    expect(parseOpenCodeModelLimitsOutput(VERBOSE_OUTPUT, "openai/gpt-6")).toBeNull();
    expect(parseOpenCodeModelLimitsOutput("no models here", "litellm/qwen3.8-27b")).toBeNull();
    expect(parseOpenCodeModelLimitsOutput("litellm/x\n{not json", "litellm/x")).toBeNull();
  });
});

describe("estimateOpenCodeSessionTokens", () => {
  it("ceil(chars / 4)", () => {
    expect(estimateOpenCodeSessionTokens("x".repeat(8000))).toBe(2000);
    expect(estimateOpenCodeSessionTokens("x".repeat(9))).toBe(3);
  });
});

describe("decideResumeCompaction", () => {
  const base = { contextWindow: 128000, maxOutputTokens: 32768, freshPromptChars: 8000 };

  it("compacts oversized history", () => {
    expect(decideResumeCompaction({ ...base, estimateTokens: 80000 }).compact).toBe(true);
  });

  it("keeps small history", () => {
    expect(decideResumeCompaction({ ...base, estimateTokens: 50000 }).compact).toBe(false);
  });

  it("treats unknown size as overflow", () => {
    expect(decideResumeCompaction({ ...base, estimateTokens: null }).compact).toBe(true);
  });

  it("computes the digest budget with a floor", () => {
    // 128000 - 32768 - 16000 - ceil(8000 / 4) = 77232
    expect(decideResumeCompaction({ ...base, estimateTokens: 50000 }).digestTokenBudget).toBe(77232);
    const small = decideResumeCompaction({
      estimateTokens: null,
      contextWindow: 4000,
      maxOutputTokens: 32768,
      freshPromptChars: 0,
    });
    expect(small.digestTokenBudget).toBe(4000);
  });
});

describe("buildOpenCodeSessionDigest", () => {
  const exportJson = JSON.stringify({
    info: { id: "ses_1" },
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "fix the login bug" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "I traced it to the token refresh." }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "z".repeat(3000) }] },
    ],
  });

  it("keeps the newest turns that fit the budget, oldest first", () => {
    const full = buildOpenCodeSessionDigest(exportJson, 20000, "ses_1");
    expect(full).toContain("was compacted");
    expect(full.indexOf("turn 1")).toBeLessThan(full.indexOf("turn 2"));
    expect(full.indexOf("turn 2")).toBeLessThan(full.indexOf("turn 3"));
    expect(full).toContain("fix the login bug");

    const tight = buildOpenCodeSessionDigest(exportJson, 400, "ses_1");
    expect(tight).not.toContain("turn 1");
    expect(tight).toContain("turn 3");
    expect(tight.length).toBeLessThanOrEqual(400 + 40);
  });

  it("drops all turns when the budget only fits the header", () => {
    expect(buildOpenCodeSessionDigest(exportJson, 0, "ses_1")).toContain("no earlier turns retained");
  });

  it("falls back to a note when the export is unparseable", () => {
    expect(buildOpenCodeSessionDigest("{oops", 500, "ses_1")).toContain("could not be parsed");
  });
});

describe("compactOpenCodeDigestForStorage", () => {
  it("passes short digests through and tail-truncates long ones", () => {
    const short = "keep me";
    expect(compactOpenCodeDigestForStorage(short)).toBe(short);
    const long = "y".repeat(20000);
    const capped = compactOpenCodeDigestForStorage(long);
    expect(capped.length).toBeLessThanOrEqual(12000);
    expect(capped.startsWith("…[older digest truncated]")).toBe(true);
    expect(capped.endsWith("y")).toBe(true);
  });
});

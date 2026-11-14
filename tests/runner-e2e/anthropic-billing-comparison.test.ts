import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { billingCsv, compareAnthropicBilling, writeAnthropicBillingComparison, type AnthropicBillingComparisonConfig } from "./anthropic-billing-comparison.js";
import { openEvalCostLedger } from "./cost-ledger.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const usageHeader = "usage_date_utc,model_version,api_key,workspace,usage_type,context_window,usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read,usage_output_tokens,web_search_count,inference_geo,speed\n";
const usageRow = '2020-01-02 12:00,claude-sonnet-5,"key, label",workspace,standard,≤ 200k,20,100,0,30,8,0,global,standard\n';
const costHeader = "usage_date_utc,model,workspace,api_key,usage_type,context_window,token_type,cost_usd,list_price_usd,cost_type,inference_geo,speed,api_key_id,api_key_status\n";
const costRows = ["input_no_cache", "input_cache_read", "input_cache_write_5m", "input_cache_write_1h", "output"].map(token =>
  `2020-01-02,Claude Sonnet 5,workspace,"key, label",message,≤ 200k,${token},0.00,0.00,token,global,standard,key-id,\n`).join("");

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "billing-comparison-")); roots.push(root);
  const config: AnthropicBillingComparisonConfig = { version: 1, manifest: path.join(root, "manifest.json"), ledger: path.join(root, "ledger.jsonl"),
    usageExport: path.join(root, "usage.csv"), costExport: path.join(root, "cost.csv"), workspace: "workspace", apiKeyLabel: "key, label",
    date: "2020-01-02", sourceDataAsOf: "2020-01-03T01:00:00Z" };
  const limits = { campaignId: "comparison", maxUsd: "10", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 1 };
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2020-01-02T12:05:00Z"));
  const ledger = await openEvalCostLedger(config.ledger, limits);
  const observation = { observationId: "provider-1", requestId: "complete", provider: "anthropic", model: "claude-sonnet-5", source: "provider" as const,
    currency: "USD" as const, route: "braintrust" as const, classification: "estimated" as const, pricingVersion: "fixture", costUsd: "0.000326",
    tokens: { input: 10, cachedWrite: 100, cachedRead: 30, output: 5 }, final: true };
  try {
    await ledger.reserve("complete", { executionId: "cell", attemptId: "attempt", phase: "setup" }, "1");
    await ledger.observe(observation);
    await ledger.observe({ ...observation, observationId: "gateway-1", source: "gateway" });
    await ledger.finish("complete", "succeeded");
    await ledger.reserve("cancelled", { executionId: "cell", attemptId: "attempt", phase: "agent" }, "1");
    await ledger.observe({ observationId: "cancelled-usage", requestId: "cancelled", provider: "anthropic",
      source: "gateway", currency: "USD", route: "braintrust", classification: "unknown", final: false });
    await ledger.finish("cancelled", "cancelled");
  } finally { await ledger.close(); clock.mockRestore(); }
  const price = { provider: "anthropic", model: "claude-sonnet-5", version: "fixture", sourceUrl: "https://example.test/prices",
    inputUsdPerMillion: "2", cachedReadUsdPerMillion: "0.2", cacheWrite5mUsdPerMillion: "2.5", cacheWrite1hUsdPerMillion: "4", outputUsdPerMillion: "10" };
  await Promise.all([
    writeFile(config.manifest, JSON.stringify({ version: 1, limits, executionIds: ["cell"], models: [{ provider: "anthropic", price }] })),
    writeFile(config.usageExport, usageHeader + usageRow), writeFile(config.costExport, costHeader + costRows),
  ]);
  return { config, root, limits, observation };
}

it("compares provider usage once, keeps the cancelled residual explicit, and preserves the journal", async () => {
  const { config, root } = await fixture(), before = await readFile(config.ledger);
  const configFile = path.join(root, "config.json"), output = path.join(root, "comparison.json");
  await writeFile(configFile, JSON.stringify(config));
  const result = await writeAnthropicBillingComparison(configFile, output);
  expect(result).toMatchObject({
    provider: { tokenEstimateUsd: "0.000376000", roundedTokenCostUsd: "0.000000000", tokenEstimateConsistentWithRoundedCost: true },
    retained: { requests: 2, completeRequests: 1, missingTokenRequests: 1, partialTokenRequests: 0, unconfirmedModelRequests: 1, knownUsd: "0.000326000",
      observedTokens: { input: 10, cachedRead: 30, cachedWrite: 100, output: 5 } },
    difference: { tokens: { input: 10, cachedRead: 0, cachedWrite: 0, output: 3 }, estimatedUsd: "0.000050000" },
    invoiceReconciled: false, requestCostsAllocated: false, holdsReleased: false,
  });
  expect(result.sources).toHaveLength(4);
  expect(result.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
  expect(await readFile(config.ledger)).toEqual(before);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(await readFile(output, "utf8")).not.toContain("key, label");
  await expect(writeAnthropicBillingComparison(configFile, output)).rejects.toThrow("EEXIST");
  expect(await readFile(config.ledger)).toEqual(before);
});

it("retains partial tokens once and exposes a negative provider difference", async () => {
  const { config, limits, observation } = await fixture();
  const ledger = await openEvalCostLedger(config.ledger, limits);
  try {
    await ledger.observe({ ...observation, observationId: "partial", requestId: "cancelled", final: false,
      costUsd: "0.000100", tokens: { input: 40, cachedRead: 0, cachedWrite: 0, output: 2 } });
  } finally { await ledger.close(); }
  expect(await compareAnthropicBilling(config)).toMatchObject({ retained: { partialTokenRequests: 1, missingTokenRequests: 0, knownUsd: "0.000426000" },
    difference: { tokens: { input: -30, output: 1 }, estimatedUsd: "-0.000050000" } });
});

it.each([
  [{ input: 40 }, { input: 0, cachedRead: 1, cachedWrite: 1, output: 1 }, 5],
  [{ input: 40, cachedRead: 0, cachedWrite: 0, output: 2 }, { input: 0, cachedRead: 0, cachedWrite: 0, output: 0 }, 7],
])("preserves known token fields on unpriced partial receipts", async (tokens, missingFields, expectedOutput) => {
  const { config, limits } = await fixture();
  const ledger = await openEvalCostLedger(config.ledger, limits);
  try {
    await ledger.observe({ observationId: "unpriced-token-evidence", requestId: "cancelled", provider: "anthropic", source: "gateway",
      currency: "USD", route: "braintrust", classification: "unknown", tokens, final: false });
  } finally { await ledger.close(); }
  expect(await compareAnthropicBilling(config)).toMatchObject({ retained: { partialTokenRequests: 1, missingTokenRequests: 0,
    knownUsd: "0.000326000", observedTokens: { input: 50, output: expectedOutput }, missingTokenFields: missingFields },
    difference: { tokens: { input: -30 } }, holdsReleased: false });
});

it("prefers final token evidence while preserving an unknown dollar cost", async () => {
  const { config, limits } = await fixture();
  const ledger = await openEvalCostLedger(config.ledger, limits);
  const observation = { requestId: "cancelled", provider: "anthropic", model: "claude-sonnet-5", source: "gateway" as const,
    currency: "USD" as const, route: "braintrust" as const, classification: "unknown" as const };
  try {
    await ledger.observe({ ...observation, observationId: "earlier", tokens: { input: 40, output: 1 }, final: false });
    await ledger.observe({ ...observation, observationId: "final-unpriced", tokens: { input: 40, cachedRead: 0, cachedWrite: 0, output: 2 }, final: true });
  } finally { await ledger.close(); }
  expect(await compareAnthropicBilling(config)).toMatchObject({ retained: { completeRequests: 1, completeTokenRequests: 2,
    partialTokenRequests: 0, missingTokenRequests: 0, knownUsd: "0.000326000", observedTokens: { input: 50, output: 7 },
    missingTokenFields: { input: 0, cachedRead: 0, cachedWrite: 0, output: 0 } } });
});

it("rejects duplicate token observations that disagree despite equal cost", async () => {
  const { config, limits, observation } = await fixture();
  const ledger = await openEvalCostLedger(config.ledger, limits);
  try { await ledger.observe({ ...observation, observationId: "contradiction", tokens: { ...observation.tokens, output: 6 } }); }
  finally { await ledger.close(); }
  await expect(compareAnthropicBilling(config)).rejects.toThrow("disagree on tokens");
});

it.each([
  ["mixed workspace", usageRow.replace(",workspace,", ",other,"), "different workspace"],
  ["batch price", usageRow.replace(",standard,≤", ",batch,≤"), "Unsupported usage"],
  ["long context", usageRow.replace("≤ 200k", "> 200k"), "pricing dimensions"],
  ["geography", usageRow.replace(",global,", ",us,"), "pricing dimensions"],
  ["negative tokens", usageRow.replace(",20,100,", ",-20,100,"), "token count"],
  ["duplicate row", usageRow + usageRow, "Duplicate usage"],
  ["different date", usageRow.replace("2020-01-02", "2020-01-01"), "date"],
])("rejects %s instead of silently filtering the export", async (_name, rows, error) => {
  const { config } = await fixture(); await writeFile(config.usageExport, usageHeader + rows);
  await expect(compareAnthropicBilling(config)).rejects.toThrow(error);
});

it("requires complete cost categories and preserves separate non-model costs", async () => {
  const { config } = await fixture();
  await writeFile(config.costExport, costHeader + costRows.split("\n").slice(0, 4).join("\n"));
  await expect(compareAnthropicBilling(config)).rejects.toThrow("all five token categories");
  await writeFile(config.costExport, costHeader + costRows + '2020-01-02,--,workspace,"key, label",--,--,--,0.25,0.25,web_search,--,--,key-id,\n');
  expect(await compareAnthropicBilling(config)).toMatchObject({ provider: { roundedOtherCostUsd: "0.250000000", tokenEstimateUsd: "0.000376000" } });
});

it("rejects a future snapshot, changed campaign identity and incomplete journal", async () => {
  const { config } = await fixture();
  await expect(compareAnthropicBilling({ ...config, sourceDataAsOf: "2099-01-01T00:00:00Z" })).rejects.toThrow("reporting window");
  const manifest = JSON.parse(await readFile(config.manifest, "utf8"));
  manifest.limits.campaignId = "other"; await writeFile(config.manifest, JSON.stringify(manifest));
  await expect(compareAnthropicBilling(config)).rejects.toThrow("campaign model");
  manifest.limits.campaignId = "comparison"; await writeFile(config.manifest, JSON.stringify(manifest));
  await writeFile(config.ledger, '{"partial":', { flag: "a" });
  const before = await readFile(config.ledger);
  await expect(compareAnthropicBilling(config)).rejects.toThrow("durable record");
  expect(await readFile(config.ledger)).toEqual(before);
});

it("parses quoted commas, escaped quotes, newlines and CRLF while rejecting malformed CSV", () => {
  expect(billingCsv('\uFEFFa,b\r\n"x,y","z""q"\r\n"line\nnext",end')).toEqual([{ a: "x,y", b: 'z"q' }, { a: "line\nnext", b: "end" }]);
  for (const source of ['a,a\n1,2', 'a,b\n1', 'a,b\n"x"tail,y', 'a,b\n"unterminated,y']) expect(() => billingCsv(source)).toThrow();
});

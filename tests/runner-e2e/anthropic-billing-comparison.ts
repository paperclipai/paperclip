import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { usdToUnits } from "../../packages/shared/src/money.js";
import { readEvalCostLedger, validEvalLedgerId } from "./cost-ledger.js";
import { estimateProviderCost, type EvalModelPrice } from "./provider-usage.js";

export interface AnthropicBillingComparisonConfig {
  version: 1;
  manifest: string;
  ledger: string;
  usageExport: string;
  costExport: string;
  workspace: string;
  apiKeyLabel: string;
  date: string;
  sourceDataAsOf: string;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const money = (value: bigint) => `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 1_000_000_000n}.${String((value < 0n ? -value : value) % 1_000_000_000n).padStart(9, "0")}`;
const tokenKeys = ["input", "cachedRead", "cachedWrite", "output"] as const;
type Tokens = Record<typeof tokenKeys[number], number>;
const emptyTokens = (): Tokens => ({ input: 0, cachedRead: 0, cachedWrite: 0, output: 0 });
const addTokens = (target: Tokens, source: Tokens) => {
  for (const key of tokenKeys) {
    if (!Number.isSafeInteger(source[key]) || source[key] < 0 || !Number.isSafeInteger(target[key] + source[key])) throw new Error("Invalid or overflowing token count");
    target[key] += source[key];
  }
};
const count = (value: string | undefined) => {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid exported token count");
  return Number(value);
};

export function billingCsv(source: string): Record<string, string>[] {
  if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new Error("Billing CSV exceeds 8 MiB");
  const rows: string[][] = [], row: string[] = [];
  let cell = "", quoted = false, closed = false;
  const text = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ""; closed = false;
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rows.push(row.splice(0));
      }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error("Malformed quoted billing CSV");
      cell += c;
    }
  }
  if (quoted) throw new Error("Unterminated billing CSV field");
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  const headers = rows.shift();
  if (!headers?.length || headers.some(value => !value) || new Set(headers).size !== headers.length || !rows.length) throw new Error("Billing CSV requires unique headers and data");
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error("Billing CSV column count changed");
    return Object.fromEntries(headers.map((key, i) => [key, values[i]!]));
  });
}

async function boundedFile(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("Comparison input must be a file of at most 8 MiB");
  const bytes = await readFile(file);
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Comparison input grew beyond 8 MiB");
  return bytes;
}

export async function compareAnthropicBilling(config: AnthropicBillingComparisonConfig, now = Date.now()) {
  if (!config || typeof config !== "object" || Array.isArray(config) || config.version !== 1
      || Object.keys(config).some(key => !["version", "manifest", "ledger", "usageExport", "costExport", "workspace", "apiKeyLabel", "date", "sourceDataAsOf"].includes(key))
      || [config.manifest, config.ledger, config.usageExport, config.costExport, config.workspace, config.apiKeyLabel].some(value => typeof value !== "string" || !value || value.length > 4096)
      || !/^\d{4}-\d{2}-\d{2}$/.test(config.date) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(config.sourceDataAsOf)) throw new Error("Invalid billing comparison config");
  const startedAt = Date.parse(`${config.date}T00:00:00Z`), asOf = Date.parse(config.sourceDataAsOf), endedAt = startedAt + 86_400_000;
  if (!Number.isFinite(startedAt) || new Date(startedAt).toISOString().slice(0, 10) !== config.date
      || !Number.isFinite(asOf) || asOf < startedAt || asOf > now) throw new Error("Invalid export reporting window");
  const [manifestBytes, ledgerBytes, usageBytes, costBytes] = await Promise.all([
    boundedFile(config.manifest), boundedFile(config.ledger), boundedFile(config.usageExport), boundedFile(config.costExport),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const loaded = await readEvalCostLedger(config.ledger), snapshot = loaded.state.snapshot();
  const lines = ledgerBytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  if (lines.at(-1)?.hash !== loaded.previous || lines.length !== loaded.sequence) throw new Error("Ledger changed during comparison");
  if (manifest.version !== 1 || manifest.limits?.campaignId !== snapshot.campaignId || !Array.isArray(manifest.models)
      || manifest.models.length !== 1 || manifest.models[0].provider !== "anthropic"
      || !Array.isArray(manifest.executionIds) || !manifest.executionIds.length || manifest.executionIds.some((id: unknown) => !validEvalLedgerId(id))) throw new Error("Comparison requires one Anthropic campaign model");
  const price = manifest.models[0].price as EvalModelPrice;
  if (price?.provider !== "anthropic" || price.model !== "claude-sonnet-5" || !validEvalLedgerId(price.version) || price.longContext) throw new Error("Unsupported Anthropic export price contract");
  const usage = billingCsv(usageBytes.toString("utf8")), costs = billingCsv(costBytes.toString("utf8"));
  const scope = (row: Record<string, string>) => {
    if (row.workspace !== config.workspace || row.api_key !== config.apiKeyLabel) throw new Error("Export contains a different workspace or API key label");
  };
  const dimensions = (row: Record<string, string>) => {
    if (row.context_window !== "≤ 200k" || row.inference_geo !== "global" || row.speed !== "standard") throw new Error("Unsupported export pricing dimensions");
  };
  const providerTokens = emptyTokens(), seenUsage = new Set<string>(), seenCosts = new Set<string>();
  let cacheWrite5m = 0, cacheWrite1h = 0;
  for (const row of usage) {
    scope(row); dimensions(row);
    if (row.model_version !== price.model || row.usage_type !== "standard" || count(row.web_search_count) !== 0
        || !new RegExp(`^${config.date} (?:[01][0-9]|2[0-3]):00$`).test(row.usage_date_utc ?? "")) throw new Error("Unsupported usage row or date");
    const hour = Date.parse(`${row.usage_date_utc!.replace(" ", "T")}:00Z`);
    if (hour + 3_600_000 > asOf) throw new Error("Usage hour is not covered by the source timestamp");
    if (seenUsage.has(row.usage_date_utc!)) throw new Error("Duplicate usage hour");
    seenUsage.add(row.usage_date_utc!);
    const five = count(row.usage_input_tokens_cache_write_5m), one = count(row.usage_input_tokens_cache_write_1h);
    addTokens(providerTokens, { input: count(row.usage_input_tokens_no_cache), cachedRead: count(row.usage_input_tokens_cache_read),
      cachedWrite: five + one, output: count(row.usage_output_tokens) });
    cacheWrite5m += five; cacheWrite1h += one;
  }
  let roundedTokenCost = 0n, roundedOtherCost = 0n, roundingLower = 0n, roundingUpper = 0n;
  const keyIds = new Set<string>();
  for (const row of costs) {
    scope(row);
    if (row.usage_date_utc !== config.date || !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(row.cost_usd ?? "")
        || !validEvalLedgerId(row.api_key_id)) throw new Error("Invalid daily cost row");
    keyIds.add(row.api_key_id);
    const identity = JSON.stringify([row.cost_type, row.model, row.token_type]);
    if (seenCosts.has(identity)) throw new Error("Duplicate daily cost row");
    seenCosts.add(identity);
    const value = usdToUnits(row.cost_usd!);
    if (row.cost_type === "token") {
      dimensions(row);
      if (row.model !== "Claude Sonnet 5" || row.usage_type !== "message" || !["input_no_cache", "input_cache_read", "input_cache_write_5m", "input_cache_write_1h", "output"].includes(row.token_type ?? "")) throw new Error("Unsupported token cost row");
      roundedTokenCost += value;
      roundingLower += value > 5_000_000n ? value - 5_000_000n : 0n;
      roundingUpper += value + 5_000_000n;
    } else {
      if (!["code_execution", "session_runtime", "web_search"].includes(row.cost_type ?? "") || row.model !== "--" || row.token_type !== "--") throw new Error("Unsupported non-model cost row");
      roundedOtherCost += value;
    }
  }
  if (keyIds.size !== 1 || [...seenCosts].filter(key => JSON.parse(key)[0] === "token").length !== 5) throw new Error("Cost export lacks one key and all five token categories");
  const providerCost = estimateProviderCost({ provider: "anthropic", model: price.model, complete: true, tokens: providerTokens,
    cacheWrite5m, cacheWrite1h }, price);
  if (providerCost === null) throw new Error("Provider usage cannot be priced");
  const observedTokens = emptyTokens(), completeTokens = emptyTokens(), missingTokenFields = emptyTokens();
  const retained = { requests: 0, completeRequests: 0, completeTokenRequests: 0, partialTokenRequests: 0, missingTokenRequests: 0, unconfirmedModelRequests: 0, knownUsd: 0n };
  for (const request of snapshot.requests) {
    if (request.phase === "infrastructure") continue;
    if (!manifest.executionIds.includes(request.executionId)) throw new Error("Ledger execution is outside the manifest selection");
    const reserved = lines.find(line => line.event.type === "reserve" && line.event.requestId === request.requestId);
    const finished = lines.filter(line => line.event.type === "finish" && line.event.requestId === request.requestId).at(-1);
    if (!reserved || Date.parse(reserved.at) < startedAt || Date.parse(reserved.at) >= endedAt || !finished
        || Date.parse(finished.at) >= endedAt || Date.parse(finished.at) > asOf) throw new Error("Ledger request is outside the completed comparison window");
    const observations = loaded.state.requests.get(request.requestId)!.observations;
    if (!observations.length || observations.some(row => row.provider !== "anthropic"
        || row.model !== price.model && !(row.model === undefined && row.classification === "unknown" && !row.final))) throw new Error("Ledger contains unclassified or different model requests");
    if (observations.every(row => row.model === undefined)) retained.unconfirmedModelRequests++;
    if (request.conflict) throw new Error("Ledger cost observations conflict");
    retained.requests++;
    if (request.receiptComplete) retained.completeRequests++;
    retained.knownUsd += usdToUnits(request.costUsd ?? "0");
    const tokenEvidence = observations.filter(row => row.tokens && tokenKeys.some(key => row.tokens![key] !== undefined));
    const selected = emptyTokens();
    for (const key of tokenKeys) {
      const present = tokenEvidence.filter(row => row.tokens![key] !== undefined);
      const finalized = present.filter(row => row.final);
      const values = new Set((finalized.length ? finalized : present).map(row => row.tokens![key]!));
      if (values.size > 1) throw new Error("Duplicate observations disagree on tokens");
      if (values.size) selected[key] = [...values][0]!;
      else missingTokenFields[key]++;
    }
    addTokens(observedTokens, selected);
    if (!tokenEvidence.length) retained.missingTokenRequests++;
    else if (tokenEvidence.some(row => row.final && tokenKeys.every(key => row.tokens![key] !== undefined))) {
      retained.completeTokenRequests++;
      addTokens(completeTokens, selected);
    } else retained.partialTokenRequests++;
  }
  if (!retained.requests) throw new Error("Ledger has no comparable model requests");
  const sources = [
    ["manifest", manifestBytes], ["ledger", ledgerBytes], ["usage_export", usageBytes], ["cost_export", costBytes],
  ] as const;
  const priced = usdToUnits(providerCost);
  return {
    version: 1, kind: "anthropic_provider_window_comparison", campaignId: snapshot.campaignId,
    observedAt: new Date(now).toISOString(), sourceDataAsOf: config.sourceDataAsOf,
    window: { startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), currentDayPartial: asOf < endedAt },
    scopeSha256: hash(JSON.stringify([config.workspace, config.apiKeyLabel, [...keyIds][0]])),
    sources: sources.map(([kind, bytes]) => ({ kind, sha256: hash(bytes) })), journalHash: loaded.previous,
    model: price.model, pricingVersion: price.version,
    provider: { tokens: providerTokens, cacheWrite5m, cacheWrite1h, tokenEstimateUsd: providerCost,
      roundedTokenCostUsd: money(roundedTokenCost), roundedOtherCostUsd: money(roundedOtherCost),
      roundedTokenCostIntervalUsd: { lowerInclusive: money(roundingLower), upperExclusive: money(roundingUpper) },
      tokenEstimateConsistentWithRoundedCost: priced >= roundingLower && priced < roundingUpper },
    retained: { ...retained, knownUsd: money(retained.knownUsd), observedTokens, completeTokens, missingTokenFields },
    difference: { tokens: Object.fromEntries(tokenKeys.map(key => [key, providerTokens[key] - observedTokens[key]])),
      estimatedUsd: money(priced - retained.knownUsd) },
    invoiceReconciled: false, requestCostsAllocated: false, holdsReleased: false,
    limitations: [
      "This is a scope/window comparison. Matching labels do not prove that the dedicated key had no other use.",
      "Provider exports can lag and round costs. Token pricing uses the retained manifest, not an invoice or discount calculation.",
      "Each known token category counts at most once per request, independently of cost. Final token evidence takes precedence; missing fields and partial receipts remain explicit.",
      "Do not add the provider total to the retained subtotal or distribute their difference across requests. Journals and admission holds are unchanged.",
      "Non-model export charges, infrastructure, storage and tracing remain separate from the model token comparison.",
    ],
  };
}

export async function writeAnthropicBillingComparison(configPath: string, output: string) {
  const config = JSON.parse((await boundedFile(configPath)).toString("utf8")) as AnthropicBillingComparisonConfig;
  const comparison = await compareAnthropicBilling(config);
  await writeFile(path.resolve(output), `${JSON.stringify(comparison, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return comparison;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [config, output, ...extra] = process.argv.slice(2);
  if (!config || !output || extra.length) throw new Error("Usage: anthropic-billing-comparison.ts <private-config.json> <new-private-output.json>");
  const result = await writeAnthropicBillingComparison(config, output);
  console.log(JSON.stringify({ campaignId: result.campaignId, tokenEstimateUsd: result.provider.tokenEstimateUsd,
    unmatchedEstimateUsd: result.difference.estimatedUsd, invoiceReconciled: false, holdsReleased: false }));
}

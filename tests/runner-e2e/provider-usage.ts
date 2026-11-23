import { usdToUnits } from "../../packages/shared/src/money.js";
import { validEvalLedgerId, type EvalCostObservation } from "./cost-ledger.js";

type Tokens = NonNullable<EvalCostObservation["tokens"]>;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export interface ProviderUsageReceipt {
  provider: "openai" | "anthropic";
  tokens: Tokens;
  complete: boolean;
  tokenBounds?: { input: number; output: number; valid: boolean };
  providerResponseId?: string;
  model?: string;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWrite30m?: number;
  cacheWrite12h?: number;
  cacheWriteAttribution?: { source: "request_policy"; version: "openai-prompt-cache-2026-10-20"; ttl: "30m" | "12h" };
}

function openAiRequestCachePolicy(payload: unknown): { model: string; ttl: "30m" | "12h" } | undefined {
  const body = row(payload);
  if (body.model !== "gpt-5.6-sol" || body.previous_response_id !== undefined || body.conversation !== undefined || body.prompt !== undefined
      || body.context_management !== undefined || !(typeof body.input === "string" || Array.isArray(body.input))) return;
  const options = row(body.prompt_cache_options);
  if (body.prompt_cache_options !== undefined && body.prompt_cache_options !== options) return;
  if (Object.keys(options).some(key => !["mode", "ttl"].includes(key)) || options.mode !== undefined && options.mode !== "implicit") return;
  const ttl = options.ttl === undefined ? "30m" : options.ttl;
  if (ttl !== "30m" && ttl !== "12h") return;
  const hasUnqualifiedInput = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasUnqualifiedInput);
    if (!value || typeof value !== "object") return false;
    const item = row(value);
    return "prompt_cache_breakpoint" in item || item.type === "compaction" || item.type === "item_reference"
      || Object.values(item).some(hasUnqualifiedInput);
  };
  if (hasUnqualifiedInput(body.input)) return;
  return { model: body.model, ttl };
}

function tokenBounds(provider: "openai" | "anthropic", usage: Row) {
  const input = row(usage.input_tokens_details), output = row(usage.output_tokens_details);
  const writes = provider === "openai" ? row(input.cache_write_tokens_details) : row(usage.cache_creation);
  const rawWrite = provider === "openai" ? input.cache_write_tokens : usage.cache_creation_input_tokens;
  const rawRead = provider === "openai" ? input.cached_tokens : usage.cache_read_input_tokens;
  const ttls = provider === "openai" ? [writes.ttl_30m_tokens, writes.ttl_12h_tokens]
    : [writes.ephemeral_5m_input_tokens, writes.ephemeral_1h_input_tokens];
  const inputs = [usage.input_tokens, rawRead, rawWrite, ...ttls];
  const outputs = [usage.output_tokens, ...(provider === "openai" ? [output.reasoning_tokens] : [])];
  const value = (raw: unknown) => count(raw) ?? 0;
  const cached = value(rawRead) + Math.max(value(rawWrite), value(ttls[0]) + value(ttls[1]));
  const inputBound = provider === "openai" ? Math.max(value(usage.input_tokens), cached) : value(usage.input_tokens) + cached;
  const outputBound = Math.max(...outputs.map(value));
  return { input: inputBound, output: outputBound,
    valid: [...inputs, ...outputs].every(raw => raw === undefined || count(raw) !== undefined)
      && Number.isSafeInteger(inputBound) && Number.isSafeInteger(outputBound) };
}

export function normalizeProviderUsage(provider: "openai" | "anthropic", payload: unknown): ProviderUsageReceipt {
  const body = row(payload), usage = row(body.usage);
  const output = count(usage.output_tokens);
  let tokens: Tokens;
  let cacheWrite5m: number | undefined, cacheWrite1h: number | undefined;
  let cacheWrite30m: number | undefined, cacheWrite12h: number | undefined;
  if (provider === "openai") {
    const totalInput = count(usage.input_tokens);
    const details = row(usage.input_tokens_details);
    const cachedRead = count(details.cached_tokens);
    let cachedWrite = count(details.cache_write_tokens);
    const writes = row(details.cache_write_tokens_details);
    cacheWrite30m = count(writes.ttl_30m_tokens);
    cacheWrite12h = count(writes.ttl_12h_tokens);
    if (cachedWrite !== undefined && cacheWrite30m !== undefined && cacheWrite12h !== undefined && cacheWrite30m + cacheWrite12h !== cachedWrite) cachedWrite = undefined;
    const reasoning = count(row(usage.output_tokens_details).reasoning_tokens);
    tokens = { input: totalInput !== undefined && cachedRead !== undefined && cachedWrite !== undefined && totalInput >= cachedRead + cachedWrite ? totalInput - cachedRead - cachedWrite : undefined,
      cachedRead, cachedWrite, output, reasoning };
  } else {
    const cache = row(usage.cache_creation);
    cacheWrite5m = count(cache.ephemeral_5m_input_tokens);
    cacheWrite1h = count(cache.ephemeral_1h_input_tokens);
    tokens = { input: count(usage.input_tokens), cachedRead: count(usage.cache_read_input_tokens), cachedWrite: count(usage.cache_creation_input_tokens), output };
    if (tokens.cachedWrite !== undefined && cacheWrite5m !== undefined && cacheWrite1h !== undefined && cacheWrite5m + cacheWrite1h !== tokens.cachedWrite) tokens.cachedWrite = undefined;
  }
  const complete = tokens.input !== undefined && tokens.cachedRead !== undefined && tokens.cachedWrite !== undefined && output !== undefined
    && !(tokens.reasoning !== undefined && tokens.reasoning > output);
  return { provider, tokenBounds: tokenBounds(provider, usage), tokens: Object.fromEntries(Object.entries(tokens).filter(([, value]) => value !== undefined)), complete,
    ...(typeof body.id === "string" ? { providerResponseId: body.id } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}), ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    ...(cacheWrite30m !== undefined ? { cacheWrite30m } : {}), ...(cacheWrite12h !== undefined ? { cacheWrite12h } : {}) };
}

export class ProviderUsageAccumulator {
  private body: Row = {};
  private usage: Row = {};
  private final = false;
  private readonly cachePolicy: ReturnType<typeof openAiRequestCachePolicy>;
  constructor(readonly provider: "openai" | "anthropic", request?: unknown,
    private readonly price?: Pick<EvalModelPrice, "provider" | "model" | "responseModels">) {
    this.cachePolicy = provider === "openai" ? openAiRequestCachePolicy(request) : undefined;
  }
  observe(event: unknown) {
    const value = row(event);
    if (this.provider === "openai") {
      const response = row(value.response);
      if (["response.completed", "response.incomplete", "response.failed"].includes(String(value.type))) {
        this.body = response;
        this.usage = row(response.usage);
        this.final = true;
      } else if (value.object === "response") {
        this.body = value;
        this.usage = row(value.usage);
        this.final = ["completed", "incomplete", "failed"].includes(String(value.status));
      }
    } else {
      if (value.type === "message_start") {
        this.body = row(value.message);
        this.usage = { ...this.usage, ...row(this.body.usage) };
      } else if (value.type === "message_delta") this.usage = { ...this.usage, ...row(value.usage) };
      else if (value.type === "message_stop") this.final = true;
      else if (value.type === "message") { this.body = value; this.usage = row(value.usage); this.final = true; }
    }
  }
  receipt() {
    const receipt = normalizeProviderUsage(this.provider, { ...this.body, usage: this.usage });
    const details = row(this.usage.input_tokens_details);
    const policyMatchesResponse = this.cachePolicy && (receipt.model === this.cachePolicy.model
      || this.price?.provider === this.provider && this.price.model === this.cachePolicy.model && matchesPriceResponseModel(this.price, receipt.model));
    if (this.cachePolicy && policyMatchesResponse && receipt.complete && receipt.tokens.cachedWrite! > 0
        && !("cache_write_tokens_details" in details)) {
      receipt.cacheWrite30m = this.cachePolicy.ttl === "30m" ? receipt.tokens.cachedWrite : 0;
      receipt.cacheWrite12h = this.cachePolicy.ttl === "12h" ? receipt.tokens.cachedWrite : 0;
      receipt.cacheWriteAttribution = { source: "request_policy", version: "openai-prompt-cache-2026-10-20", ttl: this.cachePolicy.ttl };
    }
    return { ...receipt, final: this.final };
  }
}

export interface EvalTokenRates {
  inputUsdPerMillion: string;
  cachedReadUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheWrite5mUsdPerMillion?: string;
  cacheWrite1hUsdPerMillion?: string;
  cacheWrite30mUsdPerMillion?: string;
  cacheWrite12hUsdPerMillion?: string;
}
export interface EvalModelPrice extends EvalTokenRates {
  provider: "openai" | "anthropic";
  model: string;
  responseModels?: string[];
  version: string;
  sourceUrl: string;
  longContext?: { aboveInputTokens: number; rates: EvalTokenRates };
}

export function validatePriceResponseModels(price: Pick<EvalModelPrice, "model" | "responseModels">): void {
  const models = price.responseModels;
  if (models === undefined) return;
  if (!Array.isArray(models) || models.length < 1 || models.length > 16 || new Set(models).size !== models.length) {
    throw new Error("Invalid eval price response model mapping");
  }
  for (const model of models) {
    if (!validEvalLedgerId(model) || model === price.model) throw new Error("Invalid eval price response model mapping");
  }
}

export function matchesPriceResponseModel(price: Pick<EvalModelPrice, "model" | "responseModels">, model: unknown): boolean {
  return typeof model === "string" && (model === price.model || Array.isArray(price.responseModels) && price.responseModels.includes(model));
}

export function estimateProviderCost(receipt: ProviderUsageReceipt, price: EvalModelPrice): string | null {
  if (!receipt.complete || !matchesPriceResponseModel(price, receipt.model) || receipt.provider !== price.provider) return null;
  const { tokens } = receipt;
  const totalInput = tokens.input! + tokens.cachedRead! + tokens.cachedWrite!;
  if (!Number.isSafeInteger(totalInput)) return null;
  const rates = price.longContext && totalInput > price.longContext.aboveInputTokens ? price.longContext.rates : price;
  const priced = (count: number, rate: string) => {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(rate)) throw new Error("Invalid nonnegative model price");
    return BigInt(count) * usdToUnits(rate);
  };
  let numerator = priced(tokens.input!, rates.inputUsdPerMillion) + priced(tokens.cachedRead!, rates.cachedReadUsdPerMillion) + priced(tokens.output!, rates.outputUsdPerMillion);
  if (tokens.cachedWrite! > 0) {
    const counts = receipt.provider === "openai" ? [receipt.cacheWrite30m, receipt.cacheWrite12h] : [receipt.cacheWrite5m, receipt.cacheWrite1h];
    const writeRates = receipt.provider === "openai" ? [rates.cacheWrite30mUsdPerMillion, rates.cacheWrite12hUsdPerMillion] : [rates.cacheWrite5mUsdPerMillion, rates.cacheWrite1hUsdPerMillion];
    if (counts[0] === undefined || counts[1] === undefined || counts[0] + counts[1] !== tokens.cachedWrite || writeRates[0] === undefined || writeRates[1] === undefined) return null;
    numerator += priced(counts[0], writeRates[0]) + priced(counts[1], writeRates[1]);
  }
  const units = (numerator + 999_999n) / 1_000_000n;
  return `${units / 1_000_000_000n}.${String(units % 1_000_000_000n).padStart(9, "0")}`;
}

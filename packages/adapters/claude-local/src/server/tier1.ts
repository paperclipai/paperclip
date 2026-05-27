/**
 * Tier 1 path for the claude_local failover (ROCAA-29).
 *
 * Implements the `Tier1Runner` contract defined in ROCAA-27 acceptance-harness:
 * a one-shot call that (1) fetches the metered Anthropic key from GCP Secret
 * Manager, (2) invokes the Anthropic Messages SDK with the same prompt Tier 0
 * was given, and (3) returns a result shape compatible with `toAdapterResult`.
 *
 * Loop-prevention is enforced by *construction*: this module never calls itself
 * recursively and never invokes the classifier. If the Anthropic SDK itself
 * rate-limits us, the failure is returned to the wiring layer as a normal
 * non-zero result with `biller: "anthropic"` / `billingType: "api_key"`, and the
 * wiring layer surfaces the original Tier 0 error to the caller. No second
 * Tier 1 attempt is ever made.
 *
 * The Anthropic SDK is loaded via dynamic import so consumers without it
 * installed (CI without the metered path enabled) still get a clean error
 * instead of a module-load crash.
 */
import type { AdapterTierTransitionReason } from "@paperclipai/adapter-utils";

import {
  fetchBlueprintWorkerKey,
  SecretFetchError,
  BLUEPRINT_WORKER_SECRET_NAME,
  type SecretFetcherOptions,
  type FetchedSecret,
} from "./secret-fetch.js";

export interface Tier1RunInput {
  /** Prompt forwarded verbatim from Tier 0 (same logical session intent). */
  prompt: string;
  /** Model id to request from Anthropic, e.g. "claude-sonnet-4-6". */
  model: string;
  /** Classifier verdict that triggered this Tier 1 attempt; surfaced in meta only. */
  transitionReason: AdapterTierTransitionReason;
  /** Classifier match text; surfaced in meta only. */
  classifierMatch: string | null;
  /** Optional system prompt forwarded from Tier 0 (instructions bundle contents). */
  system?: string;
  /** Optional per-attempt timeout in ms. Defaults to the Anthropic SDK's own default. */
  timeoutMs?: number;
  /** Optional max tokens for the response. Defaults to 4096 — the Tier 0 prompt is typically short. */
  maxTokens?: number;
}

export interface Tier1RunResult {
  exitCode: 0 | 1;
  biller: "anthropic";
  billingType: "api_key";
  model: string;
  summary: string;
  parsed: Record<string, unknown>;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  costUsd: number;
  /** When `exitCode === 1`, the SDK error message for inclusion in the result. */
  errorMessage?: string;
  /** Stable code if the failure was identifiable, e.g. "secret_fetch_failed", "sdk_unavailable". */
  errorCode?: string;
  /** Operator-facing source of the API key used. */
  secretSource: FetchedSecret["source"];
  /** Operator-facing name of the key, never the value. */
  secretName: string;
}

/** Minimal subset of the Anthropic SDK we depend on. */
export interface AnthropicClientLike {
  messages: {
    create(request: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
      stop_reason?: string;
      model?: string;
      id?: string;
    }>;
  };
}

export interface Tier1RunnerOptions {
  /** Forwarded to the secret fetcher. */
  secretFetcher?: SecretFetcherOptions;
  /**
   * Injection seam used by tests. When provided, this client is used instead of
   * dynamically importing `@anthropic-ai/sdk`. Production code never sets this.
   */
  anthropicClientFactory?: (apiKey: string) => AnthropicClientLike;
}

const DEFAULT_MAX_TOKENS = 4096;

async function loadDefaultAnthropicClient(apiKey: string): Promise<AnthropicClientLike> {
  try {
    // @ts-ignore — optional runtime dependency; resolved at runtime in production hosts.
    const mod = (await import("@anthropic-ai/sdk")) as unknown as {
      default?: new (opts: { apiKey: string }) => AnthropicClientLike;
      Anthropic?: new (opts: { apiKey: string }) => AnthropicClientLike;
    };
    const Ctor = mod.default ?? mod.Anthropic;
    if (!Ctor) {
      throw new Error("Anthropic SDK has neither default nor named `Anthropic` export.");
    }
    return new Ctor({ apiKey });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Tier 1 failover requires @anthropic-ai/sdk. Install it in the host environment ` +
        `(\`pnpm add -F @paperclipai/adapter-claude-local @anthropic-ai/sdk\`). Detail: ${detail}`,
    );
  }
}

function describeSdkError(err: unknown): { message: string; code: string } {
  if (err == null) return { message: "Unknown Tier 1 SDK error", code: "sdk_unknown" };
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const status = typeof obj.status === "number" ? obj.status : null;
    const message =
      typeof obj.message === "string"
        ? obj.message
        : typeof obj.error === "string"
          ? obj.error
          : String(err);
    if (status === 429) return { message, code: "tier1_rate_limit" };
    if (status != null && status >= 500) return { message, code: "tier1_5xx" };
    if (status === 401 || status === 403) return { message, code: "tier1_auth_failed" };
    if (status != null) return { message, code: `tier1_http_${status}` };
    return { message, code: "sdk_other" };
  }
  return { message: String(err), code: "sdk_other" };
}

function extractTextContent(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text: string } => typeof block?.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Cost-estimation table. Pricing is **operator-supplied** via
 * `PAPERCLIP_TIER1_PRICE_<MODEL>_INPUT` / `_OUTPUT` env vars (USD per 1M tokens).
 * We deliberately do not hard-code prices because (a) they drift, and (b) the
 * tier-1 cost reporting is informational; the authoritative biller is whatever
 * Anthropic's API records. Returns 0 when prices are not configured so the run
 * pipeline still gets a non-null `costUsd`.
 */
function estimateCostUsd(input: {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const env = input.env ?? process.env;
  const slug = input.model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const inputPriceRaw = env[`PAPERCLIP_TIER1_PRICE_${slug}_INPUT`];
  const outputPriceRaw = env[`PAPERCLIP_TIER1_PRICE_${slug}_OUTPUT`];
  const inputPrice = Number(inputPriceRaw);
  const outputPrice = Number(outputPriceRaw);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return 0;
  const billableInput = Math.max(input.inputTokens - input.cachedInputTokens, 0);
  return (billableInput * inputPrice + input.outputTokens * outputPrice) / 1_000_000;
}

/**
 * Production `Tier1Runner.runTier1` implementation. One-shot: no internal retries,
 * no recursion, no classifier calls.
 */
export async function runTier1(
  input: Tier1RunInput,
  options: Tier1RunnerOptions = {},
): Promise<Tier1RunResult> {
  // 1. Fetch (or read from cache) the metered API key.
  let secret: FetchedSecret;
  try {
    secret = await fetchBlueprintWorkerKey(options.secretFetcher);
  } catch (err) {
    const message =
      err instanceof SecretFetchError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const code =
      err instanceof SecretFetchError ? `secret_fetch_${err.code}` : "secret_fetch_failed";
    return {
      exitCode: 1,
      biller: "anthropic",
      billingType: "api_key",
      model: input.model,
      summary: "",
      parsed: {
        type: "error",
        subtype: "tier1_secret_fetch_failed",
        message,
      },
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      errorMessage: message,
      errorCode: code,
      secretSource: "gcp_secret_manager",
      secretName: BLUEPRINT_WORKER_SECRET_NAME,
    };
  }

  // 2. Build (or inject) the Anthropic client. The factory closes over the
  //    secret value so it never escapes this function via the return value.
  let client: AnthropicClientLike;
  try {
    const factory =
      options.anthropicClientFactory ?? ((apiKey: string) => loadDefaultAnthropicClient(apiKey));
    const built = factory(secret.value);
    client = built instanceof Promise ? await built : built;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      biller: "anthropic",
      billingType: "api_key",
      model: input.model,
      summary: "",
      parsed: { type: "error", subtype: "tier1_sdk_unavailable", message },
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      errorMessage: message,
      errorCode: "sdk_unavailable",
      secretSource: secret.source,
      secretName: secret.name,
    };
  }

  // 3. Single SDK call. No internal retry loop.
  try {
    const response = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: input.prompt }],
    });

    const usage = {
      inputTokens: Number(response.usage?.input_tokens ?? 0),
      cachedInputTokens: Number(response.usage?.cache_read_input_tokens ?? 0),
      outputTokens: Number(response.usage?.output_tokens ?? 0),
    };
    const summary = extractTextContent(response.content);
    const costUsd = estimateCostUsd({ model: input.model, ...usage });

    return {
      exitCode: 0,
      biller: "anthropic",
      billingType: "api_key",
      model: response.model ?? input.model,
      summary,
      parsed: {
        type: "result",
        subtype: "success",
        result: summary,
        usage: {
          input_tokens: usage.inputTokens,
          cache_read_input_tokens: usage.cachedInputTokens,
          output_tokens: usage.outputTokens,
        },
        // Stamp the tier on the parsed JSON so downstream consumers that only
        // see resultJson can still tell which tier produced the bytes.
        tier: "tier_1_anthropic_sdk",
        stop_reason: response.stop_reason ?? null,
        anthropic_message_id: response.id ?? null,
      },
      usage,
      costUsd,
      secretSource: secret.source,
      secretName: secret.name,
    };
  } catch (err) {
    const { message, code } = describeSdkError(err);
    return {
      exitCode: 1,
      biller: "anthropic",
      billingType: "api_key",
      model: input.model,
      summary: "",
      parsed: {
        type: "error",
        subtype: "tier1_sdk_error",
        message,
        code,
      },
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      errorMessage: message,
      errorCode: code,
      secretSource: secret.source,
      secretName: secret.name,
    };
  }
}

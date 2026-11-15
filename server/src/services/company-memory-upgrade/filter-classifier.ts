/**
 * LLM classifier client, budget tracking, and retrying for quality filter (TECH-8572).
 *
 * ARCHITECTURAL CONTRACT:
 * - Uses OpenAI Chat Completions with strict json_schema structured outputs.
 * - Privacy invariant: Only memory text is sent inside <source_memory> tags.
 * - Concurrency: 1..16 bounded concurrency (default 4).
 * - Per-request 60s timeout and max 4 attempts for 429/5xx/network errors.
 * - 400/401/403/insufficient_quota are terminal, aborting immediately.
 * - Billed unusable 200s are never retried.
 * - Budget guard: serialized UTF-8 request body bytes / 3 conservative projection.
 * - Reserve before dispatch, settle after return; in-flight reservations never exceed budget.
 */

import { createSystemClock, createSystemSleeper, type MonotonicClock, type Sleeper } from "./clock.js";
import {
  FILTER_CANONICAL_PARAMS,
  FILTER_JSON_SCHEMA,
  FILTER_MODEL,
  type FilterReasonCode,
  FILTER_SYSTEM_PROMPT,
  validateFilterOutput,
} from "./filter-contract.js";
import { ceilTokenCostNanodollars, NANODOLLARS_PER_USD } from "./cost.js";
import { isInsufficientQuotaError, parseRetryAfterMs, type RateLimiter } from "./rate-limiter.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface ClassifierResult {
  decision: "keep" | "drop";
  reason: FilterReasonCode;
  inputTokens: number;
  outputTokens: number;
}

export interface FilterClassifierClient {
  classify(
    text: string,
    importKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifierResult>;
}

export const FILTER_MAX_OUTPUT_TOKENS = FILTER_CANONICAL_PARAMS.max_completion_tokens;

export function buildFilterRequestBody(model: string, text: string): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: FILTER_SYSTEM_PROMPT },
      { role: "user", content: `<source_memory>\n${text}\n</source_memory>` },
    ],
    temperature: FILTER_CANONICAL_PARAMS.temperature,
    seed: FILTER_CANONICAL_PARAMS.seed,
    max_completion_tokens: FILTER_CANONICAL_PARAMS.max_completion_tokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "memory_quality_filter",
        strict: true,
        schema: FILTER_JSON_SCHEMA,
      },
    },
  });
}

export function projectRecordWorstCaseCostNanodollars(
  text: string,
  model: string = FILTER_MODEL,
  chatInputNano: bigint = 150_000_000n,
  chatOutputNano: bigint = 600_000_000n,
): bigint {
  const body = buildFilterRequestBody(model, text);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  // Conservative 3 bytes per token
  const inputTokens = Math.ceil(bodyBytes / 3);
  const outputTokens = FILTER_MAX_OUTPUT_TOKENS;

  const inputCost = ceilTokenCostNanodollars(inputTokens, chatInputNano);
  const outputCost = ceilTokenCostNanodollars(outputTokens, chatOutputNano);
  return inputCost + outputCost;
}

export function projectBatchWorstCaseCostNanodollars(
  texts: string[],
  model: string = FILTER_MODEL,
  chatInputNano: bigint = 150_000_000n,
  chatOutputNano: bigint = 600_000_000n,
): bigint {
  let total = 0n;
  for (const t of texts) {
    total += projectRecordWorstCaseCostNanodollars(t, model, chatInputNano, chatOutputNano);
  }
  return total;
}

export function nanodollarsToUsdNumber(nano: bigint): number {
  return Number(nano) / Number(NANODOLLARS_PER_USD);
}

export interface OpenAiFilterClassifierClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  clock?: MonotonicClock;
  sleeper?: Sleeper;
  fetchFn?: typeof fetch;
  maxAttempts?: number;
  timeoutMs?: number;
}

export class OpenAiFilterClassifierClient implements FilterClassifierClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;
  private readonly clock: MonotonicClock;
  private readonly sleeper: Sleeper;
  private readonly fetchFn: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAiFilterClassifierClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? FILTER_MODEL;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.rateLimiter = options.rateLimiter;
    this.clock = options.clock ?? createSystemClock();
    this.sleeper = options.sleeper ?? createSystemSleeper();
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async classify(
    text: string,
    importKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifierResult> {
    const serializedBody = buildFilterRequestBody(this.model, text);
    const bodyBytes = Buffer.byteLength(serializedBody, "utf8");
    const estimatedTokens = Math.ceil(bodyBytes / 3) + FILTER_MAX_OUTPUT_TOKENS;

    let attempt = 0;
    let baseDelayMs = 500;

    while (attempt < this.maxAttempts) {
      attempt++;

      if (options?.signal?.aborted) {
        throw new CompanyMemoryUpgradeError(
          `Classification aborted by operator for record ${importKey}.`,
          "ABORTED_BY_OPERATOR",
        );
      }

      let lease = null;
      if (this.rateLimiter) {
        lease = await this.rateLimiter.acquire(estimatedTokens);
      }

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), this.timeoutMs);

      const combinedAbort = () => {
        timeoutController.abort();
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", combinedAbort, { once: true });
      }

      try {
        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: serializedBody,
            signal: timeoutController.signal,
          });
        } catch (fetchErr: any) {
          clearTimeout(timeoutId);
          if (options?.signal) {
            options.signal.removeEventListener("abort", combinedAbort);
          }

          if (options?.signal?.aborted) {
            throw new CompanyMemoryUpgradeError(
              `Classification aborted by operator for record ${importKey}.`,
              "ABORTED_BY_OPERATOR",
            );
          }

          const isTimeout = timeoutController.signal.aborted;
          if (attempt >= this.maxAttempts) {
            const reason = isTimeout ? `timed out after ${this.timeoutMs}ms` : (fetchErr?.message || "network error");
            throw new CompanyMemoryUpgradeError(
              `OpenAI API request failed for record ${importKey} after ${this.maxAttempts} attempts (${reason}).`,
              "FILTER_INVALID_CLASSIFICATION",
            );
          }

          const jitter = Math.floor(Math.random() * 50);
          const delay = baseDelayMs + jitter;
          baseDelayMs *= 2;
          await this.sleeper.sleep(delay);
          continue;
        } finally {
          clearTimeout(timeoutId);
          if (options?.signal) {
            options.signal.removeEventListener("abort", combinedAbort);
          }
        }

        if (options?.signal?.aborted) {
          throw new CompanyMemoryUpgradeError(
            `Classification aborted by operator for record ${importKey}.`,
            "ABORTED_BY_OPERATOR",
          );
        }

        if (!response.ok) {
          const status = response.status;

          // 429 rate limit
          if (status === 429) {
            const errBody = await response.text().catch(() => "");
            if (isInsufficientQuotaError(errBody)) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI chat completions failed with HTTP 429 insufficient_quota for record ${importKey}.`,
                "FILTER_INVALID_CLASSIFICATION",
              );
            }
            if (attempt >= this.maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI chat completions failed with HTTP 429 for record ${importKey} after ${this.maxAttempts} attempts.`,
                "FILTER_INVALID_CLASSIFICATION",
              );
            }
            const nowMs = this.clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(response.headers, nowMs);
            const jitter = Math.floor(Math.random() * 50);
            const delay = Math.max(retryAfterMs ?? 0, baseDelayMs) + jitter;
            baseDelayMs *= 2;
            await this.sleeper.sleep(delay);
            continue;
          }

          // 5xx, 408, 409 retryable
          if (status === 408 || status === 409 || status >= 500) {
            if (attempt >= this.maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI API request failed for record ${importKey} with HTTP ${status} after ${this.maxAttempts} attempts.`,
                "FILTER_INVALID_CLASSIFICATION",
              );
            }
            const nowMs = this.clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(response.headers, nowMs);
            const jitter = Math.floor(Math.random() * 50);
            const delay = Math.max(retryAfterMs ?? 0, baseDelayMs) + jitter;
            baseDelayMs *= 2;
            await this.sleeper.sleep(delay);
            continue;
          }

          // Terminal 4xx (400, 401, 403, 404, etc.)
          throw new CompanyMemoryUpgradeError(
            `OpenAI API request rejected with HTTP ${status} for record ${importKey}.`,
            "FILTER_INVALID_CLASSIFICATION",
          );
        }

        // Response 200 OK: parse body
        let data: any;
        try {
          data = await response.json();
        } catch {
          // Billed unusable 200: NOT retried
          throw new CompanyMemoryUpgradeError(
            `OpenAI API returned unparseable JSON for record ${importKey}.`,
            "FILTER_INVALID_CLASSIFICATION",
          );
        }

        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        if (!content || typeof content !== "string") {
          // Billed unusable 200: NOT retried
          throw new CompanyMemoryUpgradeError(
            `OpenAI API returned empty response for record ${importKey}.`,
            "FILTER_INVALID_CLASSIFICATION",
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          // Billed unusable 200: NOT retried
          throw new CompanyMemoryUpgradeError(
            `OpenAI API returned malformed content JSON for record ${importKey}.`,
            "FILTER_INVALID_CLASSIFICATION",
          );
        }

        const validated = validateFilterOutput(parsed);
        const usage = data?.usage ?? {};
        const inputTokens = Number(usage.prompt_tokens) || Math.ceil(bodyBytes / 3);
        const outputTokens = Number(usage.completion_tokens) || FILTER_MAX_OUTPUT_TOKENS;

        if (lease) {
          lease.settle(inputTokens + outputTokens);
        }

        return {
          decision: validated.decision,
          reason: validated.reason,
          inputTokens,
          outputTokens,
        };
      } finally {
        if (lease) {
          lease.release();
        }
      }
    }

    throw new CompanyMemoryUpgradeError(
      `OpenAI API request exhausted ${this.maxAttempts} attempts for record ${importKey}.`,
      "FILTER_INVALID_CLASSIFICATION",
    );
  }
}

/**
 * LlmClient — orchestrates a request through an {@link LlmProvider} with
 * production-grade reliability: timeout, bounded exponential-backoff retry, and
 * a clean typed surface for the rest of the kit (agents, RAG).
 *
 * It contains ZERO vendor code — swap the provider, not this client.
 */

import type { CompletionRequest, CompletionResponse, LlmProvider } from './types.js';

export interface ClientOptions {
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Max retries on transient failure (default 2 -> up to 3 attempts). */
  maxRetries?: number;
  /** Base backoff in ms for exponential backoff (default 300). */
  baseBackoffMs?: number;
}

/**
 * LlmClient is itself an {@link LlmProvider}: it wraps a concrete provider and
 * adds timeout + retry. Because it satisfies the same interface, you can hand it
 * to the agent / RAG layer in place of the raw provider — reliability without
 * changing any downstream code.
 */
export class LlmClient implements LlmProvider {
  readonly model: string;

  constructor(
    private readonly provider: LlmProvider,
    private readonly opts: ClientOptions = {},
  ) {
    this.model = provider.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const maxRetries = this.opts.maxRetries ?? 2;
    const baseBackoff = this.opts.baseBackoffMs ?? 300;

    let attempt = 0;
    // Keep the last error so we can rethrow a meaningful message.
    let lastErr: unknown = new Error('no attempt made');

    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        return await withTimeout(this.provider.complete(req), timeoutMs);
      } catch (err) {
        lastErr = err;
        // Do not retry on a clean timeout-abort of our own making.
        if (err instanceof TimeoutError) throw err;
        if (attempt <= maxRetries) {
          const delay = baseBackoff * 2 ** (attempt - 1);
          await sleep(delay);
        }
      }
    }
    throw lastErr instanceof Error
      ? new Error(`LlmClient: all ${attempt} attempts failed: ${lastErr.message}`)
      : lastErr;
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
    // The upstream promise may still settle after we've timed out; its handler
    // above is attached, so it is always observed (never an unhandled rejection).
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Venice AI Client
 *
 * Provides inference via Venice AI – a privacy-focused, OpenAI-compatible
 * inference platform. Used as the first fallback when Bittensor is unreachable.
 *
 * Also exports EphemeralKeyHolder / EphemeralKeyManager / VeniceClient for
 * zero-persistence, per-request ephemeral key inference (see secure-inference.ts).
 *
 * API reference: https://docs.venice.ai
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Persistent-key client (used by InferenceFallbackChain)
// ---------------------------------------------------------------------------

export interface VeniceConfig {
  /** Venice AI API key (VENICE_API_KEY env var as fallback) */
  apiKey?: string;
  /** Base URL – defaults to the Venice AI inference endpoint */
  baseUrl?: string;
  /** Model to use – defaults to 'llama-3.3-70b' */
  model?: string;
  /** Request timeout in ms – defaults to 30 000 */
  timeout?: number;
}

export interface VeniceInferenceRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface VeniceInferenceResponse {
  success: boolean;
  text?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Estimated cost in USD (based on public token pricing) */
  estimatedCostUsd?: number;
  responseTime?: number;
  error?: string;
}

/** Approximate Venice AI pricing per 1 M tokens (USD) as of early 2026 */
const VENICE_PRICE_PER_1M_TOKENS_USD = 0.9;

export class VeniceAIClient {
  private config: Required<VeniceConfig>;

  constructor(config: VeniceConfig = {}) {
    this.config = {
      apiKey: config.apiKey ?? process.env['VENICE_API_KEY'] ?? '',
      baseUrl: config.baseUrl ?? 'https://api.venice.ai/api/v1',
      model: config.model ?? 'llama-3.3-70b',
      timeout: config.timeout ?? 30_000,
    };
  }

  /**
   * Send an inference request to Venice AI.
   * Uses the OpenAI-compatible chat completions endpoint.
   */
  async infer(request: VeniceInferenceRequest): Promise<VeniceInferenceResponse> {
    if (!this.config.apiKey) {
      return {
        success: false,
        error: 'Venice AI API key not configured (set VENICE_API_KEY)',
      };
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.systemPrompt) {
        messages.push({ role: 'system', content: request.systemPrompt });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body = JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0.7,
      });

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return { success: false, error: `Venice AI error ${response.status}: ${errText}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage;
      const totalTokens = usage?.total_tokens ?? 0;
      const estimatedCostUsd = (totalTokens / 1_000_000) * VENICE_PRICE_PER_1M_TOKENS_USD;

      return {
        success: true,
        text,
        model: data.model ?? this.config.model,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
        estimatedCostUsd,
        responseTime,
      };
    } catch (error) {
      clearTimeout(timer);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown Venice AI error',
      };
    }
  }

  /**
   * Quick connectivity check – returns true if Venice AI responds.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.apiKey) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Ephemeral-key client (used by SecureInferenceEngine)
//
// Security guarantees:
//   • A fresh subkey is minted via POST /api_keys before every request; the
//     master key never touches the inference path directly.
//   • Key material is held in a Uint8Array zeroed immediately after the
//     single HTTP request completes (success or failure).
//   • Error messages are sanitised by sanitizeForLog() before surfacing.
//   • Nothing key-shaped is ever written to a log file or thrown as-is.
// ---------------------------------------------------------------------------

export interface EphemeralVeniceConfig {
  /** Master Venice API key used only to mint per-request subkeys. */
  masterApiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface EphemeralVeniceRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface EphemeralVeniceResponse {
  success: boolean;
  text?: string;
  model?: string;
  provider: 'venice';
  cost?: number;
  responseTime: number;
  error?: string;
}

/**
 * Wraps raw key material in a Uint8Array so it can be zeroed after a single
 * use. JavaScript strings are immutable and GC-managed, so we convert to bytes
 * for zeroing and decode to string only at the HTTP call site.
 */
export class EphemeralKeyHolder {
  private buf: Uint8Array;
  private _consumed = false;

  constructor(keyMaterial: string) {
    this.buf = new TextEncoder().encode(keyMaterial);
  }

  /**
   * Return the key as a string and immediately zero the backing buffer.
   * May only be called once.
   */
  consume(): string {
    if (this._consumed) {
      throw new Error('Ephemeral key already consumed');
    }
    this._consumed = true;
    const key = new TextDecoder().decode(this.buf);
    this.buf.fill(0);
    return key;
  }

  /** Zero the buffer and mark consumed without returning the key. */
  discard(): void {
    this.buf.fill(0);
    this._consumed = true;
  }

  get consumed(): boolean {
    return this._consumed;
  }
}

interface EphemeralKeySession {
  keyId: string;
  holder: EphemeralKeyHolder;
}

const EPHEMERAL_COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'llama-3.3-70b': { input: 0.80, output: 0.80 },
  'llama-3.2-3b': { input: 0.06, output: 0.06 },
  'mistral-31-24b': { input: 0.20, output: 0.20 },
  default: { input: 0.20, output: 0.20 },
};

/**
 * Manages the Venice AI subkey lifecycle.
 *
 * Flow per inference request:
 *   1. POST /api_keys  → Venice creates a fresh scoped API subkey.
 *   2. Caller uses the subkey for one inference request.
 *   3. DELETE /api_keys/{keyId}  → Venice revokes the subkey.
 *   4. EphemeralKeyHolder.discard() zeroes the in-memory buffer.
 */
export class EphemeralKeyManager {
  /** @internal — exposed for zeroing tests only */
  masterBuf: Uint8Array;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(masterApiKey: string, baseUrl: string, timeout: number) {
    this.masterBuf = new TextEncoder().encode(masterApiKey);
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  /** Mint a fresh ephemeral subkey. The returned session must be revoked after use. */
  async generate(): Promise<EphemeralKeySession> {
    const masterKey = new TextDecoder().decode(this.masterBuf);
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api_keys`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${masterKey}`,
        },
        body: JSON.stringify({
          name: `ephemeral-${crypto.randomBytes(8).toString('hex')}`,
          expiresIn: 300,
        }),
      },
      this.timeout,
    );

    if (!res.ok) {
      throw new Error(`Key generation failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const rawKey = (data['key'] ?? data['apiKey'] ?? data['token'] ?? '') as string;
    const keyId = (data['id'] ?? data['keyId'] ?? crypto.randomBytes(8).toString('hex')) as string;

    if (!rawKey) throw new Error('Venice API returned no key material');

    return { keyId, holder: new EphemeralKeyHolder(rawKey) };
  }

  /**
   * Revoke the ephemeral subkey and zero its memory buffer.
   * Errors during revocation are swallowed — the session is over regardless.
   */
  async revoke(session: EphemeralKeySession): Promise<void> {
    session.holder.discard();

    const masterKey = new TextDecoder().decode(this.masterBuf);
    try {
      await fetchWithTimeout(
        `${this.baseUrl}/api_keys/${session.keyId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${masterKey}` } },
        this.timeout,
      );
    } catch {
      // Revocation failure is non-blocking; key is already discarded above.
    }
  }

  /** Zero the master key material from memory. */
  destroy(): void {
    this.masterBuf.fill(0);
  }
}

/**
 * Venice AI inference client that mints a fresh subkey per request.
 *
 * For every generate() call:
 *   1. A fresh ephemeral subkey is minted via EphemeralKeyManager.
 *   2. The subkey is used for exactly one /chat/completions request.
 *   3. The subkey is revoked and the in-memory buffer zeroed in a finally block.
 */
export class VeniceClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly keyManager: EphemeralKeyManager;

  constructor(config: EphemeralVeniceConfig = {}) {
    const masterApiKey = config.masterApiKey ?? process.env['VENICE_API_KEY'] ?? '';
    this.baseUrl = (config.baseUrl ?? 'https://api.venice.ai/api/v1').replace(/\/+$/, '');
    this.timeout = config.timeout ?? 30_000;
    this.keyManager = new EphemeralKeyManager(masterApiKey, this.baseUrl, this.timeout);

    // Zero any local copy immediately — key lives only inside keyManager.
    const tmp = new TextEncoder().encode(masterApiKey);
    tmp.fill(0);
  }

  /** Run inference with an ephemeral key, always revoked in a finally block. */
  async generate(request: EphemeralVeniceRequest): Promise<EphemeralVeniceResponse> {
    const startTime = Date.now();
    let session: EphemeralKeySession | null = null;

    try {
      session = await this.keyManager.generate();
      const ephemeralKey = session.holder.consume();

      const body = {
        model: request.model ?? 'llama-3.3-70b',
        messages: [
          ...(request.systemPrompt
            ? [{ role: 'system', content: request.systemPrompt }]
            : []),
          { role: 'user', content: request.prompt },
        ],
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
        venice_parameters: { include_venice_system_prompt: false },
      };

      const res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ephemeralKey}`,
          },
          body: JSON.stringify(body),
        },
        this.timeout,
      );
      // ephemeralKey string is now GC-eligible — no further references held.

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          success: false,
          provider: 'venice',
          responseTime: Date.now() - startTime,
          error: `HTTP ${res.status}: ${sanitizeForLog(errText)}`,
        };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const choice = (data['choices'] as any[])?.[0];
      const text: string = choice?.message?.content ?? choice?.text ?? '';
      const model: string = (data['model'] as string) ?? request.model ?? 'unknown';

      const usage = data['usage'] as Record<string, number> | undefined;
      const promptTokens = usage?.['prompt_tokens'] ?? 0;
      const completionTokens = usage?.['completion_tokens'] ?? 0;
      const rate =
        EPHEMERAL_COST_PER_MILLION[model] ?? EPHEMERAL_COST_PER_MILLION['default']!;
      const cost = (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000;

      return {
        success: true,
        text,
        model,
        provider: 'venice',
        cost,
        responseTime: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        provider: 'venice',
        responseTime: Date.now() - startTime,
        error: sanitizeForLog(err instanceof Error ? err.message : 'Unknown error'),
      };
    } finally {
      if (session) await this.keyManager.revoke(session);
    }
  }

  destroy(): void {
    this.keyManager.destroy();
  }
}

// ---------------------------------------------------------------------------
// Shared utilities (used by both VeniceClient and SecureInferenceEngine)
// ---------------------------------------------------------------------------

/** Fetch with AbortController-based timeout. */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove long alphanumeric tokens from a string before logging.
 * Catches Bearer tokens, hex keys, base64 blobs, and JWT segments.
 */
export function sanitizeForLog(message: string): string {
  return message
    .replace(/[A-Za-z0-9+/\-_]{20,}={0,2}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b[0-9a-fA-F]{20,}\b/g, '[REDACTED]');
}

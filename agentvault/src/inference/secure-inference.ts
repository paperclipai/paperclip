/**
 * Secure Inference Engine
 *
 * Orchestrates a three-tier provider fallback chain for AI inference:
 *
 *   1. Venice AI  — privacy-preserving cloud inference with ephemeral keys
 *   2. Bittensor  — decentralised network inference
 *   3. Local      — Ollama-compatible local model (zero external dependency)
 *
 * At every tier, a structured cost entry is appended to a daily JSONL log.
 * The log contains provider, model, token counts, cost, and latency — never
 * any API key or prompt content.
 *
 * Security guarantee (zero key exposure):
 *   • Venice ephemeral keys are created, used, and revoked inside VeniceClient.
 *   • All error messages are sanitised before reaching this layer.
 *   • Nothing key-shaped is ever passed to the cost logger or any file write.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { VeniceClient, type EphemeralVeniceConfig } from './venice-client.js';
import { LocalModelClient, type LocalModelConfig } from './local-model-client.js';
import { BittensorClient, type BittensorConfig } from './bittensor-client.js';
// Re-use InferenceProvider from fallback-chain to avoid a duplicate export.
import { type InferenceProvider } from './fallback-chain.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { InferenceProvider };

export interface SecureInferenceRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** Bittensor subnet UID — used when the Bittensor fallback is reached. */
  bittensorNetuid?: number;
}

export interface SecureInferenceResult {
  success: boolean;
  text?: string;
  provider: InferenceProvider;
  model?: string;
  /** Estimated cost in USD for the chosen provider. */
  cost: number;
  responseTime: number;
  /** Sanitised error message (no key material). */
  error?: string;
  /** Which providers were tried before this one succeeded. */
  fallbackChain: InferenceProvider[];
}

// ---------------------------------------------------------------------------
// Cost logger
// ---------------------------------------------------------------------------

const COST_LOG_DIR = path.join(os.homedir(), '.agentvault', 'inference-costs');

/**
 * Structured cost entry written to the daily JSONL log.
 * MUST NOT contain any API key material.
 */
interface CostLogEntry {
  timestamp: string;
  provider: InferenceProvider;
  model: string;
  cost_usd: number;
  duration_ms: number;
  tokens?: { prompt: number; completion: number };
  success: boolean;
}

/**
 * Append a single cost entry to the daily log file.
 * Failures are silently swallowed so that logging issues never block inference.
 */
function logInferenceCost(entry: CostLogEntry): void {
  try {
    if (!fs.existsSync(COST_LOG_DIR)) {
      fs.mkdirSync(COST_LOG_DIR, { recursive: true });
    }
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const logPath = path.join(COST_LOG_DIR, `${date}.jsonl`);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Non-blocking — inference proceeds regardless of log failures.
  }
}

// ---------------------------------------------------------------------------
// SecureInferenceEngine
// ---------------------------------------------------------------------------

export interface SecureInferenceConfig {
  venice?: EphemeralVeniceConfig;
  bittensor?: BittensorConfig;
  local?: LocalModelConfig;
  /** Override the default Bittensor netuid (default: 18 — text-generation). */
  defaultBittensorNetuid?: number;
}

/**
 * Three-tier secure inference engine.
 *
 * Usage:
 * ```ts
 * const engine = new SecureInferenceEngine();
 * const result = await engine.generate({ prompt: 'Hello' });
 * console.log(result.text, result.provider, result.cost);
 * ```
 */
export class SecureInferenceEngine {
  private readonly venice: VeniceClient;
  private readonly bittensor: BittensorClient;
  private readonly local: LocalModelClient;
  private readonly defaultNetuid: number;

  constructor(config: SecureInferenceConfig = {}) {
    this.venice = new VeniceClient(config.venice);
    this.bittensor = new BittensorClient(config.bittensor);
    this.local = new LocalModelClient(config.local);
    this.defaultNetuid = config.defaultBittensorNetuid ?? 18;
  }

  /**
   * Run inference through the fallback chain.
   *
   * Attempts Venice → Bittensor → Local in order.  Returns the first
   * successful result together with a cost log entry for the chosen provider.
   */
  async generate(request: SecureInferenceRequest): Promise<SecureInferenceResult> {
    // ── Tier 1: Venice AI with ephemeral keys ────────────────────────────
    const veniceResult = await this.venice.generate({
      prompt: request.prompt,
      model: request.model,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      systemPrompt: request.systemPrompt,
    });

    if (veniceResult.success) {
      logInferenceCost({
        timestamp: new Date().toISOString(),
        provider: 'venice',
        model: veniceResult.model ?? 'unknown',
        cost_usd: veniceResult.cost ?? 0,
        duration_ms: veniceResult.responseTime,
        success: true,
      });
      return {
        success: true,
        text: veniceResult.text,
        provider: 'venice',
        model: veniceResult.model,
        cost: veniceResult.cost ?? 0,
        responseTime: veniceResult.responseTime,
        fallbackChain: [],
      };
    }

    // Venice failed — log cost entry for the failed attempt (cost = 0)
    logInferenceCost({
      timestamp: new Date().toISOString(),
      provider: 'venice',
      model: request.model ?? 'unknown',
      cost_usd: 0,
      duration_ms: veniceResult.responseTime,
      success: false,
    });

    // ── Tier 2: Bittensor ─────────────────────────────────────────────────
    const netuid = request.bittensorNetuid ?? this.defaultNetuid;
    const btStart = Date.now();
    const btResult = await this.bittensor.infer({
      netuid,
      inputs: {
        prompt: request.prompt,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      timeout: 30_000,
    });
    const btDuration = Date.now() - btStart;

    if (btResult.success) {
      const btText =
        (btResult.data?.['text'] as string | undefined) ??
        (btResult.data?.['response'] as string | undefined) ??
        JSON.stringify(btResult.data);

      logInferenceCost({
        timestamp: new Date().toISOString(),
        provider: 'bittensor',
        model: `subnet-${netuid}`,
        cost_usd: 0, // Bittensor pricing is stake-based, not USD
        duration_ms: btDuration,
        success: true,
      });
      return {
        success: true,
        text: btText,
        provider: 'bittensor',
        model: `subnet-${netuid}`,
        cost: 0,
        responseTime: btDuration,
        fallbackChain: ['venice'],
      };
    }

    logInferenceCost({
      timestamp: new Date().toISOString(),
      provider: 'bittensor',
      model: `subnet-${netuid}`,
      cost_usd: 0,
      duration_ms: btDuration,
      success: false,
    });

    // ── Tier 3: Local model ───────────────────────────────────────────────
    const localResult = await this.local.infer({
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    });
    const localDuration = localResult.responseTime ?? 0;

    logInferenceCost({
      timestamp: new Date().toISOString(),
      provider: 'local',
      model: localResult.model ?? 'local',
      cost_usd: 0,
      duration_ms: localDuration,
      success: localResult.success,
    });

    if (localResult.success) {
      return {
        success: true,
        text: localResult.text,
        provider: 'local',
        model: localResult.model,
        cost: 0,
        responseTime: localDuration,
        fallbackChain: ['venice', 'bittensor'],
      };
    }

    // All providers exhausted
    return {
      success: false,
      provider: 'local',
      cost: 0,
      responseTime: localDuration,
      error: `All providers failed. Last error: ${localResult.error ?? 'unknown'}`,
      fallbackChain: ['venice', 'bittensor'],
    };
  }

  /** Destroy the engine and zero all retained key material. */
  destroy(): void {
    this.venice.destroy();
  }
}

// ---------------------------------------------------------------------------
// Cost log reader (for monitoring / billing dashboards)
// ---------------------------------------------------------------------------

/** Read cost entries for a given date (YYYY-MM-DD). */
export function readCostLog(date: string): CostLogEntry[] {
  const logPath = path.join(COST_LOG_DIR, `${date}.jsonl`);
  if (!fs.existsSync(logPath)) return [];

  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as CostLogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is CostLogEntry => entry !== null);
}

/** Summarise costs for a given date. */
export function summariseCostLog(date: string): {
  totalCostUsd: number;
  byProvider: Record<InferenceProvider, { calls: number; costUsd: number }>;
} {
  const entries = readCostLog(date);
  const byProvider: Record<InferenceProvider, { calls: number; costUsd: number }> = {
    venice: { calls: 0, costUsd: 0 },
    bittensor: { calls: 0, costUsd: 0 },
    local: { calls: 0, costUsd: 0 },
  };

  for (const e of entries) {
    if (e.provider in byProvider) {
      byProvider[e.provider].calls++;
      byProvider[e.provider].costUsd += e.cost_usd;
    }
  }

  return {
    totalCostUsd: Object.values(byProvider).reduce((s, v) => s + v.costUsd, 0),
    byProvider,
  };
}

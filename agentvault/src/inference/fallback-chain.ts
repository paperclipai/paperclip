/**
 * Inference Fallback Chain
 *
 * Orchestrates decentralised AI inference with graceful degradation:
 *
 *   Bittensor subnet  →  Venice AI  →  Local model
 *
 * Each provider is tried in order. On failure the next is attempted and
 * all attempts (including cost estimates) are logged.
 *
 * Scenario coverage
 * -----------------
 * ✅ Authenticated inference request  – Bittensor with hotkey wallet
 * ✅ Fallback chain                   – Venice AI then local model on BT failure
 * ✅ Cost logging                     – per-attempt and aggregate cost tracked
 */

import { BittensorClient, type BittensorConfig, type WalletConfig } from './bittensor-client.js';
import { VeniceAIClient, type VeniceConfig, type VeniceInferenceRequest } from './venice-client.js';
import { LocalModelClient, type LocalModelConfig, type LocalModelRequest } from './local-model-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InferenceProvider = 'bittensor' | 'venice' | 'local';

export interface CostLog {
  /** Estimated cost in USD for Bittensor (currently near-zero, tracked for future TAO pricing) */
  bittensorUsd?: number;
  /** Estimated cost in USD for Venice AI */
  veniceUsd?: number;
  /** Always 0 – local inference is free */
  localUsd?: number;
  /** Sum of all attempted provider costs */
  totalUsd: number;
}

export interface AttemptLog {
  provider: InferenceProvider;
  success: boolean;
  responseTime?: number;
  error?: string;
  estimatedCostUsd?: number;
}

export interface FallbackInferenceRequest {
  /** Free-text prompt */
  prompt: string;
  systemPrompt?: string;
  /** Bittensor netuid to query (default: 1 – text generation subnet) */
  netuid?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface FallbackResult {
  success: boolean;
  /** The provider that ultimately returned a successful result */
  provider?: InferenceProvider;
  text?: string;
  responseTime?: number;
  /** Whether response was returned in under 1 second (Bittensor SLA) */
  subSecond?: boolean;
  costs: CostLog;
  /** Full log of every attempt made */
  attemptsLog: AttemptLog[];
  error?: string;
}

export interface FallbackChainConfig {
  bittensor?: BittensorConfig & {
    /** Wallet with hotkey for authenticated Bittensor requests */
    wallet?: WalletConfig;
    /** Subnet to query */
    netuid?: number;
  };
  venice?: VeniceConfig;
  localModel?: LocalModelConfig;
  /** Disable specific providers (useful in tests / config) */
  disableProviders?: InferenceProvider[];
}

// ---------------------------------------------------------------------------
// InferenceFallbackChain
// ---------------------------------------------------------------------------

export class InferenceFallbackChain {
  private bittensor: BittensorClient;
  private venice: VeniceAIClient;
  private local: LocalModelClient;
  private netuid: number;
  private disabled: Set<InferenceProvider>;

  constructor(config: FallbackChainConfig = {}) {
    this.bittensor = new BittensorClient(config.bittensor ?? {});
    this.venice = new VeniceAIClient(config.venice ?? {});
    this.local = new LocalModelClient(config.localModel ?? {});
    this.netuid = config.bittensor?.netuid ?? 1;
    this.disabled = new Set(config.disableProviders ?? []);
  }

  /**
   * Run inference through the fallback chain.
   *
   * Tries Bittensor first. On any failure, falls back to Venice AI, then to
   * the local model. Costs and attempt details are always logged.
   */
  async infer(request: FallbackInferenceRequest): Promise<FallbackResult> {
    const attemptsLog: AttemptLog[] = [];
    const costs: CostLog = { totalUsd: 0 };

    // ------------------------------------------------------------------
    // 1. Bittensor
    // ------------------------------------------------------------------
    if (!this.disabled.has('bittensor')) {
      const btResult = await this.tryBittensor(request, attemptsLog, costs);
      if (btResult) return btResult;
    }

    // ------------------------------------------------------------------
    // 2. Venice AI
    // ------------------------------------------------------------------
    if (!this.disabled.has('venice')) {
      const veniceResult = await this.tryVenice(request, attemptsLog, costs);
      if (veniceResult) return veniceResult;
    }

    // ------------------------------------------------------------------
    // 3. Local model
    // ------------------------------------------------------------------
    if (!this.disabled.has('local')) {
      const localResult = await this.tryLocal(request, attemptsLog, costs);
      if (localResult) return localResult;
    }

    // All providers exhausted
    return {
      success: false,
      costs,
      attemptsLog,
      error: 'All inference providers failed: ' + attemptsLog.map((a) => `${a.provider}: ${a.error}`).join('; '),
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async tryBittensor(
    request: FallbackInferenceRequest,
    attemptsLog: AttemptLog[],
    costs: CostLog,
  ): Promise<FallbackResult | null> {
    const startTime = Date.now();
    try {
      const response = await this.bittensor.inferWithWallet({
        netuid: this.netuid,
        inputs: {
          prompt: request.prompt,
          system_prompt: request.systemPrompt,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        },
      });
      const responseTime = Date.now() - startTime;

      // Bittensor inference is effectively free at the API level (TAO staking
      // secures the network; there is no per-request charge through this endpoint)
      const estimatedCostUsd = 0;
      costs.bittensorUsd = estimatedCostUsd;
      costs.totalUsd += estimatedCostUsd;

      attemptsLog.push({
        provider: 'bittensor',
        success: response.success,
        responseTime,
        estimatedCostUsd,
        error: response.success ? undefined : response.error,
      });

      if (response.success) {
        const text =
          typeof response.data === 'string'
            ? response.data
            : response.data?.text ?? response.data?.output ?? JSON.stringify(response.data);

        return {
          success: true,
          provider: 'bittensor',
          text,
          responseTime,
          subSecond: responseTime < 1000,
          costs,
          attemptsLog,
        };
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : 'Unknown Bittensor error';
      costs.bittensorUsd = 0;
      attemptsLog.push({
        provider: 'bittensor',
        success: false,
        responseTime,
        estimatedCostUsd: 0,
        error: errMsg,
      });
    }
    return null;
  }

  private async tryVenice(
    request: FallbackInferenceRequest,
    attemptsLog: AttemptLog[],
    costs: CostLog,
  ): Promise<FallbackResult | null> {
    const veniceReq: VeniceInferenceRequest = {
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    };

    try {
      const response = await this.venice.infer(veniceReq);
      costs.veniceUsd = response.estimatedCostUsd ?? 0;
      costs.totalUsd += costs.veniceUsd;

      attemptsLog.push({
        provider: 'venice',
        success: response.success,
        responseTime: response.responseTime,
        estimatedCostUsd: response.estimatedCostUsd ?? 0,
        error: response.success ? undefined : response.error,
      });

      if (response.success) {
        return {
          success: true,
          provider: 'venice',
          text: response.text,
          responseTime: response.responseTime,
          subSecond: (response.responseTime ?? Infinity) < 1000,
          costs,
          attemptsLog,
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown Venice AI error';
      costs.veniceUsd = 0;
      attemptsLog.push({
        provider: 'venice',
        success: false,
        estimatedCostUsd: 0,
        error: errMsg,
      });
    }
    return null;
  }

  private async tryLocal(
    request: FallbackInferenceRequest,
    attemptsLog: AttemptLog[],
    costs: CostLog,
  ): Promise<FallbackResult | null> {
    const localReq: LocalModelRequest = {
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    };

    try {
      const response = await this.local.infer(localReq);
      costs.localUsd = 0;
      costs.totalUsd += 0;

      attemptsLog.push({
        provider: 'local',
        success: response.success,
        responseTime: response.responseTime,
        estimatedCostUsd: 0,
        error: response.success ? undefined : response.error,
      });

      if (response.success) {
        return {
          success: true,
          provider: 'local',
          text: response.text,
          responseTime: response.responseTime,
          subSecond: (response.responseTime ?? Infinity) < 1000,
          costs,
          attemptsLog,
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Local model unavailable';
      costs.localUsd = 0;
      attemptsLog.push({
        provider: 'local',
        success: false,
        estimatedCostUsd: 0,
        error: errMsg,
      });
    }
    return null;
  }
}

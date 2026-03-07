/**
 * Inference Manager
 *
 * Manages AI inference requests through Bittensor network.
 * Handles caching, rate limiting, and result aggregation.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const INFERENCE_CACHE_DIR = path.join(AGENTVAULT_DIR, 'inference-cache');

export interface InferenceConfig {
  netuid: number;
  uid?: number;
  batchSize?: number;
  timeout?: number;
  cacheTTL?: number;
  enableCache?: boolean;
}

export interface InferenceResult {
  success: boolean;
  data?: any;
  metadata?: {
    netuid: number;
    uid: number;
    timestamp: Date;
    responseTime: number;
  };
  error?: string;
}

export interface CachedInference {
  key: string;
  request: any;
  result: any;
  timestamp: Date;
  expiresAt: Date;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(INFERENCE_CACHE_DIR)) {
    fs.mkdirSync(INFERENCE_CACHE_DIR, { recursive: true });
  }
}

function generateCacheKey(
  netuid: number,
  inputs: Record<string, any>,
): string {
  const sortedInputs = JSON.stringify(inputs, Object.keys(inputs).sort());
  return `inference-${netuid}-${crypto.createHash('sha256').update(sortedInputs).digest('hex')}`;
}

function getCacheFilePath(key: string): string {
  ensureCacheDir();
  return path.join(INFERENCE_CACHE_DIR, `${key}.json`);
}

/**
 * Get cached inference result
 */
export function getCachedInference(
  netuid: number,
  inputs: Record<string, any>,
  _ttlMs: number = 3600000,
): CachedInference | null {
  try {
    const key = generateCacheKey(netuid, inputs);
    const cachePath = getCacheFilePath(key);

    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const content = fs.readFileSync(cachePath, 'utf8');
    const cached: CachedInference = JSON.parse(content);

    if (new Date(cached.expiresAt) < new Date()) {
      fs.unlinkSync(cachePath);
      return null;
    }

    return cached;
  } catch (error) {
    console.error('Failed to get cached inference:', error);
    return null;
  }
}

/**
 * Set cached inference result
 */
export function setCachedInference(
  netuid: number,
  inputs: Record<string, any>,
  result: any,
  ttlMs: number = 3600000,
): void {
  try {
    const key = generateCacheKey(netuid, inputs);
    const cachePath = getCacheFilePath(key);

    const now = new Date();
    const cached: CachedInference = {
      key,
      request: inputs,
      result,
      timestamp: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };

    fs.writeFileSync(cachePath, JSON.stringify(cached), 'utf8');
  } catch (error) {
    console.error('Failed to cache inference:', error);
  }
}

/**
 * Clear all cached inferences
 */
export function clearCache(): void {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(INFERENCE_CACHE_DIR);

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(INFERENCE_CACHE_DIR, file);
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.error('Failed to clear cache:', error);
  }
}

/**
 * Clear expired cached inferences
 */
export function clearExpiredCache(): number {
  let cleared = 0;

  try {
    ensureCacheDir();
    const files = fs.readdirSync(INFERENCE_CACHE_DIR);
    const now = new Date();

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(INFERENCE_CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const cached: CachedInference = JSON.parse(content);

        if (new Date(cached.expiresAt) < now) {
          fs.unlinkSync(filePath);
          cleared++;
        }
      }
    }
  } catch (error) {
    console.error('Failed to clear expired cache:', error);
  }

  return cleared;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  total: number;
  expired: number;
  sizeBytes: number;
} {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(INFERENCE_CACHE_DIR);
    const now = new Date();
    let expired = 0;
    let sizeBytes = 0;

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(INFERENCE_CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const cached: CachedInference = JSON.parse(content);

        if (new Date(cached.expiresAt) < now) {
          expired++;
        }

        sizeBytes += Buffer.byteLength(content);
      }
    }

    return {
      total: files.length,
      expired,
      sizeBytes,
    };
  } catch (error) {
    console.error('Failed to get cache stats:', error);
    return { total: 0, expired: 0, sizeBytes: 0 };
  }
}

/**
 * Aggregate multiple inference results
 */
export function aggregateResults(
  results: InferenceResult[],
  method: 'average' | 'majority' | 'first' = 'majority',
): any {
  if (results.length === 0) {
    return null;
  }

  if (results.length === 1) {
    return results[0]?.data || null;
  }

  const validResults = results.filter((r) => r.success && r.data);

  if (validResults.length === 0) {
    return null;
  }

  const firstResult = validResults[0];
  if (!firstResult) {
    return null;
  }

  switch (method) {
    case 'first':
      return firstResult.data;

    case 'average':
      if (typeof firstResult.data === 'number') {
        return (
          validResults.reduce((sum: number, r: any) => sum + (r.data as number), 0) / validResults.length
        );
      }
      return firstResult.data;

    case 'majority':
    default: {
      const counts = new Map<string, number>();

      for (const result of validResults) {
        const key = JSON.stringify(result.data);
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      let maxCount = 0;
      let majorityResult: any = null;

      for (const [key, count] of counts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          majorityResult = JSON.parse(key);
        }
      }

      return majorityResult;
    }
  }
}

/**
 * Format inference time
 */
export function formatInferenceTime(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Get inference statistics
 */
export interface InferenceStats {
  total: number;
  success: number;
  failed: number;
  cached: number;
  avgResponseTime: number;
}

export function getInferenceStats(
  history: InferenceResult[],
): InferenceStats {
  if (history.length === 0) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      cached: 0,
      avgResponseTime: 0,
    };
  }

  const success = history.filter((r) => r.success).length;
  const cached = history.filter((r) => r.success && r.metadata !== undefined).length;
  const responseTimes = history
    .filter((r) => r.metadata)
    .map((r) => r.metadata!.responseTime);

  return {
    total: history.length,
    success,
    failed: history.length - success,
    cached,
    avgResponseTime:
      responseTimes.length > 0
        ? responseTimes.reduce((sum: number, t: number) => sum + t, 0) / responseTimes.length
        : 0,
  };
}

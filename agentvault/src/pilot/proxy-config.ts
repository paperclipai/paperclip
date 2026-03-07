/**
 * Proxy Configuration for External Services
 *
 * Manages optional proxy settings for Anthropic, Arweave, and Bittensor
 * so that companies can route all external traffic through internal gateways.
 *
 * Supports PRD-004: All external calls optional and proxy-able.
 */

import type { ProxyConfig } from './types.js';

/**
 * Build a ProxyConfig from user-provided options.
 */
export function buildProxyConfig(options: {
  anthropicProxy?: string;
  arweaveProxy?: string;
  bittensorProxy?: string;
  binanceProxy?: string;
  extraEnv?: Record<string, string>;
}): ProxyConfig {
  return {
    anthropicProxy: options.anthropicProxy,
    arweaveProxy: options.arweaveProxy,
    bittensorProxy: options.bittensorProxy,
    binanceProxy: options.binanceProxy,
    extraEnv: options.extraEnv,
  };
}

/**
 * Convert a ProxyConfig into environment variables.
 *
 * These are injected into spawned processes (dfx, CLI, etc.) so the
 * underlying SDKs pick up the proxy settings automatically.
 */
export function proxyConfigToEnv(config: ProxyConfig): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.anthropicProxy) {
    // Anthropic SDK respects ANTHROPIC_BASE_URL
    env['ANTHROPIC_BASE_URL'] = config.anthropicProxy;
    // Also set generic HTTP_PROXY for lower-level libraries
    env['ANTHROPIC_PROXY'] = config.anthropicProxy;
  }

  if (config.arweaveProxy) {
    env['ARWEAVE_GATEWAY'] = config.arweaveProxy;
    env['AGENTVAULT_ARWEAVE_PROXY'] = config.arweaveProxy;
  }

  if (config.bittensorProxy) {
    env['BITTENSOR_ENDPOINT'] = config.bittensorProxy;
    env['AGENTVAULT_BITTENSOR_PROXY'] = config.bittensorProxy;
  }

  if (config.binanceProxy) {
    // BINANCE_PROXY_URL is read by the trading module to route all Binance
    // REST and WebSocket calls through the VPS firewall proxy.
    env['BINANCE_PROXY_URL'] = config.binanceProxy;
    env['AGENTVAULT_BINANCE_PROXY'] = config.binanceProxy;
  }

  if (config.extraEnv) {
    Object.assign(env, config.extraEnv);
  }

  return env;
}

/**
 * Validate proxy configuration.
 * Returns a list of warnings.
 */
export function validateProxyConfig(config: ProxyConfig): string[] {
  const warnings: string[] = [];

  const validateUrl = (label: string, url: string | undefined) => {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        warnings.push(`${label} proxy URL must use http:// or https:// (got: ${url})`);
      }
    } catch {
      warnings.push(`${label} proxy URL is not a valid URL: ${url}`);
    }
  };

  validateUrl('Anthropic', config.anthropicProxy);
  validateUrl('Arweave', config.arweaveProxy);
  validateUrl('Bittensor', config.bittensorProxy);
  validateUrl('Binance', config.binanceProxy);

  return warnings;
}

/**
 * Human-readable summary of the proxy configuration.
 */
export function describeProxyConfig(config: ProxyConfig): string[] {
  const lines: string[] = [];
  if (config.anthropicProxy) lines.push(`Anthropic → ${config.anthropicProxy}`);
  if (config.arweaveProxy) lines.push(`Arweave   → ${config.arweaveProxy}`);
  if (config.bittensorProxy) lines.push(`Bittensor → ${config.bittensorProxy}`);
  if (config.binanceProxy) lines.push(`Binance   → ${config.binanceProxy}`);
  if (lines.length === 0) lines.push('None (using default endpoints)');
  return lines;
}

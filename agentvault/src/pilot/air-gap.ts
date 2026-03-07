/**
 * Air-Gap Mode Manager
 *
 * Manages the air-gap configuration that disables all internet access
 * except for approved inference endpoints. Supports PRD-004.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AirGapConfig } from './types.js';

/** Default allowed inference endpoints (applied even in air-gap mode) */
export const DEFAULT_ALLOWED_ENDPOINTS: string[] = [];

/**
 * Build an AirGapConfig from user options.
 */
export function buildAirGapConfig(options: {
  enabled: boolean;
  anthropicProxy?: string;
  extraAllowedEndpoints?: string[];
}): AirGapConfig {
  const allowedEndpoints: string[] = [...DEFAULT_ALLOWED_ENDPOINTS];

  if (options.anthropicProxy) {
    // Allow the configured proxy endpoint
    allowedEndpoints.push(options.anthropicProxy);
  }

  if (options.extraAllowedEndpoints) {
    allowedEndpoints.push(...options.extraAllowedEndpoints);
  }

  return {
    enabled: options.enabled,
    allowedEndpoints,
    blockArweave: options.enabled,
    blockBittensor: options.enabled,
  };
}

/**
 * Generate shell environment exports for air-gap mode.
 *
 * When air-gap is enabled:
 * - Sets AGENTVAULT_AIR_GAP=1
 * - Optionally sets NO_PROXY_EXCEPTIONS for allowed endpoints
 * - Sets AGENTVAULT_BLOCK_ARWEAVE and AGENTVAULT_BLOCK_BITTENSOR
 *
 * Returns a map of env var name → value.
 */
export function buildAirGapEnv(config: AirGapConfig): Record<string, string> {
  const env: Record<string, string> = {};

  if (!config.enabled) {
    env['AGENTVAULT_AIR_GAP'] = '0';
    return env;
  }

  env['AGENTVAULT_AIR_GAP'] = '1';
  env['AGENTVAULT_BLOCK_ARWEAVE'] = config.blockArweave ? '1' : '0';
  env['AGENTVAULT_BLOCK_BITTENSOR'] = config.blockBittensor ? '1' : '0';

  if (config.allowedEndpoints.length > 0) {
    env['AGENTVAULT_ALLOWED_ENDPOINTS'] = config.allowedEndpoints.join(',');
  }

  return env;
}

/**
 * Validate an air-gap configuration.
 *
 * Returns a list of warnings (not errors, since partial air-gap is useful).
 */
export function validateAirGapConfig(config: AirGapConfig): string[] {
  const warnings: string[] = [];

  if (config.enabled && config.allowedEndpoints.length === 0) {
    warnings.push(
      'Air-gap enabled with no allowed endpoints. All inference calls (Anthropic, etc.) will fail. ' +
      'Pass --anthropic-proxy to allow a local inference endpoint.'
    );
  }

  return warnings;
}

/**
 * Write an air-gap environment file that can be sourced by shell scripts.
 *
 * The file is written to <stateDir>/air-gap.env
 */
export function writeAirGapEnvFile(config: AirGapConfig, stateDir: string): string {
  const envVars = buildAirGapEnv(config);
  const lines = Object.entries(envVars).map(([k, v]) => `export ${k}="${v}"`);
  const content = [
    '# AgentVault air-gap environment',
    '# Source this file to configure air-gap mode',
    ...lines,
    '',
  ].join('\n');

  fs.mkdirSync(stateDir, { recursive: true });
  const envPath = path.join(stateDir, 'air-gap.env');
  fs.writeFileSync(envPath, content, 'utf-8');
  return envPath;
}

/**
 * Enable or disable air-gap mode for a pilot config.
 *
 * Returns the updated config without persisting — the caller must save it.
 */
export function toggleAirGap(
  config: AirGapConfig,
  enabled: boolean,
  allowedEndpoints?: string[],
): AirGapConfig {
  return {
    ...config,
    enabled,
    allowedEndpoints: allowedEndpoints ?? config.allowedEndpoints,
    blockArweave: enabled,
    blockBittensor: enabled,
  };
}

/**
 * Human-readable summary of the air-gap configuration.
 */
export function describeAirGap(config: AirGapConfig): string {
  if (!config.enabled) {
    return 'Disabled (all external calls permitted)';
  }

  const blocked: string[] = [];
  if (config.blockArweave) blocked.push('Arweave');
  if (config.blockBittensor) blocked.push('Bittensor');

  const lines: string[] = [`Enabled — blocking: ${blocked.join(', ') || 'none'}`];
  if (config.allowedEndpoints.length > 0) {
    lines.push(`Allowed endpoints: ${config.allowedEndpoints.join(', ')}`);
  }
  return lines.join('\n  ');
}

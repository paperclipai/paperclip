/**
 * Environment Manager
 *
 * Manages ICP environment configurations from icp.yaml files.
 * Supports multiple environments (local, dev, staging, production)
 * with independent settings for network, cycles, identity, and optimization.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type {
  IcpProjectConfig,
  IcpEnvironmentConfig,
  IcpOptimizationConfig,
} from './types.js';

/**
 * Default paths to search for icp.yaml configuration.
 */
const CONFIG_SEARCH_PATHS = [
  'icp.yaml',
  'icp.yml',
  '.agentvault/icp.yaml',
];

/**
 * Default environment configuration when nothing is specified.
 */
const DEFAULT_LOCAL_ENV: IcpEnvironmentConfig = {
  name: 'local',
  network: { type: 'local' },
  cycles: { initial: '100T' },
};

/**
 * Default optimization settings.
 */
const DEFAULT_OPTIMIZATION: IcpOptimizationConfig = {
  enabled: true,
  level: 3,
  shrink: true,
  removeDebug: true,
  wasmOptFlags: ['--O3', '--dce', '--strip-debug'],
};

/**
 * Find the icp.yaml configuration file by walking up from a starting directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to icp.yaml, or null if not found
 */
export function findConfigFile(startDir?: string): string | null {
  const searchDir = startDir ? path.resolve(startDir) : process.cwd();

  // Check each search path in the starting directory
  for (const relPath of CONFIG_SEARCH_PATHS) {
    const fullPath = path.join(searchDir, relPath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Walk up the directory tree
  const parent = path.dirname(searchDir);
  if (parent !== searchDir) {
    return findConfigFile(parent);
  }

  return null;
}

/**
 * Load and parse icp.yaml configuration.
 *
 * @param configPath - Path to icp.yaml (if null, will search for it)
 * @returns Parsed configuration, or null if not found
 */
export function loadConfig(configPath?: string): IcpProjectConfig | null {
  const resolvedPath = configPath ?? findConfigFile();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = YAML.parse(content) as IcpProjectConfig;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse icp.yaml at ${resolvedPath}: ${message}`);
  }
}

/**
 * Get the configuration for a specific environment.
 *
 * Falls back to 'local' default if the environment is not defined.
 *
 * @param envName - Environment name
 * @param config - Project configuration (will be loaded if not provided)
 * @returns Environment configuration
 */
export function getEnvironment(
  envName: string,
  config?: IcpProjectConfig | null,
): IcpEnvironmentConfig {
  const projectConfig = config ?? loadConfig();

  if (projectConfig?.environments) {
    const envConfig = projectConfig.environments[envName];
    if (envConfig) {
      return envConfig;
    }
  }

  // Return defaults for known environment names
  if (envName === 'local') {
    return DEFAULT_LOCAL_ENV;
  }

  // For 'ic' or 'mainnet', return a mainnet default
  if (envName === 'ic' || envName === 'mainnet') {
    return {
      name: envName,
      network: { type: 'ic' },
      cycles: { initial: '1T' },
    };
  }

  // Unknown environment - return local defaults with a type based on name
  return DEFAULT_LOCAL_ENV;
}

/**
 * Get the optimization configuration.
 *
 * @param config - Project configuration (will be loaded if not provided)
 * @returns Optimization configuration
 */
export function getOptimizationConfig(
  config?: IcpProjectConfig | null,
): IcpOptimizationConfig {
  const projectConfig = config ?? loadConfig();
  return projectConfig?.optimization ?? DEFAULT_OPTIMIZATION;
}

/**
 * List all defined environment names.
 *
 * @param config - Project configuration (will be loaded if not provided)
 * @returns Array of environment names
 */
export function listEnvironments(
  config?: IcpProjectConfig | null,
): string[] {
  const projectConfig = config ?? loadConfig();
  if (projectConfig?.environments) {
    return Object.keys(projectConfig.environments);
  }
  return ['local'];
}

/**
 * Write an icp.yaml configuration file.
 *
 * @param config - Configuration to write
 * @param outputPath - Path to write to (defaults to ./icp.yaml)
 */
export function writeConfig(
  config: IcpProjectConfig,
  outputPath?: string,
): void {
  const targetPath = outputPath ?? path.join(process.cwd(), 'icp.yaml');
  const content = YAML.stringify(config, { indent: 2 });
  fs.writeFileSync(targetPath, content, 'utf-8');
}

/**
 * Generate a default icp.yaml configuration.
 *
 * @returns Default project configuration with local, dev, staging, production environments
 */
export function generateDefaultConfig(): IcpProjectConfig {
  return {
    name: 'agentvault-project',
    defaultEnvironment: 'local',
    environments: {
      local: {
        name: 'local',
        network: { type: 'local', replicaCount: 4 },
        cycles: { initial: '100T' },
      },
      dev: {
        name: 'dev',
        network: { type: 'ic', replicaCount: 13 },
        cycles: { initial: '1T' },
        identity: 'dev-wallet',
      },
      staging: {
        name: 'staging',
        network: { type: 'ic', replicaCount: 28 },
        cycles: { initial: '10T' },
        identity: 'staging-wallet',
      },
      production: {
        name: 'production',
        network: { type: 'ic', replicaCount: 28 },
        cycles: { initial: '100T' },
        identity: 'main-wallet',
      },
    },
    optimization: DEFAULT_OPTIMIZATION,
  };
}

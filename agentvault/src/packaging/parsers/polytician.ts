import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from '../../debugging/debug-logger.js';
import type {
  PolyticianConfig,
  ConfigLocation,
  ConfigValidationResult,
} from '../config-schemas.js';

function findPolyticianConfig(sourcePath: string): ConfigLocation | null {
  const absolutePath = path.resolve(sourcePath);

  const configFiles = ['polytician.json', '.polytician.json'];
  for (const file of configFiles) {
    const filePath = path.join(absolutePath, file);
    if (fs.existsSync(filePath)) {
      return {
        path: filePath,
        type: 'json',
      };
    }
  }

  return null;
}

function validatePolyticianConfig(config: PolyticianConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.name || config.name.trim() === '') {
    errors.push('Agent name is required');
  }

  if (config.version) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.version)) {
      errors.push(`Invalid version format: ${config.version}. Expected: X.Y.Z`);
    }
  }

  if (config.entryPoint) {
    const sourcePath = process.cwd();
    const entryPath = path.join(sourcePath, config.entryPoint);
    if (!fs.existsSync(entryPath)) {
      warnings.push(`Entry point does not exist: ${config.entryPoint}`);
    }
  }

  if (config.healthPort !== undefined) {
    if (typeof config.healthPort !== 'number' || config.healthPort < 1 || config.healthPort > 65535) {
      errors.push(`healthPort must be a valid port number (1-65535), got: ${config.healthPort}`);
    }
  }

  if (config.storageBackend && !['sqlite', 'memory', 'icp'].includes(config.storageBackend)) {
    errors.push(`Invalid storageBackend: ${config.storageBackend}. Expected: sqlite, memory, or icp`);
  }

  if (!config.entryPoint) {
    warnings.push('No entry point defined. Agent may not be executable.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export async function parsePolyticianConfig(
  sourcePath: string,
  _verbose: boolean = false
): Promise<PolyticianConfig> {
  debugLog(`[Polytician] Parsing configuration from: ${sourcePath}`);

  const configLocation = findPolyticianConfig(sourcePath);

  if (configLocation === null) {
    throw new Error(
      'No Polytician agent configuration found. ' +
        'Expected polytician.json or .polytician.json file in the agent source path.'
    );
  }

  debugLog(`[Polytician] Found ${configLocation.type.toUpperCase()} config: ${configLocation.path}`);

  let config: PolyticianConfig;

  try {
    const content = fs.readFileSync(configLocation.path, 'utf-8');
    const parsed = JSON.parse(content);

    config = {
      type: 'polytician',
      name: parsed.name || 'polytician-agent',
      version: parsed.version,
      description: parsed.description,
      entryPoint: parsed.entryPoint,
      embeddingModel: parsed.embeddingModel || 'text-embedding-3-small',
      storageBackend: parsed.storageBackend || 'sqlite',
      healthPort: parsed.healthPort || 8787,
      mcp: parsed.mcp || { namespace: 'polytician' },
    };

    debugLog(`[Polytician] Parsed name: ${config.name}`);
    debugLog(`[Polytician] Parsed version: ${config.version}`);
    debugLog(`[Polytician] Parsed entryPoint: ${config.entryPoint || 'none'}`);
    debugLog(`[Polytician] Parsed embeddingModel: ${config.embeddingModel}`);
    debugLog(`[Polytician] Parsed storageBackend: ${config.storageBackend}`);
    debugLog(`[Polytician] Parsed healthPort: ${config.healthPort}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse Polytician config: ${message}`);
  }

  const validation = validatePolyticianConfig(config);

  if (!validation.valid) {
    const errorMessage = `Polytician agent configuration validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      debugLog(`[Polytician] Warning: ${warning}`);
    }
  }

  return config;
}

export function findPolyticianConfigs(rootPath: string): string[] {
  const configs: string[] = [];

  function searchDirectory(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          searchDirectory(fullPath);
        }
      } else if (entry.isFile()) {
        if (entry.name === 'polytician.json' || entry.name === '.polytician.json') {
          configs.push(fullPath);
        }
      }
    }
  }

  searchDirectory(rootPath);
  return configs;
}

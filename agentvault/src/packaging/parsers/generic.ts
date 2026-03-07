/**
 * Generic Configuration Parser
 *
 * Parses generic agent configuration from JSON or YAML files.
 * Reads agent.json, agent.yaml, agent.yml, or .agentvault.json file
 * and constructs configuration object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { debugLog } from '../../debugging/debug-logger.js';
import type {
  GenericConfig,
  ConfigLocation,
  ConfigValidationResult,
} from '../config-schemas.js';

/**
 * Find Generic configuration file
 */
function findGenericConfig(sourcePath: string): ConfigLocation | null {
  const absolutePath = path.resolve(sourcePath);

  // Check for config files (priority order)
  const configFiles = ['agent.json', 'agent.yaml', 'agent.yml', 'agentvault.json', '.agentvault.json'];
  for (const file of configFiles) {
    const filePath = path.join(absolutePath, file);
    if (fs.existsSync(filePath)) {
      // Determine type based on extension
      const type = file.endsWith('.yaml') || file.endsWith('.yml') ? 'yaml' : 'json';
      return {
        path: filePath,
        type,
      };
    }
  }

  return null;
}

/**
 * Validate Generic configuration
 */
function validateGenericConfig(config: GenericConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name
  if (!config.name || config.name.trim() === '') {
    errors.push('Agent name is required');
  }

  // Validate version format
  if (config.version) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.version)) {
      errors.push(`Invalid version format: ${config.version}. Expected: X.Y.Z`);
    }
  }

  // Validate entry point exists (if specified)
  if (config.entryPoint) {
    const sourcePath = process.cwd();
    const entryPath = path.join(sourcePath, config.entryPoint);
    if (!fs.existsSync(entryPath)) {
      warnings.push(`Entry point does not exist: ${config.entryPoint}`);
    }
  }

  // Validate working directory exists (if specified)
  if (config.workingDirectory) {
    const workingDirPath = path.resolve(process.cwd(), config.workingDirectory);
    if (!fs.existsSync(workingDirPath)) {
      warnings.push(`Working directory does not exist: ${config.workingDirectory}`);
    }
  }

  // Validate allowedFiles format if specified
  if (config.allowedFiles) {
    if (!Array.isArray(config.allowedFiles)) {
      errors.push('allowedFiles must be an array');
    } else {
      for (const pattern of config.allowedFiles) {
        if (typeof pattern !== 'string' || pattern.trim() === '') {
          errors.push(`Invalid file pattern in allowedFiles: ${pattern}`);
        }
      }
    }
  }

  // Validate maxFileSize if specified
  if (config.maxFileSize !== undefined) {
    if (typeof config.maxFileSize !== 'number' || config.maxFileSize <= 0) {
      errors.push(`maxFileSize must be a positive number, got: ${config.maxFileSize}`);
    } else {
      // Warn if maxFileSize is very large (> 100MB)
      if (config.maxFileSize > 100 * 1024 * 1024) {
        warnings.push(`maxFileSize is very large (${(config.maxFileSize / 1024 / 1024).toFixed(0)}MB)`);
      }
    }
  }

  // Validate environment variables if specified
  if (config.environment) {
    if (typeof config.environment !== 'object' || config.environment === null) {
      errors.push('environment must be an object');
    } else {
      for (const [key, value] of Object.entries(config.environment)) {
        if (typeof value !== 'string') {
          errors.push(`Environment variable ${key} must be a string`);
        }
      }
    }
  }

  // Warn if no entry point defined
  if (!config.entryPoint) {
    warnings.push('No entry point defined. Agent may not be executable.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Parse Generic agent configuration
 *
 * This function reads agent.json, agent.yaml, agent.yml, or .agentvault.json file
 * and returns a fully validated configuration object.
 *
 * @param sourcePath - Path to agent source directory
 * @param verbose - Enable verbose logging
 * @returns Parsed and validated Generic configuration
 */
export async function parseGenericConfig(
  sourcePath: string,
  _verbose: boolean = false
): Promise<GenericConfig> {
  debugLog(`[Generic] Parsing configuration from: ${sourcePath}`);

  const configLocation = findGenericConfig(sourcePath);

  if (configLocation === null) {
    throw new Error(
      'No Generic agent configuration found. ' +
        'Expected agent.json, agent.yaml, agent.yml, or .agentvault.json file in the agent source path.'
    );
  }

  debugLog(`[Generic] Found ${configLocation.type.toUpperCase()} config: ${configLocation.path}`);

  let config: GenericConfig;

  try {
    const content = fs.readFileSync(configLocation.path, 'utf-8');

    // Parse based on file type
    if (configLocation.type === 'json') {
      const parsed = JSON.parse(content);

      config = {
        type: 'generic',
        name: parsed.name || 'generic-agent',
        version: parsed.version,
        description: parsed.description,
        entryPoint: parsed.entryPoint,
        workingDirectory: parsed.workingDirectory,
        environment: parsed.environment || {},
        allowedFiles: parsed.allowedFiles,
        maxFileSize: parsed.maxFileSize,
      };
    } else {
      // YAML
      const parsed = yaml.parse(content);

      config = {
        type: 'generic',
        name: parsed.name || 'generic-agent',
        version: parsed.version,
        description: parsed.description,
        entryPoint: parsed.entryPoint,
        workingDirectory: parsed.workingDirectory,
        environment: parsed.environment || {},
        allowedFiles: parsed.allowedFiles,
        maxFileSize: parsed.maxFileSize,
      };
    }

    debugLog(`[Generic] Parsed name: ${config.name}`);
    debugLog(`[Generic] Parsed version: ${config.version}`);
    debugLog(`[Generic] Parsed entryPoint: ${config.entryPoint || 'none'}`);
    debugLog(`[Generic] Parsed workingDirectory: ${config.workingDirectory || 'none'}`);
    debugLog(`[Generic] Parsed environment keys: ${Object.keys(config.environment || {}).length}`);
    debugLog(`[Generic] Parsed allowedFiles: ${config.allowedFiles?.length || 0}`);
    debugLog(`[Generic] Parsed maxFileSize: ${config.maxFileSize || 'unlimited'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse Generic config: ${message}`);
  }

  // Validate configuration
  const validation = validateGenericConfig(config);

  if (!validation.valid) {
    const errorMessage = `Generic agent configuration validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      debugLog(`[Generic] Warning: ${warning}`);
    }
  }

  return config;
}

/**
 * Find all Generic configurations in a directory tree
 *
 * @param rootPath - Root directory to search
 * @returns Array of paths to Generic configuration files
 */
export function findGenericConfigs(rootPath: string): string[] {
  const configs: string[] = [];

  function searchDirectory(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules and .git
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          searchDirectory(fullPath);
        }
      } else if (entry.isFile()) {
        // Check for Generic config files
        if (
          entry.name === 'agent.json' ||
          entry.name === 'agent.yaml' ||
          entry.name === 'agent.yml' ||
          entry.name === 'agentvault.json' ||
          entry.name === '.agentvault.json'
        ) {
          configs.push(fullPath);
        }
      }
    }
  }

  searchDirectory(rootPath);
  return configs;
}

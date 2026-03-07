/**
 * Goose Configuration Parser
 *
 * Parses Goose agent configuration from YAML files.
 * Reads goose.yaml, goose.yml, or .gooserc files and constructs configuration object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import type {
  GooseConfig,
  ConfigLocation,
  ConfigValidationResult,
} from '../config-schemas.js';
import {
  DEFAULT_GOOSE_CONFIG,
} from '../config-schemas.js';

/**
 * Find Goose configuration file
 */
function findGooseConfig(sourcePath: string): ConfigLocation | null {
  const absolutePath = path.resolve(sourcePath);

  const configFiles = ['goose.yaml', 'goose.yml', '.gooserc'];
  for (const file of configFiles) {
    const filePath = path.join(absolutePath, file);
    if (fs.existsSync(filePath)) {
      return {
        path: filePath,
        type: 'yaml',
      };
    }
  }

  return null;
}

/**
 * Validate Goose configuration
 */
function validateGooseConfig(config: GooseConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name
  if (!config.name || config.name.trim() === '') {
    errors.push('Agent name is required');
  }

  // Validate model (required for Goose)
  if (!config.model || config.model.trim() === '') {
    errors.push('Model is required for Goose agent');
  }

  // Validate version format
  if (config.version) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.version)) {
      errors.push(`Invalid version format: ${config.version}. Expected: X.Y.Z`);
    }
  }

  // Validate temperature (must be between 0 and 2)
  if (config.temperature !== undefined) {
    if (config.temperature < 0 || config.temperature > 2) {
      errors.push(`Temperature must be between 0 and 2, got: ${config.temperature}`);
    }
  }

  // Validate maxTokens (must be positive)
  if (config.maxTokens !== undefined) {
    if (config.maxTokens <= 0) {
      errors.push(`maxTokens must be positive, got: ${config.maxTokens}`);
    }
  }

  // Validate working directory exists (if specified)
  if (config.workingDirectory) {
    const workingDirPath = path.resolve(process.cwd(), config.workingDirectory);
    if (!fs.existsSync(workingDirPath)) {
      warnings.push(`Working directory does not exist: ${config.workingDirectory}`);
    }
  }

  // Warn if no tools defined
  if (!config.tools || config.tools.length === 0) {
    warnings.push('No tools defined in configuration');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Parse Goose agent configuration
 *
 * This function reads goose.yaml, goose.yml, or .gooserc file
 * and returns a fully validated configuration object.
 *
 * @param sourcePath - Path to agent source directory
 * @param verbose - Enable verbose logging
 * @returns Parsed and validated Goose configuration
 */
export async function parseGooseConfig(
  sourcePath: string,
  verbose: boolean = false
): Promise<GooseConfig> {
  if (verbose) {
    console.log(`[Goose] Parsing configuration from: ${sourcePath}`);
  }

  const configLocation = findGooseConfig(sourcePath);

  if (configLocation === null) {
    throw new Error(
      'No Goose configuration found. ' +
        'Expected goose.yaml, goose.yml, or .gooserc file in the agent source path.'
    );
  }

  if (verbose) {
    console.log(`[Goose] Found YAML config: ${configLocation.path}`);
  }

  let config: GooseConfig;

  try {
    const content = fs.readFileSync(configLocation.path, 'utf-8');
    const parsed = yaml.parse(content);

    // Merge with defaults
    config = {
      type: 'goose',
      name: parsed.name || DEFAULT_GOOSE_CONFIG.name,
      version: parsed.version || DEFAULT_GOOSE_CONFIG.version,
      description: parsed.description || DEFAULT_GOOSE_CONFIG.description,
      model: parsed.model || DEFAULT_GOOSE_CONFIG.model,
      temperature: parsed.temperature !== undefined ? parsed.temperature : DEFAULT_GOOSE_CONFIG.temperature,
      maxTokens: parsed.maxTokens !== undefined ? parsed.maxTokens : DEFAULT_GOOSE_CONFIG.maxTokens,
      systemPrompt: parsed.systemPrompt || DEFAULT_GOOSE_CONFIG.systemPrompt,
      tools: parsed.tools || DEFAULT_GOOSE_CONFIG.tools,
      workingDirectory: parsed.workingDirectory || DEFAULT_GOOSE_CONFIG.workingDirectory,
    };

    if (verbose) {
      console.log(`[Goose] Parsed name: ${config.name}`);
      console.log(`[Goose] Parsed version: ${config.version}`);
      console.log(`[Goose] Parsed model: ${config.model}`);
      console.log(`[Goose] Parsed temperature: ${config.temperature}`);
      console.log(`[Goose] Parsed maxTokens: ${config.maxTokens}`);
      console.log(`[Goose] Parsed tools: ${config.tools?.length || 0}`);
      console.log(`[Goose] Parsed workingDirectory: ${config.workingDirectory}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse Goose config: ${message}`);
  }

  // Validate configuration
  const validation = validateGooseConfig(config);

  if (!validation.valid) {
    const errorMessage = `Goose configuration validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  // Display warnings if verbose
  if (verbose && validation.warnings.length > 0) {
    console.log(`[Goose] Warnings:`);
    for (const warning of validation.warnings) {
      console.log(`[Goose]   - ${warning}`);
    }
  }

  return config;
}

/**
 * Find all Goose configurations in a directory tree
 *
 * @param rootPath - Root directory to search
 * @returns Array of paths to Goose configuration files
 */
export function findGooseConfigs(rootPath: string): string[] {
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
        // Check for Goose config files
        if (entry.name === 'goose.yaml' || entry.name === 'goose.yml' || entry.name === '.gooserc') {
          configs.push(fullPath);
        }
      }
    }
  }

  searchDirectory(rootPath);
  return configs;
}

/**
 * Cline Configuration Parser
 *
 * Parses Cline agent configuration from JSON files.
 * Reads cline.json, cline.config.json, or .cline file and constructs configuration object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ClineConfig,
  ConfigLocation,
  ConfigValidationResult,
} from '../config-schemas.js';
import {
  DEFAULT_CLINE_CONFIG,
} from '../config-schemas.js';

/**
 * Find Cline configuration file
 */
function findClineConfig(sourcePath: string): ConfigLocation | null {
  const absolutePath = path.resolve(sourcePath);

  // Check for JSON config files
  const configFiles = ['cline.json', 'cline.config.json', '.cline'];
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

/**
 * Validate Cline configuration
 */
function validateClineConfig(config: ClineConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name
  if (!config.name || config.name.trim() === '') {
    errors.push('Agent name is required');
  }

  // Validate mode
  if (config.mode && !['auto', 'request'].includes(config.mode)) {
    errors.push(`Invalid mode: ${config.mode}. Must be 'auto' or 'request'`);
  }

  // Validate claudeVersion format if specified
  if (config.claudeVersion) {
    // Basic version format validation
    const versionRegex = /^\d+\.\d+/;
    if (!versionRegex.test(config.claudeVersion)) {
      warnings.push(`Unusual claudeVersion format: ${config.claudeVersion}`);
    }
  }

  // Validate version format
  if (config.version) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.version)) {
      errors.push(`Invalid version format: ${config.version}. Expected: X.Y.Z`);
    }
  }

  // Validate working directory exists (if specified)
  if (config.workingDirectory) {
    const workingDirPath = path.resolve(process.cwd(), config.workingDirectory);
    if (!fs.existsSync(workingDirPath)) {
      warnings.push(`Working directory does not exist: ${config.workingDirectory}`);
    }
  }

  // Validate allowedCommands format if specified
  if (config.allowedCommands) {
    if (!Array.isArray(config.allowedCommands)) {
      errors.push('allowedCommands must be an array');
    } else {
      for (const cmd of config.allowedCommands) {
        if (typeof cmd !== 'string' || cmd.trim() === '') {
          errors.push(`Invalid command in allowedCommands: ${cmd}`);
        }
      }
    }
  }

  // Warn if no allowedCommands defined in auto mode
  if (config.mode === 'auto' && (!config.allowedCommands || config.allowedCommands.length === 0)) {
    warnings.push('Auto mode without allowedCommands may execute dangerous commands');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Parse Cline agent configuration
 *
 * This function reads cline.json, cline.config.json, or .cline file
 * and returns a fully validated configuration object.
 *
 * @param sourcePath - Path to agent source directory
 * @param verbose - Enable verbose logging
 * @returns Parsed and validated Cline configuration
 */
export async function parseClineConfig(
  sourcePath: string,
  verbose: boolean = false
): Promise<ClineConfig> {
  if (verbose) {
    console.log(`[Cline] Parsing configuration from: ${sourcePath}`);
  }

  const configLocation = findClineConfig(sourcePath);

  if (configLocation === null) {
    throw new Error(
      'No Cline configuration found. ' +
        'Expected cline.json, cline.config.json, or .cline file in the agent source path.'
    );
  }

  if (verbose) {
    console.log(`[Cline] Found JSON config: ${configLocation.path}`);
  }

  let config: ClineConfig;

  try {
    const content = fs.readFileSync(configLocation.path, 'utf-8');
    const parsed = JSON.parse(content);

    // Merge with defaults
    config = {
      type: 'cline',
      name: parsed.name || DEFAULT_CLINE_CONFIG.name,
      version: parsed.version || DEFAULT_CLINE_CONFIG.version,
      description: parsed.description || DEFAULT_CLINE_CONFIG.description,
      mode: parsed.mode || DEFAULT_CLINE_CONFIG.mode,
      claudeVersion: parsed.claudeVersion,
      workingDirectory: parsed.workingDirectory || DEFAULT_CLINE_CONFIG.workingDirectory,
      autoConfirm: parsed.autoConfirm !== undefined ? parsed.autoConfirm : DEFAULT_CLINE_CONFIG.autoConfirm,
      useReadline: parsed.useReadline !== undefined ? parsed.useReadline : DEFAULT_CLINE_CONFIG.useReadline,
      allowedCommands: parsed.allowedCommands || [],
    };

    if (verbose) {
      console.log(`[Cline] Parsed name: ${config.name}`);
      console.log(`[Cline] Parsed version: ${config.version}`);
      console.log(`[Cline] Parsed mode: ${config.mode}`);
      console.log(`[Cline] Parsed claudeVersion: ${config.claudeVersion || 'default'}`);
      console.log(`[Cline] Parsed workingDirectory: ${config.workingDirectory}`);
      console.log(`[Cline] Parsed autoConfirm: ${config.autoConfirm}`);
      console.log(`[Cline] Parsed useReadline: ${config.useReadline}`);
      console.log(`[Cline] Parsed allowedCommands: ${config.allowedCommands?.length || 0}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse Cline config: ${message}`);
  }

  // Validate configuration
  const validation = validateClineConfig(config);

  if (!validation.valid) {
    const errorMessage = `Cline configuration validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  // Display warnings if verbose
  if (verbose && validation.warnings.length > 0) {
    console.log(`[Cline] Warnings:`);
    for (const warning of validation.warnings) {
      console.log(`[Cline]   - ${warning}`);
    }
  }

  return config;
}

/**
 * Find all Cline configurations in a directory tree
 *
 * @param rootPath - Root directory to search
 * @returns Array of paths to Cline configuration files
 */
export function findClineConfigs(rootPath: string): string[] {
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
        // Check for Cline config files
        if (entry.name === 'cline.json' || entry.name === 'cline.config.json' || entry.name === '.cline') {
          configs.push(fullPath);
        }
      }
    }
  }

  searchDirectory(rootPath);
  return configs;
}

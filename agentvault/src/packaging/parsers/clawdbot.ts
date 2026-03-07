/**
 * Clawdbot Configuration Parser
 *
 * Parses Clawdbot agent configuration from .clawdbot directory.
 * Reads JSON files and constructs full configuration object.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ClawdbotConfig,
  ConfigLocation,
  ConfigValidationResult,
} from '../config-schemas.js';
import {
  DEFAULT_CLAWDBOT_SETTINGS,
  type ClawdbotProject,
  type ClawdbotTask,
  type ClawdbotSettings,
} from '../config-schemas.js';
import { SkillSandbox } from '../../trading/skill-sandbox.js';
import { debugLog } from '../../debugging/debug-logger.js';

/**
 * Find Clawdbot directory or configuration file
 */
function findClawdbotConfig(sourcePath: string): ConfigLocation | null {
  const absolutePath = path.resolve(sourcePath);

  // Check for .clawdbot directory
  const clawdbotDir = path.join(absolutePath, '.clawdbot');
  if (fs.existsSync(clawdbotDir)) {
    return {
      path: clawdbotDir,
      type: 'directory',
    };
  }

  // Check for clawdbot.json or clawdbot.config.json
  const configFiles = ['clawdbot.json', 'clawdbot.config.json'];
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
 * Read and parse .clawdbot directory structure
 */
function readClawdbotDirectory(dirPath: string): ClawdbotConfig {
  try {
    // Read projects
    const projectsPath = path.join(dirPath, 'projects.json');
    let projects: ClawdbotProject[] = [];
    if (fs.existsSync(projectsPath)) {
      const projectsContent = fs.readFileSync(projectsPath, 'utf-8');
      projects = JSON.parse(projectsContent);
    }

    // Read tasks
    const tasksPath = path.join(dirPath, 'tasks.json');
    let tasks: ClawdbotTask[] = [];
    if (fs.existsSync(tasksPath)) {
      const tasksContent = fs.readFileSync(tasksPath, 'utf-8');
      tasks = JSON.parse(tasksContent);
    }

    // Read context
    const contextPath = path.join(dirPath, 'context.json');
    let context: Record<string, unknown> = {};
    if (fs.existsSync(contextPath)) {
      const contextContent = fs.readFileSync(contextPath, 'utf-8');
      context = JSON.parse(contextContent);
    }

    // Read settings
    const settingsPath = path.join(dirPath, 'settings.json');
    let settings: ClawdbotSettings = { ...DEFAULT_CLAWDBOT_SETTINGS };
    if (fs.existsSync(settingsPath)) {
      const settingsContent = fs.readFileSync(settingsPath, 'utf-8');
      const parsedSettings = JSON.parse(settingsContent);
      settings = { ...DEFAULT_CLAWDBOT_SETTINGS, ...parsedSettings };
    }

    // Read main config file if exists
    let name = 'clawdbot-agent';
    let version = '1.0.0';
    let description = '';

    const configPath = path.join(dirPath, 'config.json');
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const configFile = JSON.parse(configContent);
      name = configFile.name || name;
      version = configFile.version || version;
      description = configFile.description || description;
    }

    const parsedConfig: ClawdbotConfig = {
      type: 'clawdbot',
      name,
      version,
      description,
      projects,
      tasks,
      context,
      settings,
    };

    return parsedConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse Clawdbot config: ${message}`);
  }
}

/**
 * Validate Clawdbot configuration
 */
function validateClawdbotConfig(config: ClawdbotConfig): ConfigValidationResult {
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

  // Validate settings
  if (config.settings) {
    // Validate temperature (must be between 0 and 2)
    if (config.settings.temperature !== undefined) {
      if (config.settings.temperature < 0 || config.settings.temperature > 2) {
        errors.push(`Temperature must be between 0 and 2, got: ${config.settings.temperature}`);
      }
    }

    // Validate maxTokens (must be positive)
    if (config.settings.maxTokens !== undefined) {
      if (config.settings.maxTokens <= 0) {
        errors.push(`maxTokens must be positive, got: ${config.settings.maxTokens}`);
      }
    }
  }

  // Validate projects
  if (config.projects && config.projects.length === 0) {
    warnings.push('No projects defined in configuration');
  }

  // Validate tasks
  if (config.tasks && config.tasks.length === 0) {
    warnings.push('No tasks defined in configuration');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Parse Clawdbot agent configuration
 *
 * This function reads .clawdbot directory or clawdbot.json file
 * and returns a fully validated configuration object.
 */
export async function parseClawdbotConfig(
  sourcePath: string,
  _verbose: boolean = false
): Promise<ClawdbotConfig> {
  // ── Sandbox enforcement ─────────────────────────────────────────────────
  // OpenClaw / Clawdbot skills must never execute as root and may only write
  // to /tmp.  Enforce both constraints before any skill code runs.
  const sandbox = new SkillSandbox();
  sandbox.assertSafe(); // throws if uid === 0

  const info = sandbox.describe();
  debugLog(`[Clawdbot] Sandbox: uid=${info.uid}, writeRoot=${info.writeRoot}`);
  // ── End sandbox enforcement ─────────────────────────────────────────────

  debugLog(`[Clawdbot] Parsing configuration from: ${sourcePath}`);

  const configLocation = findClawdbotConfig(sourcePath);

  if (configLocation === null) {
    throw new Error(
      'No Clawdbot configuration found. ' +
        'Expected .clawdbot directory or clawdbot.json file in the agent source path.'
    );
  }

  let config: ClawdbotConfig;

  if (configLocation.type === 'json') {
    debugLog(`[Clawdbot] Found JSON config: ${configLocation.path}`);
    const content = fs.readFileSync(configLocation.path, 'utf-8');
    const parsed = JSON.parse(content);
    const settings = { ...DEFAULT_CLAWDBOT_SETTINGS, ...parsed.settings };
    config = {
      type: 'clawdbot',
      name: parsed.name || 'clawdbot-agent',
      version: parsed.version || '1.0.0',
      description: parsed.description || '',
      settings,
      projects: parsed.projects || [],
      tasks: parsed.tasks || [],
      context: parsed.context || {},
    };
  } else {
    debugLog(`[Clawdbot] Found directory: ${configLocation.path}`);
    config = readClawdbotDirectory(configLocation.path);
    debugLog(`[Clawdbot] Parsed projects: ${config.projects?.length || 0}`);
    debugLog(`[Clawdbot] Parsed tasks: ${config.tasks?.length || 0}`);
    debugLog(`[Clawdbot] Parsed context keys: ${Object.keys(config.context || {}).length}`);
    if (config.settings) {
      debugLog(`[Clawdbot] Model: ${config.settings.model}`);
      debugLog(`[Clawdbot] Temperature: ${config.settings.temperature}`);
      debugLog(`[Clawdbot] Max Tokens: ${config.settings.maxTokens}`);
    }
  }

  const validation = validateClawdbotConfig(config);

  if (validation.errors.length > 0) {
    validation.errors.forEach((error) => debugLog(`[Clawdbot] Validation error: ${error}`));
  }
  if (validation.warnings.length > 0) {
    validation.warnings.forEach((warning) => debugLog(`[Clawdbot] Warning: ${warning}`));
  }

  if (!validation.valid) {
    throw new Error(
      `Clawdbot configuration validation failed: ${validation.errors.join('; ')}`
    );
  }

  return config;
}

/**
 * Find all Clawdbot configurations in a directory
 */
export async function findClawdbotConfigs(dir: string): Promise<string[]> {
  const results: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      try {
        await parseClawdbotConfig(entryPath);
        results.push(entry.name);
      } catch {
        // Skip directories that aren't valid Clawdbot configs
      }
    }
  }

  return results;
}

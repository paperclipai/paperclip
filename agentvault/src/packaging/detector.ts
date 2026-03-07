/**
 * Agent type detection logic
 *
 * Detects what type of agent is in a given directory based on
 * configuration files and directory structure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import type { AgentType, AgentConfig } from './types.js';

/**
 * Configuration file patterns for each agent type
 */
const AGENT_PATTERNS: Record<AgentType, { files: string[]; dirs: string[] }> = {
  clawdbot: {
    files: ['clawdbot.json', 'clawdbot.config.json', '.clawdbot'],
    dirs: ['.clawdbot'],
  },
  goose: {
    files: ['goose.yaml', 'goose.yml', 'goose.config.yaml', '.gooserc'],
    dirs: ['.goose'],
  },
  cline: {
    files: ['cline.json', 'cline.config.json', '.cline'],
    dirs: ['.cline'],
  },
  polytician: {
    files: ['polytician.json', '.polytician.json'],
    dirs: [],
  },
  generic: {
    files: ['agent.json', 'agent.yaml', 'agent.yml', 'agentvault.json'],
    dirs: [],
  },
};

/**
 * Check if a file exists at the given path
 */
function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a directory exists at the given path
 */
function directoryExists(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect agent type from a source directory
 */
export function detectAgentType(sourcePath: string): AgentType {
  const absolutePath = path.resolve(sourcePath);

  for (const agentType of ['clawdbot', 'goose', 'cline', 'polytician'] as AgentType[]) {
    const patterns = AGENT_PATTERNS[agentType];

    for (const file of patterns.files) {
      const filePath = path.join(absolutePath, file);
      if (fileExists(filePath)) {
        return agentType;
      }
    }

    for (const dir of patterns.dirs) {
      const dirPath = path.join(absolutePath, dir);
      if (directoryExists(dirPath)) {
        return agentType;
      }
    }
  }

  return 'generic';
}

/**
 * Extract agent name from the source path or config
 */
function extractAgentName(sourcePath: string, config: Record<string, unknown> | null): string {
  if (config && typeof config.name === 'string' && config.name.trim()) {
    return config.name.trim();
  }

  const dirName = path.basename(path.resolve(sourcePath));

  const sanitizedName = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  return sanitizedName;
}

/**
 * Find configuration file for a detected agent type
 */
function findConfigFile(sourcePath: string, agentType: AgentType): string | null {
  const absolutePath = path.resolve(sourcePath);
  const patterns = AGENT_PATTERNS[agentType];

  for (const file of patterns.files) {
    const filePath = path.join(absolutePath, file);
    if (fileExists(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Detect entry point for an agent
 */
function detectEntryPoint(sourcePath: string, agentType: AgentType): string | undefined {
  const absolutePath = path.resolve(sourcePath);

  const entryPoints = [
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'agent.ts',
    'agent.js',
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
  ];

  if (agentType === 'clawdbot') {
    entryPoints.unshift('clawdbot.ts', 'clawdbot.js');
  } else if (agentType === 'goose') {
    entryPoints.unshift('goose.ts', 'goose.js');
  } else if (agentType === 'cline') {
    entryPoints.unshift('cline.ts', 'cline.js');
  } else if (agentType === 'polytician') {
    entryPoints.unshift('polytician.ts', 'polytician.js', 'server.ts', 'server.js', 'src/server.ts', 'src/server.js');
  }

  for (const entry of entryPoints) {
    const entryPath = path.join(absolutePath, entry);
    if (fileExists(entryPath)) {
      return entry;
    }
  }

  return undefined;
}

/**
 * Detect agent configuration from a source directory
 *
 * @param sourcePath - Path to agent directory
 * @returns Agent configuration with basic detection
 */
export function detectAgent(sourcePath: string): AgentConfig {
  const absolutePath = path.resolve(sourcePath);

  const agentType = detectAgentType(sourcePath);

  const configFile = findConfigFile(sourcePath, agentType);
  const config = configFile ? tryReadConfig(configFile) : null;

  const name = extractAgentName(sourcePath, config);
  const entryPoint = detectEntryPoint(sourcePath, agentType);

    return {
      name,
      type: agentType,
      sourcePath: absolutePath,
      entryPoint,
      version: (config?.version as string | undefined),
    };
}

/**
 * Validate that the source path exists and is a directory
 */
export function validateSourcePath(sourcePath: string): { valid: boolean; error?: string } {
  const absolutePath = path.resolve(sourcePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      valid: false,
      error: `Source path does not exist: ${absolutePath}`,
    };
  }

  if (!fs.statSync(absolutePath).isDirectory()) {
    return {
      valid: false,
      error: `Source path is not a directory: ${absolutePath}`,
    };
  }

  return { valid: true };
}

/**
 * Try to read configuration file (JSON or YAML)
 */
function tryReadConfig(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Check file extension to determine format
    if (filePath.endsWith('.json')) {
      return JSON.parse(content) as Record<string, unknown>;
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml') || filePath.endsWith('.gooserc')) {
      return yaml.parse(content) as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
}

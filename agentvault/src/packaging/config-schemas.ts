/**
 * Agent Configuration Schemas
 *
 * Defines types and schemas for different agent configurations.
 * Supports Clawdbot, Goose, Cline, and Generic agents.
 */

/**
 * Base agent configuration interface
 */
export interface BaseAgentConfig {
  name: string;
  version?: string;
  description?: string;
}

/**
 * Clawdbot configuration interface
 * Clawdbot uses a .clawdbot directory with JSON files
 */
export interface ClawdbotConfig extends BaseAgentConfig {
  type: 'clawdbot';
  projects?: ClawdbotProject[];
  tasks?: ClawdbotTask[];
  context?: Record<string, unknown>;
  settings?: ClawdbotSettings;
}

export interface ClawdbotProject {
  id: string;
  name: string;
  path?: string;
  description?: string;
}

export interface ClawdbotTask {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  systemPrompt?: string;
}

export interface ClawdbotSettings {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: string[];
}

/**
 * Goose configuration interface
 * Goose uses YAML configuration files
 */
export interface GooseConfig extends BaseAgentConfig {
  type: 'goose';
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: string[];
  workingDirectory?: string;
}

/**
 * Cline configuration interface
 * Cline uses JSON configuration
 */
export interface ClineConfig extends BaseAgentConfig {
  type: 'cline';
  mode?: 'auto' | 'request';
  claudeVersion?: string;
  workingDirectory?: string;
  autoConfirm?: boolean;
  useReadline?: boolean;
  allowedCommands?: string[];
}

/**
 * Generic agent configuration interface
 * Generic agents use agent.json or agent.yaml
 */
export interface GenericConfig extends BaseAgentConfig {
  type: 'generic';
  entryPoint?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  allowedFiles?: string[];
  maxFileSize?: number;
}

export interface PolyticianConfig extends BaseAgentConfig {
  type: 'polytician';
  entryPoint?: string;
  embeddingModel?: string;
  storageBackend?: 'sqlite' | 'memory' | 'icp';
  healthPort?: number;
  mcp?: {
    namespace?: string;
    tools?: string[];
  };
}

export type ParsedAgentConfig =
  | ClawdbotConfig
  | GooseConfig
  | ClineConfig
  | GenericConfig
  | PolyticianConfig;

/**
 * Validation result for agent configuration
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Config file location
 */
export interface ConfigLocation {
  path: string;
  type: 'json' | 'yaml' | 'directory';
}

/**
 * Default values for Clawdbot settings
 */
export const DEFAULT_CLAWDBOT_SETTINGS: ClawdbotSettings = {
  model: 'claude-3-5-sonnet-20240229',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: '',
  tools: [],
};

/**
 * Default values for Goose configuration
 */
export const DEFAULT_GOOSE_CONFIG: Omit<GooseConfig, 'type'> = {
  model: 'gpt-4',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: '',
  tools: [],
  workingDirectory: '.',
  name: 'Agent',
  version: '1.0.0',
  description: '',
};

/**
 * Default values for Cline configuration
 */
export const DEFAULT_CLINE_CONFIG: Omit<ClineConfig, 'type'> = {
  mode: 'auto',
  autoConfirm: false,
  useReadline: true,
  workingDirectory: '.',
  name: 'Agent',
  version: '1.0.0',
  description: '',
};

/**
 * Config Persistence Module
 *
 * Manages agent configuration storage in ~/.agentvault/agents/<agent-id>/
 * Supports reading, writing, and listing agent configurations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ParsedAgentConfig } from './config-schemas.js';

/**
 * Base agent vault directory
 */
const AGENT_VAULT_DIR = path.join(os.homedir(), '.agentvault');

/**
 * Agents directory within agent vault
 */
const AGENTS_DIR = path.join(AGENT_VAULT_DIR, 'agents');

/**
 * Get config file path for an agent
 *
 * @param agentId - Agent identifier
 * @param fileName - Name of the config file (default: 'agent.json')
 */
export function getConfigPath(agentId: string, fileName: string = 'agent.json'): string {
  const agentDir = path.join(AGENTS_DIR, agentId);
  return path.join(agentDir, fileName);
}

/**
 * Ensure agent vault directories exist
 */
export function ensureVaultStructure(): void {
  if (!fs.existsSync(AGENT_VAULT_DIR)) {
    fs.mkdirSync(AGENT_VAULT_DIR, { recursive: true, mode: 0o700 });
  }
  
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write agent configuration to vault
 *
 * @param agentId - Agent identifier
 * @param config - Parsed agent configuration
 * @param fileName - Name of the config file (default: 'agent.json')
 */
export function writeAgentConfig(
  agentId: string,
  config: ParsedAgentConfig,
  fileName: string = 'agent.json'
): void {
  ensureVaultStructure();
  
  const agentDir = path.join(AGENTS_DIR, agentId);
  
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  
  const configPath = path.join(agentDir, fileName);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Read agent configuration from vault
 *
 * @param agentId - Agent identifier
 * @param fileName - Name of the config file (default: 'agent.json')
 */
export function readAgentConfig<T extends ParsedAgentConfig>(
  agentId: string,
  fileName: string = 'agent.json'
): T | null {
  ensureVaultStructure();
  
  const agentDir = path.join(AGENTS_DIR, agentId);
  const configPath = path.join(agentDir, fileName);
  
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * List all agents in vault
 *
 * @returns Array of agent IDs
 */
export function listAgents(): string[] {
  ensureVaultStructure();
  
  if (!fs.existsSync(AGENTS_DIR)) {
    return [];
  }
  
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agentIds: string[] = [];
  
  for (const entry of entries) {
    const entryPath = path.join(AGENTS_DIR, entry.name);
    const stats = fs.statSync(entryPath);
    if (stats.isDirectory() && fs.existsSync(path.join(entryPath, 'agent.json'))) {
      agentIds.push(entry.name);
    }
  }
  
  return agentIds;
}

/**
 * Delete an agent's configuration from vault
 *
 * @param agentId - Agent identifier to remove
 */
export function deleteAgentConfig(agentId: string): void {
  const agentDir = path.join(AGENTS_DIR, agentId);
  
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

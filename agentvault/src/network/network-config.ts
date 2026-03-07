/**
 * Network configuration management for AgentVault
 *
 * Manages local network configurations stored in ~/.agentvault/networks/
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import type { NetworkConfig } from '../icp/types.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const NETWORKS_DIR = path.join(AGENTVAULT_DIR, 'networks');

/**
 * Ensure the networks directory exists
 */
function ensureNetworksDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(NETWORKS_DIR)) {
    fs.mkdirSync(NETWORKS_DIR, { recursive: true });
  }
}

/**
 * Get the file path for a network config
 */
function getNetworkConfigPath(name: string): string {
  ensureNetworksDir();
  return path.join(NETWORKS_DIR, `${name}.yaml`);
}

/**
 * Create a new network configuration
 */
export async function createNetworkConfig(config: NetworkConfig): Promise<NetworkConfig> {
  const networkPath = getNetworkConfigPath(config.name);
  
  if (fs.existsSync(networkPath)) {
    throw new Error(`Network '${config.name}' already exists`);
  }
  
  const fullConfig: NetworkConfig = {
    ...config,
    created: new Date(),
    status: 'stopped',
  };
  
  fs.writeFileSync(networkPath, stringify(fullConfig), 'utf8');
  return fullConfig;
}

/**
 * Get network configuration by name
 */
export async function getNetworkConfig(name: string): Promise<NetworkConfig | null> {
  const networkPath = getNetworkConfigPath(name);
  
  if (!fs.existsSync(networkPath)) {
    return null;
  }
  
  const content = fs.readFileSync(networkPath, 'utf8');
  return parse(content) as NetworkConfig;
}

/**
 * List all network configurations
 */
export async function listNetworkConfigs(): Promise<NetworkConfig[]> {
  ensureNetworksDir();
  const configs: NetworkConfig[] = [];
  
  const files = fs.readdirSync(NETWORKS_DIR);
  for (const file of files) {
    if (file.endsWith('.yaml') || file.endsWith('.yml')) {
      const networkPath = path.join(NETWORKS_DIR, file);
      const content = fs.readFileSync(networkPath, 'utf8');
      try {
        configs.push(parse(content) as NetworkConfig);
      } catch {
        // Skip invalid config files
      }
    }
  }
  
  return configs;
}

/**
 * Update network configuration
 */
export async function updateNetworkConfig(name: string, updates: Partial<NetworkConfig>): Promise<NetworkConfig | null> {
  const config = await getNetworkConfig(name);
  if (!config) {
    return null;
  }
  
  const updated = { ...config, ...updates };
  const networkPath = getNetworkConfigPath(name);
  fs.writeFileSync(networkPath, stringify(updated), 'utf8');
  
  return updated;
}

/**
 * Delete network configuration
 */
export async function deleteNetworkConfig(name: string): Promise<boolean> {
  const networkPath = getNetworkConfigPath(name);
  
  if (!fs.existsSync(networkPath)) {
    return false;
  }
  
  fs.unlinkSync(networkPath);
  return true;
}

/**
 * Set network status
 */
export async function setNetworkStatus(name: string, status: 'running' | 'stopped' | 'error'): Promise<boolean> {
  const updated = await updateNetworkConfig(name, { status });
  return updated !== null;
}

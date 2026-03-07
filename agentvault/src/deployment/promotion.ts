/**
 * Environment promotion for canister deployment
 *
 * Handles promoting canisters between environments (dev -> staging -> production)
 * CLE-102: Wired to actual deploy path
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import type { DeploymentHistory } from '../icp/types.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const HISTORY_DIR = path.join(AGENTVAULT_DIR, 'history');

function ensureHistoryDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function getHistoryPath(agentName: string): string {
  ensureHistoryDir();
  return path.join(HISTORY_DIR, `${agentName}.yaml`);
}

export function loadDeploymentHistory(agentName: string): DeploymentHistory[] {
  const historyPath = getHistoryPath(agentName);
  
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  
  const content = fs.readFileSync(historyPath, 'utf8');
  const parsed = parse(content) as unknown;
  
  if (Array.isArray(parsed)) {
    return parsed as DeploymentHistory[];
  }
  
  return [];
}

export function saveDeploymentHistory(agentName: string, history: DeploymentHistory[]): void {
  const historyPath = getHistoryPath(agentName);
  fs.writeFileSync(historyPath, stringify(history), 'utf8');
}

export function addDeploymentToHistory(deployment: DeploymentHistory): void {
  const history = loadDeploymentHistory(deployment.agentName);
  history.push(deployment);
  saveDeploymentHistory(deployment.agentName, history);
}

export function getLatestDeployment(agentName: string, environment: string): DeploymentHistory | null {
  const history = loadDeploymentHistory(agentName);
  const envHistory = history.filter((d) => d.environment === environment && d.success);
  
  if (envHistory.length === 0) {
    return null;
  }
  
  return envHistory.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0] ?? null;
}

export function getAllDeployments(agentName: string): DeploymentHistory[] {
  return loadDeploymentHistory(agentName);
}

export interface PromotionOptions {
  targetCanisterId?: string;
  blueGreen?: boolean;
  wasmPath?: string;
  skipDeploy?: boolean;
}

/**
 * Promote a canister from one environment to another
 * Now calls actual deploy when skipDeploy is false
 */
export async function promoteCanister(
  agentName: string,
  fromEnv: string,
  toEnv: string,
  options: PromotionOptions = {},
): Promise<DeploymentHistory> {
  const sourceDeployment = getLatestDeployment(agentName, fromEnv);
  
  if (!sourceDeployment) {
    throw new Error(`No successful deployment found for ${agentName} in ${fromEnv} environment`);
  }
  
  const targetCanisterId = options.targetCanisterId || sourceDeployment.canisterId;
  
  if (!options.skipDeploy && options.wasmPath) {
    const { deployAgent } = await import('./deployer.js');
    
    const deployResult = await deployAgent({
      wasmPath: options.wasmPath,
      network: toEnv,
      canisterId: targetCanisterId,
      mode: 'upgrade',
    });

    const targetDeployment: DeploymentHistory = {
      agentName,
      environment: toEnv,
      canisterId: deployResult.canister.canisterId,
      wasmHash: deployResult.canister.wasmHash || sourceDeployment.wasmHash,
      timestamp: new Date(),
      version: sourceDeployment.version + 1,
      success: true,
    };
    
    addDeploymentToHistory(targetDeployment);
    
    return targetDeployment;
  }
  
  const targetDeployment: DeploymentHistory = {
    agentName,
    environment: toEnv,
    canisterId: targetCanisterId,
    wasmHash: sourceDeployment.wasmHash,
    timestamp: new Date(),
    version: sourceDeployment.version + 1,
    success: true,
  };
  
  addDeploymentToHistory(targetDeployment);
  
  return targetDeployment;
}

/**
 * Get deployment history for rollback
 */
export function getDeploymentForRollback(agentName: string, environment: string, version: number): DeploymentHistory | null {
  const history = loadDeploymentHistory(agentName);
  const found = history.find((d) => d.environment === environment && d.version === version);
  return found !== undefined ? found : null;
}

/**
 * Get deployments by time range for rollback
 */
export function getDeploymentsByTimeRange(
  agentName: string,
  environment: string,
  fromTime: Date,
  toTime: Date,
): DeploymentHistory[] {
  const history = loadDeploymentHistory(agentName);
  return history.filter(
    (d) => d.environment === environment && d.timestamp >= fromTime && d.timestamp <= toTime && d.success,
  ).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

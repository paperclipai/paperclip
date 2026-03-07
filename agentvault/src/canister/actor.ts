/**
 * AgentVault Canister Actor Bindings
 *
 * TypeScript Actor interface for AgentVault canister.
 * Generated from agent.did Candid interface.
 */

import { Actor, HttpAgent, Identity } from '@dfinity/agent';
import { idlFactory } from './actor.idl.js';

/**
 * AgentVault canister actor interface
 * Generated from agent.did Candid interface.
 */

/**
 * Agent configuration stored on-chain
 */
export type AgentConfig = {
  name: string;
  agentType: string;
  version: string;
  createdAt: number;
};

/**
 * WASM module metadata
 */
export type WasmMetadata = {
  hash: Uint8Array;
  size: number;
  loadedAt: number;
  functionNameCount: number;
};

/**
 * Memory entry for agent
 */
export type MemoryType = { fact: null } | { user_preference: null } | { task_result: null };

export type Memory = {
  id: string;
  memoryType: MemoryType;
  content: string;
  timestamp: number;
  importance: number;
};

/**
 * Task entry
 */
export type TaskStatus = { pending: null } | { running: null } | { completed: null } | { failed: null };

export type Task = {
  id: string;
  description: string;
  status: TaskStatus;
  result: [string] | [];
  timestamp: number;
};

/**
 * Execution result wrapper
 */
export type ExecutionResult = { ok: Uint8Array } | { err: string };

/**
 * Agent state
 */
export type AgentState = {
  initialized: boolean;
  lastExecuted: number;
  executionCount: number;
};

/**
 * Wallet information stored in canister (metadata only, NO private keys)
 */
export type WalletStatus = { active: null } | { inactive: null } | { revoked: null };

export type WalletInfo = {
  id: string;
  agentId: string;
  chain: string;
  address: string;
  registeredAt: number;
  status: WalletStatus;
};

/**
 * Agent status query result
 */
export type AgentStatus = {
  initialized: boolean;
  version: string;
  totalMemories: number;
  totalTasks: number;
  wasmLoaded: boolean;
  executionCount: number;
  lastExecuted: number;
};

/**
 * Canister status query result
 */
export type CanisterStatus = { running: null } | { stopping: null } | { stopped: null };

/**
 * Full canister status
 */
export type FullCanisterStatus = {
  status: CanisterStatus;
  memorySize: number;
  cycles: bigint;
};

/**
 * Canister metrics
 */
export type CanisterMetrics = {
  uptime: number;
  operations: number;
  lastActivity: number;
};

/**
 * Operation result
 */
export type OperationResult = { ok: string } | { err: string };

/**
 * Transaction action from canister
 */
export type CanisterTransactionAction = 'send_funds' | 'sign_message' | 'deploy_contract';

/**
 * Transaction priority from canister
 */
export type CanisterTransactionPriority = 'low' | 'normal' | 'high';

/**
 * Transaction status from canister
 */
export type CanisterTransactionStatus = 'pending' | 'queued' | 'signed' | 'completed' | 'failed';

/**
 * Queued transaction from canister
 */
export type CanisterQueuedTransaction = {
  id: string;
  action: {
    walletId: string;
    action: CanisterTransactionAction;
    parameters: [string, string][];
    priority: CanisterTransactionPriority;
    threshold?: number;
  };
  status: CanisterTransactionStatus;
  result?: string;
  retryCount: number;
  scheduledAt?: number;
  createdAt: number;
  signedAt?: number;
  completedAt?: number;
  errorMessage?: string;
};

/**
 * Transaction queue statistics from canister
 */
export type CanisterTransactionQueueStats = {
  total: number;
  pending: number;
  queued: number;
  signed: number;
  completed: number;
  failed: number;
};

/**
 * Encrypted secret from canister
 */
export type CanisterEncryptedSecret = {
  id: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  algorithm: 'aes_256_gcm' | 'chacha20_poly1305';
  createdAt: number;
};

/**
 * VetKeys status from canister
 */
export type CanisterVetKeysStatus = {
  enabled: boolean;
  thresholdSupported: boolean;
  mode: 'mock' | 'production';
};

/**
 * AgentVault canister actor interface
 */
export interface _SERVICE {
  getAgentConfig: () => Promise<[AgentConfig] | []>;
  getAgentStatus: () => Promise<AgentStatus>;
  setAgentConfig: (arg_0: AgentConfig) => Promise<OperationResult>;
  loadAgentWasm: (arg_0: Uint8Array, arg_1: Uint8Array) => Promise<OperationResult>;
  getWasmInfo: () => Promise<[WasmMetadata] | []>;
  isWasmLoaded: () => Promise<boolean>;
  agent_init: (arg_0: Uint8Array) => Promise<ExecutionResult>;
  agent_step: (arg_0: Uint8Array) => Promise<ExecutionResult>;
  agent_get_state: () => Promise<Uint8Array>;
  agent_get_state_size: () => Promise<number>;
  agent_add_memory: (arg_0: number, arg_1: Uint8Array) => Promise<ExecutionResult>;
  agent_get_memories: () => Promise<Uint8Array>;
  agent_get_memories_by_type: (arg_0: number) => Promise<Uint8Array>;
  agent_clear_memories: () => Promise<ExecutionResult>;
  agent_add_task: (arg_0: Uint8Array, arg_1: Uint8Array) => Promise<ExecutionResult>;
  agent_get_tasks: () => Promise<Uint8Array>;
  agent_get_pending_tasks: () => Promise<Uint8Array>;
  agent_update_task_status: (arg_0: Uint8Array, arg_1: number, arg_2: Uint8Array) => Promise<ExecutionResult>;
  agent_clear_tasks: () => Promise<ExecutionResult>;
  agent_get_info: () => Promise<Uint8Array>;
  execute: (arg_0: string) => Promise<OperationResult>;
  addMemory: (arg_0: Memory) => Promise<OperationResult>;
  getMemories: () => Promise<Array<Memory>>;
  getMemoriesByType: (arg_0: MemoryType) => Promise<Array<Memory>>;
  clearMemories: () => Promise<string>;
  addTask: (arg_0: Task) => Promise<OperationResult>;
  getTasks: () => Promise<Array<Task>>;
  getPendingTasks: () => Promise<Array<Task>>;
  getRunningTasks: () => Promise<Array<Task>>;
  updateTaskStatus: (arg_0: string, arg_1: TaskStatus, arg_2: [string] | []) => Promise<OperationResult>;
  clearTasks: () => Promise<string>;
  setContext: (arg_0: string, arg_1: string) => Promise<string>;
  getContext: (arg_0: string) => Promise<[string] | []>;
  getAllContext: () => Promise<Array<[string, string]>>;
  clearContext: () => Promise<string>;
  registerWallet: (arg_0: WalletInfo) => Promise<OperationResult>;
  getWallet: (arg_0: string) => Promise<[WalletInfo] | []>;
  listWallets: (arg_0: string) => Promise<Array<WalletInfo>>;
  deregisterWallet: (arg_0: string) => Promise<OperationResult>;
  updateWalletStatus: (arg_0: string, arg_1: WalletStatus) => Promise<OperationResult>;
  getCanisterStatus: () => Promise<FullCanisterStatus>;
  getMetrics: () => Promise<CanisterMetrics>;
  heartbeat: () => Promise<boolean>;

  queueTransaction: (arg_0: {
    walletId: string;
    action: {
      walletId: string;
      action: CanisterTransactionAction;
      parameters: [string, string][];
      priority: CanisterTransactionPriority;
      threshold?: number;
    };
  }) => Promise<OperationResult>;
  getQueuedTransactions: () => Promise<CanisterQueuedTransaction[]>;
  getPendingTransactions: () => Promise<CanisterQueuedTransaction[]>;
  getQueuedTransactionsByWallet: (arg_0: string) => Promise<CanisterQueuedTransaction[]>;
  getQueuedTransaction: (arg_0: string) => Promise<[CanisterQueuedTransaction] | []>;
  markTransactionSigned: (arg_0: string, arg_1: string) => Promise<OperationResult>;
  markTransactionCompleted: (arg_0: string, arg_1: string) => Promise<OperationResult>;
  markTransactionFailed: (arg_0: string, arg_1: string) => Promise<OperationResult>;
  retryTransaction: (arg_0: string) => Promise<OperationResult>;
  scheduleTransaction: (arg_0: string, arg_1: number) => Promise<OperationResult>;
  clearCompletedTransactions: () => Promise<string>;
  getTransactionQueueStats: () => Promise<CanisterTransactionQueueStats>;

  storeEncryptedSecret: (arg_0: CanisterEncryptedSecret) => Promise<OperationResult>;
  getEncryptedSecret: (arg_0: string) => Promise<[CanisterEncryptedSecret] | []>;
  listEncryptedSecrets: () => Promise<CanisterEncryptedSecret[]>;
  deleteEncryptedSecret: (arg_0: string) => Promise<OperationResult>;
  verifyThresholdSignature: (arg_0: string, arg_1: string) => Promise<OperationResult>;
  deriveVetKeysKey: (arg_0: string, arg_1: number) => Promise<OperationResult>;
  getVetKeysStatus: () => Promise<CanisterVetKeysStatus>;
}

/**
 * Create AgentVault canister actor
 *
 * @param canisterId - Canister ID to connect to
 * @param agent - HTTP agent instance
 * @returns Actor instance
 */
export function createActor(canisterId: string, agent?: HttpAgent): _SERVICE {
  const actor = Actor.createActor<_SERVICE>(idlFactory, {
    agent: agent,
    canisterId,
  });

  return actor;
}

/**
 * Create anonymous agent for local canister access
 *
 * @param host - Host URL (default: from ICP_LOCAL_URL env or http://localhost:4943)
 * @returns HTTP agent instance
 */
export function createAnonymousAgent(host?: string): HttpAgent {
  const defaultHost = process.env.ICP_LOCAL_URL || 'http://localhost:4943';
  const agent = new HttpAgent({
    host: host ?? defaultHost,
  });

  return agent;
}

/**
 * Create authenticated agent for mainnet canister access
 *
 * @param host - Host URL (default: from ICP_MAINNET_URL env or https://ic0.app)
 * @param identity - Identity for signing transactions
 * @returns HTTP agent instance
 */
export function createAuthenticatedAgent(host?: string, identity?: Identity): HttpAgent {
  const defaultHost = process.env.ICP_MAINNET_URL || 'https://ic0.app';
  const agent = new HttpAgent({
    host: host ?? defaultHost,
    identity,
  });

  return agent;
}

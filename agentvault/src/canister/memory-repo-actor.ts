/**
 * MemoryRepo Canister Actor Bindings (Hardened)
 *
 * TypeScript Actor interface for MemoryRepo canister.
 * Generated from memory-repo.did Candid interface.
 *
 * NOTE: Candid `int` and `nat` map to JavaScript `bigint` at runtime.
 * Fields typed as `bigint` below reflect this runtime behavior.
 */

import { Actor, HttpAgent, Identity } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { idlFactory } from './memory-repo-actor.idl.js';

// ==================== Types ====================

/**
 * A single commit in the memory repository.
 * `timestamp` is nanoseconds since epoch (Candid `int` -> JS `bigint`).
 */
export type Commit = {
  id: string;
  timestamp: bigint;
  message: string;
  diff: string;
  tags: string[];
  parent: [string] | [];
  branch: string;
};

/**
 * Repository status.
 * `totalCommits` and `totalBranches` are Candid `nat` -> JS `bigint`.
 */
export type RepoStatus = {
  initialized: boolean;
  currentBranch: string;
  totalCommits: bigint;
  totalBranches: bigint;
  owner: string;
};

/**
 * Security status.
 */
export type SecurityStatus = {
  owner: string;
  frozenMode: boolean;
  canisterKilled: boolean;
  authorizedCount: bigint;
  heapBytes: bigint;
};

/**
 * Operation result
 */
export type OperationResult = { ok: string } | { err: string };

/**
 * Rebase result.
 * `commitsReplayed` is Candid `nat` -> JS `bigint`.
 */
export type RebaseResult =
  | { ok: { newBranch: string; commitsReplayed: bigint } }
  | { err: string };

/**
 * Merge strategy
 */
export type MergeStrategy = { auto: null } | { manual: null };

/**
 * Conflict entry returned during merge
 */
export type ConflictEntry = {
  commitId: string;
  message: string;
  tags: string[];
  diff: string;
};

/**
 * Merge result.
 * `merged` is Candid `nat` -> JS `bigint`.
 */
export type MergeResult =
  | { ok: { merged: bigint; message: string } }
  | { conflicts: ConflictEntry[] }
  | { err: string };

/**
 * A ThoughtForm memory entry.
 * `timestamp` is Candid `nat64` -> JS `bigint`.
 */
export type ThoughtFormStore = {
  json: string;
  timestamp: bigint;
  hash: string;
};

// ==================== Service Interface ====================

/**
 * MemoryRepo canister actor interface
 */
export interface _SERVICE {
  // Owner & Security Management
  freeze: () => Promise<OperationResult>;
  manualUnlock: () => Promise<OperationResult>;
  killCanister: () => Promise<OperationResult>;
  reviveCanister: () => Promise<OperationResult>;
  addAuthorizedPrincipal: (p: Principal) => Promise<OperationResult>;
  removeAuthorizedPrincipal: (p: Principal) => Promise<OperationResult>;
  getSecurityStatus: () => Promise<SecurityStatus>;

  // Repository Lifecycle
  initRepo: (soulContent: string) => Promise<OperationResult>;

  // Commit Operations
  commit: (message: string, diff: string, tags: string[]) => Promise<OperationResult>;
  getCommit: (commitId: string) => Promise<[Commit] | []>;

  // Log & State Queries
  log: (branchName: [string] | []) => Promise<Commit[]>;
  getCurrentState: () => Promise<[string] | []>;
  getRepoStatus: () => Promise<RepoStatus>;

  // Branch Operations
  getBranches: () => Promise<[string, string][]>;
  createBranch: (name: string) => Promise<OperationResult>;
  switchBranch: (name: string) => Promise<OperationResult>;

  // Rebase (PRD 3)
  rebase: (newBaseSoul: string, targetBranch: [string] | []) => Promise<RebaseResult>;

  // Merge & Cherry-Pick (PRD 4)
  merge: (fromBranch: string, strategy: MergeStrategy) => Promise<MergeResult>;
  cherryPick: (commitId: string) => Promise<OperationResult>;

  // ThoughtForm Memory (PRD 5)
  storeThoughtForm: (json: string, timestamp: bigint, hash: string) => Promise<OperationResult>;
  getThoughtForms: () => Promise<ThoughtFormStore[]>;
  getThoughtFormByHash: (hash: string) => Promise<[ThoughtFormStore] | []>;
}

// ==================== Actor Creation ====================

/**
 * Create MemoryRepo canister actor
 *
 * @param canisterId - Canister ID to connect to
 * @param agent - HTTP agent instance
 * @returns Actor instance
 */
export function createMemoryRepoActor(canisterId: string, agent?: HttpAgent): _SERVICE {
  const actor = Actor.createActor<_SERVICE>(idlFactory, {
    agent: agent,
    canisterId,
  });

  return actor;
}

/**
 * Create anonymous agent for local canister access.
 * Automatically fetches root key for local replicas.
 *
 * @param host - Host URL (default: from ICP_LOCAL_URL env or http://localhost:4943)
 * @returns HTTP agent instance (call fetchRootKey() before canister calls on local)
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

/**
 * Validate a canister ID string.
 * Throws if the string is not a valid ICP principal.
 */
export function validateCanisterId(canisterId: string): void {
  try {
    Principal.fromText(canisterId);
  } catch {
    throw new Error(`Invalid canister ID: "${canisterId}"`);
  }
}

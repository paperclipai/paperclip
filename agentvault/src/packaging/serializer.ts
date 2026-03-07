/**
 * Agent State Serializer
 *
 * This module handles serialization and deserialization of agent state
 * for storage in canisters and local files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentConfig } from './types.js';
import { isVetKeysEncryptedBundle, decryptBundle } from '../security/vetkeys.js';

/**
 * Agent state schema version
 */
export const SCHEMA_VERSION = '1.0.0';

/**
 * Memory item in agent state
 */
export interface Memory {
  id: string;
  type: 'fact' | 'user_preference' | 'task_result';
  content: unknown;
  timestamp: number;
  importance: number;
}

/**
 * Task in agent queue
 */
export interface Task {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  timestamp: number;
}

/**
 * Agent state stored in canister
 */
export interface AgentState {
  config: AgentConfig;
  memories: Memory[];
  tasks: Task[];
  context: Map<string, unknown>;
  version: string;
  lastUpdated: number;
}

/**
 * Serialized agent state (for storage/transmission)
 */
export interface SerializedAgentState {
  $schema: string;
  version: string;
  agent: {
    name: string;
    type: string;
    version?: string;
  };
  metadata: {
    createdAt: string;
    sourcePath: string;
    entryPoint?: string;
    encrypted?: boolean;
  };
  state: {
    initialized: boolean;
    data: {
      memories?: Memory[];
      tasks?: Task[];
      context?: Record<string, unknown>;
    };
  };
}

/**
 * Serialization options
 */
export interface SerializationOptions {
  pretty?: boolean;
  includeMemories?: boolean;
  includeTasks?: boolean;
  includeContext?: boolean;
}

/**
 * Default serialization options
 */
const DEFAULT_OPTIONS: SerializationOptions = {
  pretty: true,
  includeMemories: true,
  includeTasks: true,
  includeContext: true,
};

/**
 * Serialize agent state to JSON
 */
export function serializeState(
  state: AgentState,
  options: SerializationOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const serialized: SerializedAgentState = {
    $schema: `https://agentvault.dev/schemas/agent-state-v${SCHEMA_VERSION}.json`,
    version: SCHEMA_VERSION,
    agent: {
      name: state.config.name,
      type: state.config.type,
      version: state.config.version,
    },
    metadata: {
      createdAt: new Date().toISOString(),
      sourcePath: state.config.sourcePath,
      entryPoint: state.config.entryPoint,
    },
    state: {
      initialized: state.memories.length > 0 || state.tasks.length > 0,
      data: {},
    },
  };

  if (opts.includeMemories) {
    serialized.state.data.memories = state.memories;
  }

  if (opts.includeTasks) {
    serialized.state.data.tasks = state.tasks;
  }

  if (opts.includeContext) {
    serialized.state.data.context = mapToObject(state.context);
  }

  return JSON.stringify(serialized, null, opts.pretty ? 2 : 0);
}

/**
 * Deserialize agent state from JSON
 */
export function deserializeState(json: string): AgentState {
  const serialized = JSON.parse(json) as SerializedAgentState;

  return {
    config: {
      name: serialized.agent.name,
      type: serialized.agent.type as 'clawdbot' | 'goose' | 'cline' | 'generic',
      sourcePath: serialized.metadata.sourcePath,
      entryPoint: serialized.metadata.entryPoint,
      version: serialized.agent.version,
    },
    memories: serialized.state.data.memories ?? [],
    tasks: serialized.state.data.tasks ?? [],
    context: new Map(Object.entries(serialized.state.data.context ?? {})),
    version: serialized.version,
    lastUpdated: Date.now(),
  };
}

/**
 * Write serialized state to file
 */
export async function writeStateFile(
  state: AgentState,
  filePath: string,
  options: SerializationOptions = {}
): Promise<void> {
  const serialized = serializeState(state, options);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  fs.writeFileSync(filePath, serialized, 'utf-8');
}

/**
 * Read state from file
 *
 * If the file is a VetKeys-encrypted bundle (detected by magic header),
 * it is automatically decrypted before deserialization.  If the JSON
 * payload has `metadata.encrypted === true` and the raw bytes are *not*
 * encrypted, the flag is simply ignored (the data is already plaintext).
 */
export async function readStateFile(
  filePath: string,
  principalId?: string,
): Promise<AgentState> {
  const raw = fs.readFileSync(filePath);

  // Auto-decrypt if the file is a VetKeys-encrypted bundle
  if (isVetKeysEncryptedBundle(Buffer.from(raw))) {
    const decrypted = await decryptBundle(Buffer.from(raw), principalId);
    return deserializeState(decrypted.toString('utf-8'));
  }

  return deserializeState(raw.toString('utf-8'));
}

/**
 * Convert Map to plain object
 */
function mapToObject<T>(map: Map<string, T>): Record<string, T> {
  const obj: Record<string, T> = {};
  for (const [key, value] of map.entries()) {
    obj[key] = value;
  }
  return obj;
}

/**
 * Create empty agent state
 */
export function createEmptyState(config: AgentConfig): AgentState {
  return {
    config,
    memories: [],
    tasks: [],
    context: new Map(),
    version: SCHEMA_VERSION,
    lastUpdated: Date.now(),
  };
}

/**
 * Merge two agent states
 */
export function mergeStates(
  base: AgentState,
  updates: Partial<AgentState>
): AgentState {
  const merged: AgentState = {
    ...base,
    config: updates.config ?? base.config,
    memories: updates.memories ?? base.memories,
    tasks: updates.tasks ?? base.tasks,
    context: updates.context ?? base.context,
    version: updates.version ?? base.version,
    lastUpdated: updates.lastUpdated ?? Date.now(),
  };

  return merged;
}

/**
 * Validate serialized state
 */
export function validateState(serialized: SerializedAgentState): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!serialized.agent?.name) {
    errors.push('Missing agent name');
  }

  if (!serialized.agent?.type) {
    errors.push('Missing agent type');
  }

  if (!serialized.version) {
    errors.push('Missing version');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

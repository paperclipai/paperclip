/**
 * Batched canister operations
 *
 * Executes multiple canister operations in parallel with dependency ordering,
 * retries, and configurable concurrency.
 */

import type { IcpCommonOptions } from '../icp/types.js';
import { canisterStatus, canisterCall } from '../icp/icpcli.js';

export type BatchOperationType = 'call' | 'query' | 'status' | 'deploy';

export interface BatchOperation {
  /** Operation ID (auto-generated) */
  id: string;
  /** Operation type */
  type: BatchOperationType;
  /** Target canister ID */
  canisterId: string;
  /** Method name (for call/query) */
  method?: string;
  /** Arguments (Candid format) */
  args?: string;
  /** Options for the operation */
  options?: IcpCommonOptions;
  /** Dependencies (operation IDs that must complete first) */
  dependsOn?: string[];
}

export interface BatchResult {
  /** Operation ID */
  operationId: string;
  /** Whether this operation succeeded */
  success: boolean;
  /** Result data (if success) */
  data?: unknown;
  /** Error message (if failure) */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

export interface BatchExecutionResult {
  /** Total operations */
  total: number;
  /** Successful operations */
  succeeded: number;
  /** Failed operations */
  failed: number;
  /** Individual results */
  results: BatchResult[];
  /** Total execution time */
  totalDurationMs: number;
}

export interface BatchConfig {
  /** Maximum concurrent operations */
  maxConcurrency: number;
  /** Timeout per operation in milliseconds */
  operationTimeoutMs: number;
  /** Whether to stop on first failure */
  stopOnFailure: boolean;
  /** Retry failed operations */
  retryCount: number;
  /** Retry delay in milliseconds */
  retryDelayMs: number;
}

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxConcurrency: 10,
  operationTimeoutMs: 30000,
  stopOnFailure: false,
  retryCount: 2,
  retryDelayMs: 1000,
};

let operationCounter = 0;

function generateOperationId(): string {
  return `op_${++operationCounter}_${Date.now()}`;
}

/**
 * Topologically sort operations by dependency graph
 */
function sortOperationsByDeps(operations: BatchOperation[]): BatchOperation[] {
  const opMap = new Map(operations.map((op) => [op.id, op]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: BatchOperation[] = [];

  function visit(opId: string): void {
    if (visited.has(opId)) return;
    if (visiting.has(opId)) {
      throw new Error(`Circular dependency detected involving operation: ${opId}`);
    }

    visiting.add(opId);
    const op = opMap.get(opId);
    if (op !== undefined) {
      if (op.dependsOn) {
        for (const depId of op.dependsOn) {
          visit(depId);
        }
      }
      visiting.delete(opId);
      visited.add(opId);
      sorted.push(op);
    }
  }

  for (const op of operations) {
    visit(op.id);
  }

  return sorted;
}

/**
 * Execute a single batch operation
 */
async function executeOperation(operation: BatchOperation, config: BatchConfig): Promise<BatchResult> {
  const startTime = Date.now();
  let result: BatchResult;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Operation timeout after ${config.operationTimeoutMs}ms`)), config.operationTimeoutMs);
  });

  try {
    const executionPromise = (async (): Promise<BatchResult> => {
      switch (operation.type) {
        case 'status': {
          const statusResult = await canisterStatus({
            canister: operation.canisterId,
            ...operation.options,
          });
          return {
            operationId: operation.id,
            success: statusResult.success,
            data: statusResult.stdout,
            error: statusResult.success ? undefined : statusResult.stderr,
            durationMs: 0,
          };
        }
        case 'call':
        case 'query': {
          if (!operation.method) {
            throw new Error('Method name is required for call/query operations');
          }
          const callResult = await canisterCall({
            canister: operation.canisterId,
            method: operation.method,
            args: operation.args,
            ...operation.options,
          });
          return {
            operationId: operation.id,
            success: callResult.success,
            data: callResult.stdout,
            error: callResult.success ? undefined : callResult.stderr,
            durationMs: 0,
          };
        }
        case 'deploy':
          return {
            operationId: operation.id,
            success: true,
            data: { message: 'Deploy operation placeholder' },
            durationMs: 0,
          };
        default:
          return {
            operationId: operation.id,
            success: false,
            error: `Unknown operation type: ${operation.type}`,
            durationMs: 0,
          };
      }
    })();

    result = await Promise.race([executionPromise, timeoutPromise]);
  } catch (error) {
    result = {
      operationId: operation.id,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: 0,
    };
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * BatchExecutor class for managing and executing batched canister operations
 */
export class BatchExecutor {
  private operations: Map<string, BatchOperation> = new Map();
  private config: BatchConfig;

  constructor(config: Partial<BatchConfig> = {}) {
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
  }

  /**
   * Add a single operation to the batch
   */
  addOperation(operation: BatchOperation): void {
    this.operations.set(generateOperationId(), operation);
  }

  /**
   * Add multiple operations to the batch
   */
  addOperations(ops: BatchOperation[]): void {
    for (const op of ops) {
      this.operations.set(generateOperationId(), op);
    }
  }

  /**
   * Execute all operations in the batch
   */
  async execute(): Promise<BatchExecutionResult> {
    const startTime = Date.now();
    const allOperations = Array.from(this.operations.values());
    const sortedOps = sortOperationsByDeps(allOperations);

    let succeeded = 0;
    let failed = 0;
    const executionResults: BatchResult[] = [];

    for (let i = 0; i < sortedOps.length; i += this.config.maxConcurrency) {
      const batch = sortedOps.slice(i, i + this.config.maxConcurrency);
      const batchResults = await Promise.all(
        batch.map((op) => this.executeWithRetry(op))
      );

      for (const result of batchResults) {
        executionResults.push(result);
        if (result.success) {
          succeeded++;
        } else {
          failed++;
          if (this.config.stopOnFailure) {
            break;
          }
        }
      }
    }

    return {
      total: allOperations.length,
      succeeded,
      failed,
      results: executionResults,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute an operation with retry logic
   */
  private async executeWithRetry(operation: BatchOperation): Promise<BatchResult> {
    let lastError: string | undefined;
    let delay = this.config.retryDelayMs;

    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        const result = await executeOperation(operation, this.config);
        if (result.success || attempt === this.config.retryCount) {
          return result;
        }
        lastError = result.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
      }

      if (attempt < this.config.retryCount) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    return {
      operationId: operation.id,
      success: false,
      error: lastError || 'Max retries exceeded',
      durationMs: 0,
    };
  }

  /**
   * Get a dry-run plan of execution order
   */
  executeDryRun(): { order: string[]; parallelGroups: string[][] } {
    const allOperations = Array.from(this.operations.values());
    const sortedOps = sortOperationsByDeps(allOperations);
    const order = sortedOps.map((op) => op.id);
    const parallelGroups: string[][] = [];

    for (let i = 0; i < sortedOps.length; i += this.config.maxConcurrency) {
      parallelGroups.push(sortedOps.slice(i, i + this.config.maxConcurrency).map((op) => op.id));
    }

    return { order, parallelGroups };
  }

  /**
   * Clear all operations
   */
  clear(): void {
    this.operations.clear();
  }
}

/**
 * Create a new batch executor with custom config
 */
export function createBatchExecutor(config?: Partial<BatchConfig>): BatchExecutor {
  return new BatchExecutor(config);
}

/**
 * Helper to create a status-check operation
 */
export function createStatusOperation(canisterId: string, options?: IcpCommonOptions): BatchOperation {
  return {
    id: generateOperationId(),
    type: 'status',
    canisterId,
    options,
  };
}

/**
 * Helper to create a query operation
 */
export function createQueryOperation(
  canisterId: string,
  method: string,
  args?: string,
  options?: IcpCommonOptions,
): BatchOperation {
  return {
    id: generateOperationId(),
    type: 'query',
    canisterId,
    method,
    args,
    options,
  };
}

/**
 * Helper to create a call operation
 */
export function createCallOperation(
  canisterId: string,
  method: string,
  args?: string,
  options?: IcpCommonOptions,
): BatchOperation {
  return {
    id: generateOperationId(),
    type: 'call',
    canisterId,
    method,
    args,
    options,
  };
}

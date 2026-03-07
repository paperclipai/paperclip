/**
 * Show command - Show agent state
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { NetworkType } from '../../src/deployment/types.js';
import { createICPClient } from '../../src/deployment/icpClient.js';

export interface ShowCommandOptions {
  network?: NetworkType;
  json?: boolean;
  tasks?: boolean;
  memories?: boolean;
  context?: boolean;
}

export interface CanisterState {
  canisterId: string;
  network: string;
  status: string;
  memorySize: bigint;
  cycles: bigint;
  lastUpdated?: string;
  tasks?: unknown[];
  memories?: unknown[];
  context?: Record<string, unknown>;
}

/**
 * Execute show command
 */
export async function executeShow(
  canisterId: string,
  options: ShowCommandOptions
): Promise<void> {
  const network = options.network ?? 'local';
  const resolvedCanisterId = canisterId.trim();

  // Validate canister ID
  if (!/^[a-z0-9-]{27}$/.test(resolvedCanisterId)) {
    throw new Error(
      `Invalid canister ID format: ${resolvedCanisterId}. Expected 27 characters of alphanumeric and hyphens.`
    );
  }

  const spinner = ora('Fetching agent state...').start();

  try {
    // Create ICP client
    const client = createICPClient({ network });

    // Check connection
    const connectionCheck = await client.checkConnection();
    if (!connectionCheck.connected) {
      throw new Error(
        `Failed to connect to ${network} network: ${connectionCheck.error ?? 'Unknown error'}`
      );
    }

    // Get canister status
    const status = await client.getCanisterStatus(resolvedCanisterId);

    spinner.succeed('Agent state fetched successfully!');

    // Build state object
    const state: CanisterState = {
      canisterId: resolvedCanisterId,
      network,
      status: status.status,
      memorySize: status.memorySize ?? 0n,
      cycles: status.cycles ?? 0n,
      lastUpdated: new Date().toISOString(),
    };

    if (options.tasks) {
      try {
        state.tasks = await client.callAgentMethod<unknown[]>(resolvedCanisterId, 'agent_get_tasks');
      } catch {
        state.tasks = [];
      }
    }

    if (options.memories) {
      try {
        state.memories = await client.callAgentMethod<unknown[]>(resolvedCanisterId, 'agent_get_memories');
      } catch {
        state.memories = [];
      }
    }

    if (options.context) {
      try {
        const context = await client.callAgentMethod<unknown>(resolvedCanisterId, 'getAllContext');
        state.context = (context as Record<string, unknown>) ?? {};
      } catch {
        state.context = {};
      }
    }

    // Display
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    displayState(state, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Show failed: ${message}`);
    throw error;
  }
}

/**
 * Format cycles for display
 */
function formatCycles(cycles: bigint): string {
  if (cycles >= BigInt(1_000_000_000_000)) {
    return `${(Number(cycles) / 1_000_000_000_000).toFixed(2)} T`;
  }
  if (cycles >= BigInt(1_000_000_000)) {
    return `${(Number(cycles) / 1_000_000_000).toFixed(2)} B`;
  }
  if (cycles >= BigInt(1_000_000)) {
    return `${(Number(cycles) / 1_000_000).toFixed(2)} M`;
  }
  return `${cycles.toString()}`;
}

/**
 * Format memory size for display
 */
function formatMemory(bytes: bigint): string {
  if (bytes >= BigInt(1024 * 1024 * 1024)) {
    return `${(Number(bytes) / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (bytes >= BigInt(1024 * 1024)) {
    return `${(Number(bytes) / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (bytes >= BigInt(1024)) {
    return `${(Number(bytes) / 1024).toFixed(2)} KiB`;
  }
  return `${bytes.toString()} B`;
}

/**
 * Display state
 */
export function displayState(state: CanisterState, options: ShowCommandOptions): void {
  console.log();
  console.log(chalk.cyan('Canister Status:'));
  console.log(`  ID:        ${chalk.bold(state.canisterId)}`);
  console.log(`  Network:   ${state.network}`);
  console.log(`  Status:    ${getStatusColor(state.status)}`);
  console.log(`  Cycles:    ${formatCycles(state.cycles)}`);
  console.log(`  Memory:    ${formatMemory(state.memorySize)}`);
  console.log(`  Updated:   ${state.lastUpdated ?? 'N/A'}`);

  if (options.tasks && state.tasks) {
    console.log();
    console.log(chalk.cyan(`Tasks (${state.tasks.length}):`));
    if (state.tasks.length === 0) {
      console.log('  No tasks found.');
    } else {
      for (const task of state.tasks) {
        const t = task as { id: string; status: string; description: string };
        console.log(`  - ${t.id}: ${t.status} - ${t.description}`);
      }
    }
  }

  if (options.memories && state.memories) {
    console.log();
    console.log(chalk.cyan(`Memories (${state.memories.length}):`));
    if (state.memories.length === 0) {
      console.log('  No memories found.');
    } else {
      for (const memory of state.memories) {
        const m = memory as { type: string; content: string };
        console.log(`  - ${m.type}: ${m.content.substring(0, 50)}...`);
      }
    }
  }

  if (options.context && state.context) {
    const keys = Object.keys(state.context);
    console.log();
    console.log(chalk.cyan(`Context (${keys.length} entries):`));
    if (keys.length === 0) {
      console.log('  No context entries found.');
    } else {
      for (const key of keys) {
        console.log(`  - ${key}: ${JSON.stringify(state.context[key])}`);
      }
    }
  }
}

/**
 * Get status with color
 */
function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return chalk.green('Running');
    case 'stopping':
      return chalk.yellow('Stopping');
    case 'stopped':
      return chalk.red('Stopped');
    default:
      return status;
  }
}

/**
 * Create show command
 */
export function showCommand(): Command {
  const command = new Command('show');

  command
    .description('Show agent state from canister')
    .argument('<canister-id>', 'canister ID to show state for')
    .option('-n, --network <network>', 'network (local or ic)', 'local')
    .option('-j, --json', 'output as JSON')
    .option('-t, --tasks', 'show task queue')
    .option('-m, --memories', 'show memories')
    .option('-c, --context', 'show context')
    .action(async (canisterId: string, options: ShowCommandOptions) => {
      console.log(chalk.bold('\n👁️  AgentVault Show\n'));

      try {
        await executeShow(canisterId, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}

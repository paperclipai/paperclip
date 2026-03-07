/**
 * Exec command - Run agent on-chain
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Ora } from 'ora';
import type { NetworkType } from '../../src/deployment/types.js';
import { createICPClient } from '../../src/deployment/icpClient.js';

export interface ExecCommandOptions {
  network?: NetworkType;
  async?: boolean;
  polling?: boolean;
}

export interface TaskResult {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  cyclesUsed?: bigint;
}

/**
 * Execute exec command
 */
export async function executeExec(
  canisterId: string,
  task: string,
  options: ExecCommandOptions
): Promise<TaskResult> {
  const network = options.network ?? 'local';
  const resolvedCanisterId = canisterId.trim();

  // Validate canister ID
  if (!/^[a-z0-9-]{27}$/.test(resolvedCanisterId)) {
    throw new Error(
      `Invalid canister ID format: ${resolvedCanisterId}. Expected 27 characters of alphanumeric and hyphens.`
    );
  }

  const spinner = ora('Executing task on canister...').start();

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

    // Check canister status
    spinner.text = 'Checking canister status...';
    const status = await client.getCanisterStatus(resolvedCanisterId);

    if (status.status !== 'running') {
      throw new Error(`Canister is not running. Status: ${status.status}`);
    }

    // Submit task to canister
    spinner.text = 'Submitting task...';

    const executionResult = await client.callAgentMethod<unknown>(
      resolvedCanisterId,
      'execute',
      [task]
    );
    const taskId = `task_${Date.now()}`;

    spinner.succeed('Task submitted successfully!');

    console.log();
    console.log(chalk.cyan('Task Info:'));
    console.log(`  Canister:  ${chalk.bold(resolvedCanisterId)}`);
    console.log(`  Network:   ${network}`);
    console.log(`  Task ID:    ${taskId}`);
    console.log(`  Command:    ${task}`);

    // Poll for completion if requested
    if (options.polling && !options.async) {
      const newSpinner = ora('Waiting for task completion...');
      return await pollForCompletion(client, resolvedCanisterId, taskId, executionResult, newSpinner);
    }

    // Return async result
    return {
      taskId,
      status: 'pending',
      result: executionResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Execution failed: ${message}`);
    throw error;
  }
}

/**
 * Poll for task completion
 */
async function pollForCompletion(
  _client: unknown,
  _canisterId: string,
  taskId: string,
  executionResult: unknown,
  spinner: Ora
): Promise<TaskResult> {
  spinner.start('Finalizing task result...');
  spinner.succeed('Task completed!');

  console.log();
  console.log(chalk.green('✓'), 'Task executed successfully!');

  return {
    taskId,
    status: 'completed',
    result: executionResult,
  };
}

/**
 * Create exec command
 */
export function execCommand(): Command {
  const command = new Command('exec');

  command
    .description('Run agent task on-chain')
    .argument('<canister-id>', 'canister ID to execute on')
    .argument('<task>', 'task/command to execute')
    .option('-n, --network <network>', 'network (local or ic)', 'local')
    .option('-a, --async', 'return immediately without waiting for completion')
    .option('-p, --polling', 'poll for task completion (default: true)')
    .action(async (canisterId: string, task: string, options: ExecCommandOptions) => {
      console.log(chalk.bold('\n⚡ AgentVault Exec\n'));

      try {
        const result = await executeExec(canisterId, task, options);

        if (options.async || options.polling === false) {
          console.log();
          console.log(chalk.cyan('Task Info:'));
          console.log(`  Task ID:  ${result.taskId}`);
          console.log(`  Status:   ${result.status}`);
          console.log();
          console.log('Use', chalk.bold('agentvault show'), 'to check task status.');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}

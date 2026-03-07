/**
 * Info Command
 *
 * Displays detailed canister information.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getCanisterInfo } from '../../src/monitoring/info.js';
import type { MonitoringOptions } from '../../src/monitoring/types.js';

export function infoCommand(): Command {
  const command = new Command('info');

  command
    .description('Display canister information and status')
    .argument('<canister-id>', 'Canister ID to query')
    .option('-t, --thresholds <json>', 'Health check thresholds as JSON')
    .option('-i, --interval <ms>', 'Polling interval in milliseconds')
    .option('--max-alerts <n>', 'Maximum number of alerts to display');

  command
    .action(async (canisterId: string, options: any) => {
      const thresholds = options.thresholds ? JSON.parse(options.thresholds) : undefined;
      const monitoringOpts: MonitoringOptions = {
        canister: canisterId,
        thresholds,
        pollInterval: options.interval ? parseInt(options.interval) : undefined,
        maxSnapshots: options.maxAlerts ? parseInt(options.maxAlerts) : undefined,
      };

      const spinner = ora('Fetching canister info...').start();

      try {
        const statusInfo = await getCanisterInfo(canisterId, monitoringOpts);
        spinner.succeed('Canister info retrieved successfully');
        displayInfo(statusInfo);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(`Failed to fetch info: ${message}`);
        throw error;
      }
    });

  return command;
}

function displayInfo(statusInfo: any): void {
  console.log();
  console.log(chalk.cyan('Canister ID:'), chalk.bold(statusInfo.canisterId));
  console.log();
  console.log(chalk.cyan('Status:'), chalk.bold(statusInfo.status));
  if (statusInfo.memorySize !== undefined) {
    const memoryMB = Number(statusInfo.memorySize) / (1024 * 1024);
    console.log(chalk.cyan('Memory:'), chalk.bold(`${memoryMB.toFixed(2)} MB`));
  }
  if (statusInfo.cycles !== undefined) {
    console.log(chalk.cyan('Cycles:'), chalk.bold(statusInfo.cycles.toString()));
  }
  if (statusInfo.moduleHash !== undefined) {
    console.log(chalk.cyan('WASM Hash:'), chalk.bold(statusInfo.moduleHash.substring(0, 16)));
  }
  console.log();
  console.log(chalk.cyan('Timestamp:'), statusInfo.timestamp?.toISOString() || 'N/A');
}

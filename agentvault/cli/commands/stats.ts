/**
 * Stats Command
 *
 * Displays resource usage statistics for a canister over time.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getCanisterInfo } from '../../src/monitoring/info.js';

export function statsCommand(): Command {
  const command = new Command('stats');

  command
    .description('Display resource usage statistics')
    .argument('<canister-id>', 'Canister ID to analyze')
    .option('-p, --period <duration>', 'Time period (e.g. 24h, 7d)')
    .option('--snapshots <n>', 'Number of snapshots to analyze');

  command
    .action(async (canisterId: string) => {
      const statusInfo = await getCanisterInfo(canisterId, { canister: canisterId });

      if (!statusInfo.cycles) {
        console.log(chalk.yellow('No cycles data available for this canister'));
        return;
      }

      console.log();
      console.log(chalk.cyan('Resource Statistics'));
      console.log(`  Canister: ${chalk.bold(statusInfo.canisterId)}`);
      console.log(`  Current Cycles: ${chalk.bold(statusInfo.cycles.toString())}`);
      console.log(`  Current Memory: ${statusInfo.memorySize ? `${(Number(statusInfo.memorySize) / (1024 * 1024)).toFixed(2)} MB` : 'N/A'}`);
      console.log();
      console.log(chalk.yellow('Historical data not yet implemented'));
      console.log(chalk.gray('Use --period and --snapshots to analyze trends over time'));
    });

  return command;
}

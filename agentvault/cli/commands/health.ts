/**
 * Health Command
 *
 * Checks canister health and displays alerts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkHealth, checkThoughtFormHealth, getRecentAlerts } from '../../src/monitoring/index.js';
import type { MonitoringOptions, ThoughtFormHealthStatus } from '../../src/monitoring/types.js';

export function healthCommand(): Command {
  const command = new Command('health');

  command
    .description('Check canister health and display alerts')
    .argument('<canister-id>', 'Canister ID to check')
    .option('-t, --thresholds <json>', 'Health check thresholds as JSON')
    .option('-i, --interval <ms>', 'Polling interval in milliseconds')
    .option('--max-alerts <n>', 'Maximum alerts to display')
    .option('--clear', 'Clear all alerts for canister')
    .option('-w, --watch', 'Watch canister health continuously')
    .option('--health <type>', 'Health check type (e.g. "thoughtform")')
    .option('--stale-hours <hours>', 'Stale threshold in hours for ThoughtForm check (default: 24)')
    .option('--host <url>', 'ICP host URL override');

  command
    .action(async (canisterId: string, options: any) => {
      if (options.health === 'thoughtform') {
        await runThoughtFormHealthCheck(canisterId, options);
        return;
      }

      const thresholds = options.thresholds ? JSON.parse(options.thresholds) : undefined;
      const monitoringOpts: MonitoringOptions = {
        canister: canisterId,
        thresholds,
        pollInterval: options.interval ? parseInt(options.interval) : undefined,
        maxSnapshots: options.maxAlerts ? parseInt(options.maxAlerts) : 10,
      };

      const spinner = ora('Checking canister health...').start();

      try {
        const statusInfo = await checkHealth(canisterId, monitoringOpts);
        spinner.succeed('Health check completed');
        displayHealth(statusInfo);

        const alerts = await getRecentAlerts(canisterId, monitoringOpts.maxSnapshots || 10);
        if (alerts.length > 0) {
          console.log();
          console.log(chalk.cyan('Recent Alerts:'));
          for (const alert of alerts) {
            const severityColor =
              alert.severity === 'critical'
                ? chalk.red
                : alert.severity === 'warning'
                ? chalk.yellow
                : chalk.gray;
            console.log(
              `  [${new Date(alert.timestamp).toISOString()}]`,
              `  ${severityColor(alert.severity)} ${alert.severity.toUpperCase()}:`,
              `  Canister: ${alert.canisterId}`,
              `  Metric: ${alert.metric}`,
              `  Value: ${alert.value}`,
              `  Threshold: ${alert.threshold}`
            );
          }
        } else {
          console.log(chalk.gray('No recent alerts'));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(`Health check failed: ${message}`);
        throw error;
      }
    });

  return command;
}

async function runThoughtFormHealthCheck(canisterId: string, options: any): Promise<void> {
  const staleHours = options.staleHours ? parseInt(options.staleHours) : 24;
  const spinner = ora('Checking ThoughtForm store health...').start();

  try {
    const result: ThoughtFormHealthStatus = await checkThoughtFormHealth({
      canisterId,
      staleThresholdHours: staleHours,
      host: options.host,
    });

    if (result.status === 'OK') {
      spinner.succeed('ThoughtForm health check passed');
    } else if (result.status === 'WARN') {
      spinner.warn('ThoughtForm health check warning');
    } else {
      spinner.fail('ThoughtForm health check failed');
    }

    displayThoughtFormHealth(result);

    if (result.status !== 'OK') {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`ThoughtForm health check failed: ${message}`);
    throw error;
  }
}

function displayThoughtFormHealth(result: ThoughtFormHealthStatus): void {
  console.log();
  const statusColor =
    result.status === 'OK' ? chalk.green
    : result.status === 'WARN' ? chalk.yellow
    : chalk.red;
  console.log(chalk.cyan('Status:'), statusColor(result.status));
  console.log(chalk.cyan('Canister:'), chalk.bold(result.canisterId));
  console.log(chalk.cyan('Entry Count:'), chalk.bold(result.count.toString()));
  if (result.latestTimestamp > 0) {
    const tsMs = result.latestTimestamp > 1e15 ? result.latestTimestamp / 1e6 : result.latestTimestamp;
    console.log(chalk.cyan('Latest Timestamp:'), chalk.bold(new Date(tsMs).toISOString()));
  } else {
    console.log(chalk.cyan('Latest Timestamp:'), chalk.gray('N/A'));
  }
  if (result.message) {
    console.log(chalk.cyan('Message:'), chalk.yellow(result.message));
  }
}

function displayHealth(statusInfo: any): void {
  console.log();
  console.log(chalk.cyan('Canister Status:'), chalk.bold(statusInfo.status));
  console.log();
  console.log(chalk.cyan('Health Check:'), statusInfo.health === 'healthy' ? chalk.green('Passed') : chalk.red('Failed'));
  if (statusInfo.memorySize !== undefined) {
    const memoryMB = Number(statusInfo.memorySize) / ( 1024 * 1024);
    console.log(chalk.cyan('Memory:'), chalk.bold(`${memoryMB.toFixed(2)} MB`));
  }
  if (statusInfo.cycles !== undefined) {
    console.log(chalk.cyan('Cycles:'), chalk.bold(statusInfo.cycles.toString()));
  }
}

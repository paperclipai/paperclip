/**
 * Logs CLI commands
 *
 * Provides commands for viewing, filtering, and exporting canister logs
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getLogs, exportLogs, clearLogs } from '../../src/debugging/logs.js';
import type { LogLevel } from '../../src/debugging/types.js';

export const logsCmd = new Command('logs');

logsCmd
  .description('View and manage canister logs')
  .argument('<canister-id>', 'Canister ID')
  .option('-t, --tail', 'Tail logs (follow mode)', false)
  .option('-f, --filter <pattern>', 'Filter logs by pattern')
  .option('-l, --level <level>', 'Filter by log level (info, warning, error, debug)')
  .option('-s, --since <time>', 'Show logs since timestamp')
  .option('-n, --limit <num>', 'Limit number of log entries')
  .option('-e, --export <file>', 'Export logs to file')
  .option('--format <format>', 'Export format (json, csv)', 'json')
  .option('--clear', 'Clear all logs for this canister', false)
  .action(async (canisterId, options) => {
    if (options.clear) {
      const spinner = ora(`Clearing logs for ${canisterId}...`).start();
      try {
        await clearLogs(canisterId);
        spinner.succeed(chalk.green('Logs cleared'));
        return;
      } catch (error) {
        spinner.fail(chalk.red('Failed to clear logs'));
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(message));
        process.exit(1);
      }
    }

    const spinner = ora('Fetching logs...').start();

    try {
      const since = options.since ? new Date(options.since) : undefined;
      const level = options.level as LogLevel | undefined;
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;

      const logs = await getLogs(canisterId, {
        since,
        level,
        pattern: options.filter,
        limit,
      });

      spinner.stop();

      if (logs.length === 0) {
        console.log(chalk.yellow('No logs found'));
        return;
      }

      if (options.export) {
        const exportSpinner = ora(`Exporting logs to ${options.export}...`).start();
        try {
          await exportLogs(canisterId, options.export, options.format as 'json' | 'csv');
          exportSpinner.succeed(chalk.green(`Logs exported to ${options.export}`));
          return;
        } catch (error) {
          exportSpinner.fail(chalk.red('Failed to export logs'));
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error(chalk.red(message));
          process.exit(1);
        }
      }

      const levelColors: Record<LogLevel, (str: string) => string> = {
        info: chalk.blue,
        warning: chalk.yellow,
        error: chalk.red,
        debug: chalk.gray,
      };

      for (const log of logs) {
        const levelColor = levelColors[log.level];
        const timestamp = log.timestamp.toISOString();
        const level = log.level.toUpperCase().padEnd(7);
        const method = log.method ? ` [${log.method}]` : '';
        
        console.log(levelColor(`${timestamp} [${level}]${method}`));
        console.log(`  ${log.message}`);
        
        if (log.context && Object.keys(log.context).length > 0) {
          console.log(chalk.gray('  Context: ' + JSON.stringify(log.context, null, 2).split('\n').join('\n  ')));
        }
        
        console.log();
      }

      if (!options.tail) {
        console.log(chalk.gray(`Showing ${logs.length} log entries`));
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to fetch logs'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

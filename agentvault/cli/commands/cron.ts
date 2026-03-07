/**
 * Cron command — fault-tolerance automation
 *
 * Subcommands:
 *   cron check <canister-id>    Probe canister; restore from backup if dead
 *   cron install <canister-id>  Print (or write) the crontab line for daily checks
 *   cron status                 Show last cron run result
 *
 * Typical usage installed via `cron install`:
 *   1 0 * * * agentvault cron check <id> --network ic >> ~/.agentvault/cron.log 2>&1
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  runCronCheck,
  buildCronLine,
  readCronState,
  type CronCheckOptions,
} from '../../src/fault-tolerance/cron-check.js';

export function cronCmd(): Command {
  const cron = new Command('cron');
  cron.description('Fault-tolerance automation: daily liveness check and auto-restore');

  // ── cron check ──────────────────────────────────────────────────────────────

  cron
    .command('check <canister-id>')
    .description('Probe canister liveness; restore from local backup if dead')
    .option('-a, --agent <name>', 'Agent name (used to narrow backup search)')
    .option('-n, --network <network>', 'ICP network: local | ic', 'ic')
    .option('--dry-run', 'Check only — do NOT trigger restore', false)
    .option('-j, --json', 'Output result as JSON')
    .action(async (canisterId: string, options: {
      agent?: string;
      network: string;
      dryRun: boolean;
      json?: boolean;
    }) => {
      const spinner = ora(`Checking canister ${canisterId}...`).start();

      const opts: CronCheckOptions = {
        canisterId,
        agentName: options.agent,
        network: options.network,
        dryRun: options.dryRun,
      };

      try {
        const result = await runCronCheck(opts);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // ── Human-readable output ──
        const livenessColor = {
          alive: chalk.green,
          dead: chalk.red,
          unknown: chalk.yellow,
        }[result.liveness];

        console.log(chalk.bold('\nCron Check Result\n'));
        console.log(chalk.cyan('Canister:'), canisterId);
        console.log(chalk.cyan('Liveness:'), livenessColor(result.liveness.toUpperCase()));

        if (result.action === 'restore-attempted' && result.restore) {
          const r = result.restore;
          if (r.success) {
            console.log(chalk.green('\nRestore: SUCCESS'));
            console.log(chalk.gray(`  Backup: ${r.backupPath}`));
            console.log(chalk.gray(`  Agent:  ${r.agentName}`));
          } else {
            console.log(chalk.red('\nRestore: FAILED'));
            console.log(chalk.red(`  Error:  ${r.error}`));
            process.exitCode = 1;
          }
        } else if (result.action === 'restore-skipped') {
          console.log(chalk.yellow('\nRestore skipped (dry-run mode)'));
        } else if (result.liveness === 'alive') {
          console.log(chalk.green('\nCanister is alive — no action needed'));
        } else if (result.liveness === 'unknown') {
          console.log(chalk.yellow('\nCould not determine canister status — skipping restore'));
        }

        const s = result.cronState;
        console.log();
        console.log(chalk.gray(`Last check: ${s.lastCheckISO}`));
        if (s.consecutiveFailures > 0) {
          console.log(chalk.red(`Consecutive failures: ${s.consecutiveFailures}`));
        }
      } catch (err) {
        spinner.fail(chalk.red('Cron check failed'));
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(msg));
        process.exitCode = 1;
      }
    });

  // ── cron install ─────────────────────────────────────────────────────────────

  cron
    .command('install <canister-id>')
    .description('Print the crontab line for the daily liveness check')
    .option('-a, --agent <name>', 'Agent name')
    .option('-n, --network <network>', 'ICP network: local | ic', 'ic')
    .option('-t, --time <expr>', 'Cron time expression', '1 0 * * *')
    .option('--bin <path>', 'Full path to agentvault binary (default: agentvault)')
    .action((canisterId: string, options: {
      agent?: string;
      network: string;
      time: string;
      bin?: string;
    }) => {
      const line = buildCronLine({
        canisterId,
        agentName: options.agent,
        network: options.network,
        cronTime: options.time,
        cliBin: options.bin,
      });

      console.log(chalk.bold('\nAdd this line to your crontab (crontab -e):\n'));
      console.log(chalk.cyan(line));
      console.log();
      console.log(chalk.gray('To append automatically, run:'));
      console.log(chalk.gray(`  (crontab -l 2>/dev/null; echo "${line}") | crontab -`));
    });

  // ── cron status ──────────────────────────────────────────────────────────────

  cron
    .command('status')
    .description('Show the result of the last cron check run')
    .option('-j, --json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const state = readCronState();

      if (!state) {
        console.log(chalk.yellow('No cron check has run yet (no state file found).'));
        console.log(chalk.gray("Run 'agentvault cron check <canister-id>' to create one."));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      const resultColor = {
        alive: chalk.green,
        restored: chalk.green,
        'restore-failed': chalk.red,
        'no-backup': chalk.yellow,
      }[state.lastCheckResult] ?? chalk.gray;

      console.log(chalk.bold('\nLast Cron Check\n'));
      console.log(chalk.cyan('Time:    '), state.lastCheckISO);
      console.log(chalk.cyan('Result:  '), resultColor(state.lastCheckResult));
      if (state.consecutiveFailures > 0) {
        console.log(chalk.red(`Consecutive failures: ${state.consecutiveFailures}`));
      }
      if (state.lastRestoreISO) {
        console.log(chalk.cyan('Restored:'), state.lastRestoreISO);
        console.log(chalk.cyan('Backup:  '), state.lastRestoreBackup);
      }
    });

  return cron;
}

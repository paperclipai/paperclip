/**
 * Mirror command — ICP canister state mirroring
 *
 * Subcommands:
 *   mirror set    <primary-id> <mirror-id>   Register mirror canister on primary
 *   mirror sync   [primary-id] [mirror-id]   Push state: primary → mirror
 *   mirror restore [primary-id] [mirror-id]  Pull state: mirror → primary (disaster recovery)
 *   mirror status                            Show mirror config and liveness
 *   mirror clear  <primary-id>               Remove mirror registration from primary
 *
 * Both primary and mirror must run the same canister WASM (agent.mo) so they
 * both expose receiveSync() and exportSyncState().
 *
 * WARNING: syncToMirror / syncFromMirror are inter-canister calls and consume
 * cycles on both sides. Use judiciously (e.g. scheduled, not per-task).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  setMirrorCanister,
  syncToMirror,
  syncFromMirror,
  getMirrorStatus,
  loadMirrorConfig,
  deleteMirrorConfig,
} from '../../src/fault-tolerance/mirror-sync.js';

export function mirrorCmd(): Command {
  const mirror = new Command('mirror');
  mirror.description('Mirror agent state to a second ICP canister for fault tolerance');

  // ── mirror set ────────────────────────────────────────────────────────────────

  mirror
    .command('set <primary-id> <mirror-id>')
    .description('Register a mirror canister on the primary (inter-canister call + local config)')
    .option('-n, --network <network>', 'ICP network: local | ic', 'ic')
    .option('-j, --json', 'Output as JSON')
    .action(async (primaryId: string, mirrorId: string, options: { network: string; json?: boolean }) => {
      const spinner = ora(`Registering mirror ${mirrorId} on primary ${primaryId}...`).start();

      try {
        const result = await setMirrorCanister(primaryId, mirrorId, options.network);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.success) {
          console.log(chalk.green('\nMirror registered successfully'));
          console.log(chalk.cyan('Primary:'), primaryId);
          console.log(chalk.cyan('Mirror: '), mirrorId);
          console.log(chalk.cyan('Network:'), options.network);
          console.log();
          console.log(chalk.gray("Run 'agentvault mirror sync' to push current state to the mirror."));
        } else {
          console.log(chalk.red('\nFailed to register mirror'));
          console.log(chalk.red(result.error ?? 'Unknown error'));
          process.exitCode = 1;
        }
      } catch (err) {
        spinner.fail(chalk.red('Mirror set failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  // ── mirror sync (push: primary → mirror) ─────────────────────────────────────

  mirror
    .command('sync [primary-id] [mirror-id]')
    .description('Push state from primary → mirror (uses saved config if IDs omitted)')
    .option('-n, --network <network>', 'ICP network: local | ic')
    .option('-j, --json', 'Output as JSON')
    .action(async (primaryArg: string | undefined, mirrorArg: string | undefined, options: { network?: string; json?: boolean }) => {
      // Fall back to saved config
      const cfg = loadMirrorConfig();
      const primaryId = primaryArg ?? cfg?.primaryCanisterId;
      const mirrorId  = mirrorArg  ?? cfg?.mirrorCanisterId;
      const network   = options.network ?? cfg?.network ?? 'ic';

      if (!primaryId || !mirrorId) {
        console.error(chalk.red('Primary and mirror canister IDs required. Run "mirror set" first or pass them as arguments.'));
        process.exitCode = 1;
        return;
      }

      const spinner = ora(`Syncing state: ${primaryId} → ${mirrorId}...`).start();

      try {
        const result = await syncToMirror(primaryId, mirrorId, network);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.success) {
          console.log(chalk.green('\nSync successful (primary → mirror)'));
          console.log(chalk.cyan('Primary:  '), primaryId);
          console.log(chalk.cyan('Mirror:   '), mirrorId);
          console.log(chalk.cyan('Synced at:'), result.syncedAt);
        } else {
          console.log(chalk.red('\nSync failed'));
          console.log(chalk.red(result.error ?? 'Unknown error'));
          process.exitCode = 1;
        }
      } catch (err) {
        spinner.fail(chalk.red('Sync failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  // ── mirror restore (pull: mirror → primary) ───────────────────────────────────

  mirror
    .command('restore [primary-id] [mirror-id]')
    .description('Pull state from mirror → primary (disaster recovery after total wipe)')
    .option('-n, --network <network>', 'ICP network: local | ic')
    .option('-j, --json', 'Output as JSON')
    .action(async (primaryArg: string | undefined, mirrorArg: string | undefined, options: { network?: string; json?: boolean }) => {
      const cfg = loadMirrorConfig();
      const primaryId = primaryArg ?? cfg?.primaryCanisterId;
      const mirrorId  = mirrorArg  ?? cfg?.mirrorCanisterId;
      const network   = options.network ?? cfg?.network ?? 'ic';

      if (!primaryId || !mirrorId) {
        console.error(chalk.red('Primary and mirror canister IDs required. Run "mirror set" first or pass them as arguments.'));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.yellow('\nWARNING: This will overwrite ALL state on the primary canister with the mirror snapshot.'));
      console.log(chalk.yellow('Only use this after a confirmed total wipe of the primary.\n'));

      const spinner = ora(`Restoring state: ${mirrorId} → ${primaryId}...`).start();

      try {
        const result = await syncFromMirror(primaryId, mirrorId, network);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.success) {
          console.log(chalk.green('\nRestore successful (mirror → primary)'));
          console.log(chalk.cyan('Source (mirror): '), mirrorId);
          console.log(chalk.cyan('Target (primary):'), primaryId);
          console.log(chalk.cyan('Restored at:     '), result.syncedAt);
        } else {
          console.log(chalk.red('\nRestore failed'));
          console.log(chalk.red(result.error ?? 'Unknown error'));
          process.exitCode = 1;
        }
      } catch (err) {
        spinner.fail(chalk.red('Restore failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  // ── mirror status ─────────────────────────────────────────────────────────────

  mirror
    .command('status')
    .description('Show mirror configuration and liveness of both canisters')
    .option('-n, --network <network>', 'ICP network override')
    .option('-j, --json', 'Output as JSON')
    .action(async (options: { network?: string; json?: boolean }) => {
      const spinner = ora('Checking mirror status...').start();

      try {
        const result = await getMirrorStatus(options.network);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (!result.configured) {
          console.log(chalk.yellow('\nNo mirror configured.'));
          console.log(chalk.gray("Run 'agentvault mirror set <primary-id> <mirror-id>' to set one up."));
          return;
        }

        const alive = (v: boolean | undefined) =>
          v === true ? chalk.green('alive') : v === false ? chalk.red('unreachable') : chalk.gray('unknown');

        console.log(chalk.bold('\nMirror Status\n'));
        console.log(chalk.cyan('Primary canister:'), result.primaryCanisterId, alive(result.primaryAlive));
        console.log(chalk.cyan('Mirror canister: '), result.mirrorCanisterId,  alive(result.mirrorAlive));
        console.log(chalk.cyan('Network:         '), result.network);
        console.log(chalk.cyan('Registered at:   '), result.registeredAt);
        console.log();

        if (!result.primaryAlive && result.mirrorAlive) {
          console.log(chalk.red('Primary is down but mirror is alive!'));
          console.log(chalk.yellow("Run 'agentvault mirror restore' to recover from mirror."));
        } else if (!result.primaryAlive && !result.mirrorAlive) {
          console.log(chalk.red('Both canisters unreachable. Restore from local backup:'));
          console.log(chalk.gray("  agentvault backup import <latest-backup.json>"));
        } else if (result.primaryAlive && !result.mirrorAlive) {
          console.log(chalk.yellow('Mirror is unreachable. Check mirror canister cycles/status.'));
        }
      } catch (err) {
        spinner.fail(chalk.red('Status check failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  // ── mirror clear ──────────────────────────────────────────────────────────────

  mirror
    .command('clear <primary-id>')
    .description('Remove mirror registration from primary canister and local config')
    .option('-n, --network <network>', 'ICP network: local | ic', 'ic')
    .action(async (primaryId: string, options: { network: string }) => {
      const spinner = ora(`Clearing mirror on ${primaryId}...`).start();

      try {
        // Best-effort: call clearMirrorCanister on the primary
        const { createICPClient } = await import('../../src/deployment/icpClient.js');
        const client = createICPClient({ network: options.network as 'local' | 'ic' });
        await client.callAgentMethod(primaryId, 'clearMirrorCanister', []).catch(() => {
          // Non-fatal — local config still cleared below
        });

        deleteMirrorConfig();
        spinner.succeed(chalk.green('Mirror configuration cleared'));
      } catch (err) {
        spinner.fail(chalk.red('Clear failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  return mirror;
}

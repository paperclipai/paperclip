/**
 * agentvault repo — Repository security and audit commands
 *
 * Subcommands:
 *   repo audit --branch <branch-id>   Show the full MFA audit log (local + ICP)
 *   repo status --branch <branch-id>  Show branch security posture
 *   repo flush-queue                  Retry ICP audit submissions that failed earlier
 *
 * Examples:
 *   agentvault repo audit --branch pending-001
 *   agentvault repo audit --branch pending-001 --json
 *   agentvault repo audit --branch pending-001 --source icp
 *   agentvault repo status --branch pending-001
 *   agentvault repo flush-queue
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getMfaAuditLog, getMfaStatus, getDeviceFingerprint } from '../../src/security/mfa-approval.js';
import { queryIcpAuditLog, flushIcpAuditQueue, getIcpQueueDepth } from '../../src/security/icp-audit.js';
import type { MfaAuditEntry } from '../../src/security/mfa-approval.js';

const repoCmd = new Command('repo');

repoCmd
  .description('Repository security, audit, and integrity commands');

// ─── repo audit ──────────────────────────────────────────────────────────────

repoCmd
  .command('audit')
  .description(
    'Show the complete MFA audit log for a branch.\n' +
    'Merges local YAML records with on-chain ICP entries for a unified view.\n\n' +
    'Every nonce, challenge hash, and HMAC audit token is displayed so you can\n' +
    'verify exactly who approved what and when.',
  )
  .requiredOption('--branch <branch-id>', 'Branch identifier (e.g. pending-001)')
  .option('--json', 'Output raw JSON (suitable for piping to jq)')
  .option(
    '--source <source>',
    'Where to read from: "local" (YAML only), "icp" (on-chain only), "all" (merged, default)',
    'all',
  )
  .option('--no-dedup', 'Show duplicate entries (same id from both sources)')
  .action(async (options) => {
    const spinner = ora(`Loading audit log for branch '${options.branch}'…`).start();

    try {
      let entries: MfaAuditEntry[] = [];

      if (options.source === 'local' || options.source === 'all') {
        entries = getMfaAuditLog(options.branch);
      }

      if (options.source === 'icp' || options.source === 'all') {
        spinner.text = 'Querying ICP canister for on-chain audit entries…';
        const icpEntries = await queryIcpAuditLog(options.branch);

        if (options.source === 'icp') {
          entries = icpEntries;
        } else {
          // Merge: ICP entries take precedence, de-duplicate by id
          const localIds = new Set(entries.map((e) => e.id));
          const merged = [...entries];
          for (const e of icpEntries) {
            if (!localIds.has(e.id)) {
              merged.push(e);
            }
          }
          // Sort by timestamp
          entries = merged.sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );
        }
      }

      spinner.succeed(
        chalk.green(
          `${entries.length} audit entry(ies) for branch '${options.branch}' ` +
          `[source: ${options.source}]`,
        ),
      );

      if (entries.length === 0) {
        console.log(chalk.gray('  No events recorded yet.'));
        console.log(
          chalk.gray(
            `  Run: ${chalk.cyan(`agentvault approve mfa setup --branch ${options.branch}`)} to initialise MFA.`,
          ),
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      // ── Human-readable output ────────────────────────────────────────────
      const eventColor: Record<string, (s: string) => string> = {
        approved:              (s) => chalk.green(s),
        'approved-biometric':  (s) => chalk.green(s),
        rejected:              (s) => chalk.red(s),
        'anomaly-detected':    (s) => chalk.magenta(s),
        'anomaly-ping-sent':   (s) => chalk.magenta(s),
        'branch-locked':       (s) => chalk.red(s),
        'branch-unlocked':     (s) => chalk.green(s),
        'rate-limit-exceeded': (s) => chalk.yellow(s),
        'challenge-issued':    (s) => chalk.blue(s),
        setup:                 (s) => chalk.cyan(s),
      };

      const eventIcon: Record<string, string> = {
        approved:              '✓',
        'approved-biometric':  '✓ biometric',
        rejected:              '✗',
        'anomaly-detected':    '⚠',
        'anomaly-ping-sent':   '⚑',
        'branch-locked':       '🔒',
        'branch-unlocked':     '🔓',
        'rate-limit-exceeded': '⏱',
        'challenge-issued':    '↗',
        setup:                 '★',
      };

      console.log(chalk.bold(`\n  Audit trail — ${options.branch}`));
      console.log(chalk.gray('  ─'.repeat(40)));

      for (const e of entries) {
        const colorFn = eventColor[e.event] ?? ((s: string) => chalk.gray(s));
        const icon = eventIcon[e.event] ?? '·';

        console.log(
          `\n  ${chalk.bold(e.id)}  ${colorFn(`${icon}  ${e.event}`)}`,
        );
        console.log(`    ${chalk.gray('Request:')}   ${e.requestId}`);
        console.log(`    ${chalk.gray('Time:')}      ${e.timestamp}`);
        if (e.nonce !== undefined)      console.log(`    ${chalk.gray('Nonce:')}     ${e.nonce}`);
        if (e.challengeHash)            console.log(`    ${chalk.gray('Hash:')}      ${chalk.gray(e.challengeHash)}`);
        if (e.auditToken)               console.log(`    ${chalk.gray('AuditTok:')}  ${chalk.cyan(e.auditToken)}`);
        if (e.deviceFingerprint)        console.log(`    ${chalk.gray('Device:')}    ${chalk.gray(e.deviceFingerprint)}`);
        if (e.detail)                   console.log(`    ${chalk.gray('Detail:')}    ${chalk.gray(e.detail)}`);
      }

      console.log(chalk.gray('\n  ─'.repeat(40)));
      console.log(
        chalk.gray(
          `  To verify on-chain: set AGENTVAULT_CANISTER_ID and run with --source icp\n` +
          `  AuditTokens are HMAC-SHA256 over (nonce:requestId:branchId:timestamp)\n` +
          `  bound to the branch TOTP secret — forgery requires the secret.`,
        ),
      );

    } catch (error) {
      spinner.fail(chalk.red('Failed to load audit log'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── repo status ─────────────────────────────────────────────────────────────

repoCmd
  .command('status')
  .description('Show the current security posture for a branch')
  .requiredOption('--branch <branch-id>', 'Branch to inspect')
  .action(async (options) => {
    const status = getMfaStatus(options.branch);
    const queueDepth = getIcpQueueDepth();

    if (!status.configured) {
      console.log(chalk.yellow(`\n  MFA not configured for branch '${options.branch}'.`));
      console.log(chalk.gray(`  Run: agentvault approve mfa setup --branch ${options.branch}`));
      return;
    }

    const lockLabel = status.locked
      ? chalk.red('LOCKED (anomaly detected — run: agentvault approve mfa unlock)')
      : chalk.green('unlocked');

    console.log(chalk.bold(`\n  Security posture — ${options.branch}`));
    console.log(`  State:          ${lockLabel}`);
    console.log(`  Current nonce:  ${status.currentNonce}`);
    console.log(`  Used nonces:    ${status.usedNonceCount}`);
    console.log(`  Created:        ${status.createdAt ?? 'unknown'}`);
    console.log(`  Device:         ${chalk.gray(getDeviceFingerprint())}`);

    if (queueDepth > 0) {
      console.log(
        `  ICP queue:      ${chalk.yellow(`${queueDepth} entries pending — run: agentvault repo flush-queue`)}`,
      );
    } else {
      console.log(`  ICP queue:      ${chalk.green('empty (all entries submitted)')}`);
    }
  });

// ─── repo flush-queue ────────────────────────────────────────────────────────

repoCmd
  .command('flush-queue')
  .description('Retry ICP audit submissions that previously failed (network errors, canister offline)')
  .action(async () => {
    const depth = getIcpQueueDepth();
    if (depth === 0) {
      console.log(chalk.green('ICP audit queue is empty — nothing to flush.'));
      return;
    }

    const spinner = ora(`Flushing ${depth} queued ICP audit entries…`).start();
    try {
      const flushed = await flushIcpAuditQueue();
      const remaining = getIcpQueueDepth();

      if (flushed > 0) {
        spinner.succeed(chalk.green(`Flushed ${flushed} entry(ies) to ICP.`));
      } else {
        spinner.warn(chalk.yellow('No entries flushed — ICP may still be unreachable.'));
      }

      if (remaining > 0) {
        console.log(chalk.gray(`  ${remaining} entry(ies) still queued for retry.`));
      }
    } catch (error) {
      spinner.fail(chalk.red('Flush failed'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

export { repoCmd };

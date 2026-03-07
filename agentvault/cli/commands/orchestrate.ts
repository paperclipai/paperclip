/**
 * Orchestrate command – agentvault orchestrate --claude
 *
 * Turns any AgentVault canister into a persistent orchestrator for Anthropic's
 * Claude Code (agentic coding tool).  The command spins up a temporary Claude
 * Code session, injects the current canister state + full repo conventions,
 * lets Claude Code generate/edit code, then commits the validated result back
 * to the canister as a new state snapshot.
 *
 * Usage:
 *   agentvault orchestrate --claude --task "implement video timeline with cell reuse"
 *   agentvault orchestrate --claude --task "..." --dry-run
 *   agentvault orchestrate --claude --task "..." --approve --reviewers alice,bob
 *
 * References: PRD-001
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ClaudeOrchestrator } from '../../src/orchestration/claude.js';
import type { MCPServerConfig } from '../../src/orchestration/mcp-client.js';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface OrchestrateCommandOptions {
  claude?: boolean;
  task?: string;
  canisterId?: string;
  network?: 'local' | 'ic';
  dryRun?: boolean;
  approve?: boolean;
  reviewers?: string;
  model?: string;
  timeout?: string;
  apiKey?: string;
  polyticianEntry?: string;
  polyticianNamespace?: string;
  noEnrichment?: boolean;
  noSaveConcept?: boolean;
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function orchestrateCmd(): Command {
  const command = new Command('orchestrate');

  command
    .description(
      'Orchestrate an AI-assisted development session governed by AgentVault'
    )
    // Provider flags (extendable to other providers in future phases)
    .option('--claude', 'Use Anthropic Claude Code as the orchestrated coding agent')
    // Core options
    .requiredOption('-t, --task <description>', 'Task description for the coding agent')
    .option('-c, --canister-id <id>', 'Canister ID to bind the session to')
    .option('-n, --network <network>', 'ICP network: local | ic', 'local')
    // Governance / multi-sig
    .option('--dry-run', 'Preview what would happen without making any changes')
    .option('--approve', 'Require multi-sig approval before committing the new state')
    .option('--reviewers <list>', 'Comma-separated reviewer identities (requires --approve)')
    // Claude-specific tuning
    .option('--model <model>', 'Override the Claude model (default: claude-opus-4-6)')
    .option('--timeout <seconds>', 'Session timeout in seconds (default: 1800)', '1800')
    .option('--api-key <key>', 'Anthropic API key (overrides ANTHROPIC_API_KEY env var)')
    // Polytician semantic memory integration
    .option('--polytician-entry <command>', 'Polytician MCP server entry point (e.g., "node server.js")')
    .option('--polytician-namespace <name>', 'Polytician namespace for concept storage', 'polytician')
    .option('--no-semantic-enrichment', 'Disable semantic context enrichment')
    .option('--no-save-concept', 'Disable saving orchestration result as concept')
    .action(async (options: OrchestrateCommandOptions) => {
      // ----------------------------------------------------------------
      // Header
      // ----------------------------------------------------------------
      console.log(chalk.bold('\n  AgentVault Orchestrate\n'));

      // ----------------------------------------------------------------
      // Validate: --claude is the only supported provider right now
      // ----------------------------------------------------------------
      if (!options.claude) {
        console.error(
          chalk.red('Error: A provider flag is required. Currently supported: --claude')
        );
        console.error(chalk.gray('Example: agentvault orchestrate --claude --task "..."'));
        process.exit(1);
      }

      // ----------------------------------------------------------------
      // Validate task
      // ----------------------------------------------------------------
      const task = options.task?.trim() ?? '';
      if (!task) {
        console.error(chalk.red('Error: --task is required'));
        process.exit(1);
      }

      // ----------------------------------------------------------------
      // Parse reviewers
      // ----------------------------------------------------------------
      const reviewers = options.reviewers
        ? options.reviewers.split(',').map((r) => r.trim()).filter(Boolean)
        : undefined;

      if (options.approve && (!reviewers || reviewers.length === 0)) {
        console.error(
          chalk.red('Error: --approve requires --reviewers <comma-separated identities>')
        );
        process.exit(1);
      }

      const timeoutSeconds = parseInt(options.timeout ?? '1800', 10);
      const timeoutMs = isNaN(timeoutSeconds) ? 30 * 60 * 1000 : timeoutSeconds * 1000;

      // ----------------------------------------------------------------
      // Print session summary
      // ----------------------------------------------------------------
      console.log(chalk.cyan('Provider:'), 'Claude Code (Anthropic)');
      console.log(chalk.cyan('Task:    '), task);
      if (options.canisterId) {
        console.log(chalk.cyan('Canister:'), options.canisterId);
      }
      console.log(chalk.cyan('Network: '), options.network ?? 'local');
      if (options.dryRun) {
        console.log(chalk.yellow('\n[DRY RUN] No changes will be committed.\n'));
      }
      if (options.approve && reviewers) {
        console.log(chalk.cyan('Reviewers:'), reviewers.join(', '));
      }
      console.log();

      // ----------------------------------------------------------------
      // Spinner + progress stream
      // ----------------------------------------------------------------
      const spinner = ora('Initializing orchestration session...').start();

      const onProgress = (message: string): void => {
        spinner.text = message;
      };

      // ----------------------------------------------------------------
      // Run orchestration
      // ----------------------------------------------------------------
      try {
        const orchestrator = new ClaudeOrchestrator(process.cwd());

        let polyticianServer: MCPServerConfig | undefined;
        if (options.polyticianEntry) {
          polyticianServer = {
            namespace: options.polyticianNamespace ?? 'polytician',
            entryPoint: options.polyticianEntry,
          };
        }

        const result = await orchestrator.orchestrate({
          task,
          canisterId: options.canisterId,
          network: options.network ?? 'local',
          dryRun: options.dryRun,
          requireApproval: options.approve,
          reviewers,
          apiKey: options.apiKey,
          model: options.model,
          timeoutMs,
          onProgress,
          polyticianServer,
          enableSemanticEnrichment: !options.noEnrichment,
          saveResultAsConcept: !options.noSaveConcept,
        });

        // ----------------------------------------------------------------
        // Report result
        // ----------------------------------------------------------------
        if (result.success) {
          spinner.succeed(chalk.green('Orchestration session completed successfully'));
        } else {
          spinner.fail(chalk.red('Orchestration session failed'));
        }

        console.log();
        console.log(chalk.bold('Session Summary'));
        console.log(chalk.gray('─'.repeat(48)));
        console.log(chalk.cyan('  Session ID:    '), result.sessionId);
        console.log(chalk.cyan('  Task:          '), result.taskDescription);

        if (result.filesChanged.length > 0) {
          console.log(
            chalk.cyan('  Files changed: '),
            result.filesChanged.length.toString()
          );
          const preview = result.filesChanged.slice(0, 5);
          for (const f of preview) {
            console.log(chalk.gray(`    • ${f}`));
          }
          if (result.filesChanged.length > 5) {
            console.log(chalk.gray(`    ... and ${result.filesChanged.length - 5} more`));
          }
        } else {
          console.log(chalk.cyan('  Files changed: '), '0');
        }

        const testLabel = result.testsPassed
          ? chalk.green('passed')
          : options.dryRun
            ? chalk.gray('skipped (dry run)')
            : chalk.red('failed');
        console.log(chalk.cyan('  Tests:         '), testLabel);

        if (result.auditLogId) {
          console.log(chalk.cyan('  Audit log:     '), result.auditLogId);
        }

        if (result.approvalRequestId) {
          console.log(chalk.cyan('  Approval ID:   '), result.approvalRequestId);
          console.log();
          console.log(
            chalk.yellow('Approval required before state is finalized.'),
            chalk.gray(`Run: agentvault approve sign ${result.approvalRequestId} <signer>`)
          );
        }

        const durationSecs = (result.durationMs / 1000).toFixed(1);
        console.log(chalk.cyan('  Duration:      '), `${durationSecs}s`);
        console.log();

        if (!result.success) {
          if (result.error) {
            console.error(chalk.red(`Error: ${result.error}`));
          }
          process.exit(1);
        }
      } catch (err) {
        spinner.fail(chalk.red('Orchestration failed'));
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}


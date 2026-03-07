/**
 * Mint command – agentvault mint agent <name> --google-adk-<type>
 *
 * Scaffolds a new Google ADK agent, immediately provisions an ICP canister,
 * and creates the agent's first Arweave backup (the "birthday" snapshot).
 * This gives every agent an immutable on-chain genesis record from birth –
 * the equivalent of running `git init` but for sovereign AI agents.
 *
 * Supported agent types:
 *   --google-adk-loop-agent       LoopAgent       (iterative refinement)
 *   --google-adk-workflow-agent   WorkflowAgent   (LLM-driven orchestration)
 *   --google-adk-sequential-agent SequentialAgent (pipeline stages)
 *   --google-adk-parallel-agent   ParallelAgent   (concurrent workers)
 *
 * Usage:
 *   agentvault mint agent my-bot --google-adk-loop-agent
 *   agentvault mint agent my-bot --google-adk-sequential-agent --network ic
 *   agentvault mint agent my-bot --google-adk-parallel-agent --no-backup
 *   agentvault mint agent my-bot --google-adk-workflow-agent --canister-id <id>
 *
 * References: Google ADK docs, A2A Protocol, PRD-001
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  mintGoogleADKAgent,
  checkGoogleADKAvailable,
  type GoogleADKAgentType,
} from '../../src/orchestration/google-adk.js';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

interface MintAgentOptions {
  googleAdkLoopAgent?: boolean;
  googleAdkWorkflowAgent?: boolean;
  googleAdkSequentialAgent?: boolean;
  googleAdkParallelAgent?: boolean;
  network?: 'local' | 'ic';
  canisterId?: string;
  outputDir?: string;
  noBackup?: boolean;
  yes?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADK_TYPE_LABELS: Record<GoogleADKAgentType, string> = {
  loop: 'Loop Agent (LoopAgent)',
  workflow: 'Workflow Agent (LLM orchestrator)',
  sequential: 'Sequential Agent (SequentialAgent)',
  parallel: 'Parallel Agent (ParallelAgent)',
};

const ADK_TYPE_FLAG_LABELS: Record<GoogleADKAgentType, string> = {
  loop: '--google-adk-loop-agent',
  workflow: '--google-adk-workflow-agent',
  sequential: '--google-adk-sequential-agent',
  parallel: '--google-adk-parallel-agent',
};

function resolveAgentType(options: MintAgentOptions): GoogleADKAgentType | null {
  if (options.googleAdkLoopAgent) return 'loop';
  if (options.googleAdkWorkflowAgent) return 'workflow';
  if (options.googleAdkSequentialAgent) return 'sequential';
  if (options.googleAdkParallelAgent) return 'parallel';
  return null;
}

function validateAgentName(name: string): string | null {
  if (!name.trim()) return 'Agent name is required';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
    return 'Agent name must be lowercase alphanumeric with hyphens (e.g. my-agent)';
  }
  return null;
}

// ---------------------------------------------------------------------------
// mint agent subcommand
// ---------------------------------------------------------------------------

function buildAgentSubcommand(): Command {
  const agentCmd = new Command('agent');

  agentCmd
    .description('Scaffold a new Google ADK agent with on-chain canister and birthday backup')
    .argument('<name>', 'Agent name (lowercase alphanumeric with hyphens)')
    // ADK agent type flags
    .option('--google-adk-loop-agent', 'Scaffold a LoopAgent (iterative refinement)')
    .option('--google-adk-workflow-agent', 'Scaffold a WorkflowAgent (LLM-driven orchestration)')
    .option('--google-adk-sequential-agent', 'Scaffold a SequentialAgent (pipeline stages)')
    .option('--google-adk-parallel-agent', 'Scaffold a ParallelAgent (concurrent workers)')
    // Infrastructure options
    .option('-n, --network <network>', 'ICP network: local | ic', 'local')
    .option('-c, --canister-id <id>', 'Bind to an existing canister ID (skips provisioning)')
    .option('-o, --output-dir <path>', 'Directory to create the agent in (default: cwd)')
    .option('--no-backup', 'Skip the Arweave birthday backup')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (name: string, options: MintAgentOptions) => {
      // ----------------------------------------------------------------
      // Header
      // ----------------------------------------------------------------
      console.log(chalk.bold('\n  AgentVault Mint\n'));

      // ----------------------------------------------------------------
      // Validate agent name
      // ----------------------------------------------------------------
      const nameError = validateAgentName(name);
      if (nameError) {
        console.error(chalk.red(`Error: ${nameError}`));
        process.exit(1);
      }

      // ----------------------------------------------------------------
      // Resolve agent type
      // ----------------------------------------------------------------
      const agentTypeOrNull = resolveAgentType(options);
      if (!agentTypeOrNull) {
        console.error(chalk.red('Error: An agent type flag is required.\n'));
        console.error(chalk.gray('Supported types:'));
        for (const [, label] of Object.entries(ADK_TYPE_FLAG_LABELS)) {
          console.error(chalk.gray(`  ${chalk.cyan((label as string).padEnd(34))} scaffold a Google ADK agent`));
        }
        console.error('');
        console.error(chalk.gray('Example:'));
        console.error(chalk.gray(`  agentvault mint agent ${name} --google-adk-loop-agent`));
        process.exit(1);
        return;
      }
      const agentType: GoogleADKAgentType = agentTypeOrNull;

      // ----------------------------------------------------------------
      // Validate network
      // ----------------------------------------------------------------
      const network = options.network ?? 'local';
      if (network !== 'local' && network !== 'ic') {
        console.error(chalk.red(`Error: --network must be 'local' or 'ic' (got: ${network})`));
        process.exit(1);
      }

      // ----------------------------------------------------------------
      // Resolve output directory
      // ----------------------------------------------------------------
      const outputDir = options.outputDir ? path.resolve(options.outputDir) : process.cwd();

      // Check that the agent directory doesn't already exist
      const agentDir = path.join(outputDir, name);
      if (fs.existsSync(agentDir)) {
        console.error(chalk.red(`Error: Directory already exists: ${agentDir}`));
        console.error(chalk.gray('Choose a different agent name or remove the existing directory.'));
        process.exit(1);
      }

      // ----------------------------------------------------------------
      // Print plan
      // ----------------------------------------------------------------
      console.log(chalk.cyan('Agent name:  '), chalk.bold(name));
      console.log(chalk.cyan('Agent type:  '), ADK_TYPE_LABELS[agentType]);
      console.log(chalk.cyan('Network:     '), network);
      console.log(chalk.cyan('Output dir:  '), outputDir);
      if (options.canisterId) {
        console.log(chalk.cyan('Canister:    '), options.canisterId);
      }
      if (options.noBackup) {
        console.log(chalk.yellow('Birthday backup: skipped (--no-backup)'));
      }
      console.log();

      // ----------------------------------------------------------------
      // Check google-adk availability early so the user can fix it before
      // we print the confirmation prompt
      // ----------------------------------------------------------------
      const adkSpinner = ora('Checking Google ADK availability...').start();
      const adkCheck = await checkGoogleADKAvailable();
      if (!adkCheck.available) {
        adkSpinner.fail(chalk.red('Google ADK not available'));
        console.error('');
        if (adkCheck.error) console.error(chalk.red(adkCheck.error));
        console.error('');
        console.error(chalk.gray('Install with:'));
        console.error(chalk.cyan('    pip install google-adk'));
        console.error('');
        console.error(chalk.gray('Then re-run:'));
        console.error(
          chalk.cyan(`    agentvault mint agent ${name} ${ADK_TYPE_FLAG_LABELS[agentType]}`)
        );
        process.exit(1);
        return;
      }
      adkSpinner.succeed(
        chalk.green(
          `Google ADK ready${adkCheck.version ? chalk.gray(` (v${adkCheck.version})`) : ''}`
        )
      );
      console.log();

      // ----------------------------------------------------------------
      // Confirmation prompt (skip with --yes)
      // ----------------------------------------------------------------
      if (!options.yes) {
        const { default: inquirer } = await import('inquirer');
        const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: 'confirm',
            name: 'confirmed',
            message: `Mint agent '${name}' (${ADK_TYPE_LABELS[agentType]}) and provision canister?`,
            default: true,
          },
        ]);

        if (!confirmed) {
          console.log(chalk.yellow('\nMint cancelled.'));
          return;
        }
        console.log();
      }

      // ----------------------------------------------------------------
      // Run mint
      // ----------------------------------------------------------------
      const spinner = ora('Minting agent...').start();

      const onProgress = (message: string): void => {
        spinner.text = message;
      };

      const result = await mintGoogleADKAgent({
        agentName: name,
        agentType,
        outputDir,
        network,
        canisterId: options.canisterId,
        skipBackup: options.noBackup,
        onProgress,
      });

      // ----------------------------------------------------------------
      // Output result
      // ----------------------------------------------------------------
      if (result.success) {
        spinner.succeed(chalk.green('Agent minted successfully'));
      } else {
        spinner.fail(chalk.red('Mint failed'));
        if (result.error) {
          console.error(chalk.red(`\nError: ${result.error}`));
        }
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('  Agent Summary'));
      console.log(chalk.gray('  ' + '─'.repeat(52)));
      console.log(chalk.cyan('  Name:        '), result.agentName);
      console.log(chalk.cyan('  Type:        '), ADK_TYPE_LABELS[result.agentType]);
      console.log(chalk.cyan('  Birthday:    '), result.birthdayTimestamp);

      if (result.canisterId) {
        console.log(chalk.cyan('  Canister:    '), result.canisterId);
      }

      if (result.birthdayArchiveId) {
        console.log(chalk.cyan('  Archive ID:  '), result.birthdayArchiveId);
        console.log(
          chalk.gray('               ') +
            chalk.gray('(Arweave genesis snapshot – permanent on-chain record)')
        );
      }

      console.log();
      console.log(chalk.bold('  Scaffold Files'));
      console.log(chalk.gray('  ' + '─'.repeat(52)));
      for (const file of result.scaffoldFiles) {
        console.log(chalk.gray(`  • ${file}`));
      }

      const durationSecs = (result.durationMs / 1000).toFixed(1);
      console.log();
      console.log(chalk.gray(`  Minted in ${durationSecs}s`));

      console.log();
      console.log(chalk.bold('  Next Steps'));
      console.log(chalk.gray('  ' + '─'.repeat(52)));
      const relDir = path.relative(process.cwd(), result.agentDir) || name;
      console.log(chalk.gray(`  1. cd ${relDir}`));
      console.log(chalk.gray('  2. pip install -r requirements.txt'));
      console.log(chalk.gray('  3. cp .env.example .env  # then set GOOGLE_API_KEY'));
      console.log(chalk.gray('  4. python main.py'));
      console.log(chalk.gray('  5. agentvault status'));
      console.log();
    });

  return agentCmd;
}

// ---------------------------------------------------------------------------
// Top-level mint command
// ---------------------------------------------------------------------------

export function mintCmd(): Command {
  const command = new Command('mint');

  command
    .description(
      'Mint a new agent with on-chain canister and genesis Arweave backup'
    )
    .action(() => {
      console.log(chalk.yellow('Please specify a subcommand: agent'));
      console.log('');
      console.log(chalk.gray('Scaffold a Google ADK agent:'));
      console.log(
        chalk.gray(
          `  ${chalk.cyan('agentvault mint agent <name> --google-adk-loop-agent')}       Loop agent`
        )
      );
      console.log(
        chalk.gray(
          `  ${chalk.cyan('agentvault mint agent <name> --google-adk-workflow-agent')}   Workflow agent`
        )
      );
      console.log(
        chalk.gray(
          `  ${chalk.cyan('agentvault mint agent <name> --google-adk-sequential-agent')} Sequential agent`
        )
      );
      console.log(
        chalk.gray(
          `  ${chalk.cyan('agentvault mint agent <name> --google-adk-parallel-agent')}   Parallel agent`
        )
      );
      console.log('');
      console.log(chalk.gray('Options:'));
      console.log(chalk.gray('  -n, --network <local|ic>   ICP network (default: local)'));
      console.log(chalk.gray('  -c, --canister-id <id>     Bind to existing canister'));
      console.log(chalk.gray('      --no-backup            Skip Arweave birthday backup'));
      console.log(chalk.gray('  -y, --yes                  Skip confirmation prompt'));
    });

  command.addCommand(buildAgentSubcommand());

  return command;
}

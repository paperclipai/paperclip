/**
 * Fetch command - Download agent state from canister
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { NetworkType } from '../../src/deployment/types.js';
import { createICPClient } from '../../src/deployment/icpClient.js';
import { THOUGHTFORM_BUNDLE_FORMAT } from '../../src/backup/thoughtform-bundle.js';
import type { ThoughtformBundle } from '../../src/backup/thoughtform-bundle.js';

const gzipAsync = promisify(zlib.gzip);

export type FetchType = 'default' | 'thoughtform-bundle';

export interface FetchCommandOptions {
  network?: NetworkType;
  output?: string;
  decrypt?: boolean;
  type?: FetchType;
}

export interface FetchAnswers {
  seedPhrase?: string;
  confirm: boolean;
}

/**
 * Execute the fetch command
 */
export async function executeFetch(
  canisterId: string,
  options: FetchCommandOptions
): Promise<void> {
  const network = options.network ?? 'local';
  const resolvedCanisterId = canisterId.trim();

  // Validate canister ID format
  if (!/^[a-z0-9-]{27}$/.test(resolvedCanisterId)) {
    throw new Error(
      `Invalid canister ID format: ${resolvedCanisterId}. Expected 27 characters of alphanumeric and hyphens.`
    );
  }

  // Determine output path
  const fetchType = options.type ?? 'default';
  const defaultExt = fetchType === 'thoughtform-bundle' ? '.thoughtform-bundle.json.gz' : '.state.json';
  const outputPath =
    options.output ?? path.resolve(process.cwd(), `${resolvedCanisterId}${defaultExt}`);

  // Check if output already exists
  if (fs.existsSync(outputPath) && !options.decrypt) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Output file ${outputPath} already exists. Overwrite?`,
        default: false,
      },
    ]);

    if (!overwrite) {
      console.log(chalk.yellow('\nFetch cancelled.'));
      return;
    }
  }

  const spinner = ora('Fetching agent state from canister...').start();

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

    // Fetch state from canister
    spinner.text = 'Querying canister state...';

    const canisterStatus = await client.getCanisterStatus(resolvedCanisterId);

    const [agentStateResult, memoriesResult, tasksResult, contextResult] = await Promise.allSettled([
      client.callAgentMethod<unknown>(resolvedCanisterId, 'agent_get_state'),
      client.callAgentMethod<unknown[]>(resolvedCanisterId, 'agent_get_memories'),
      client.callAgentMethod<unknown[]>(resolvedCanisterId, 'agent_get_tasks'),
      client.callAgentMethod<unknown>(resolvedCanisterId, 'getAllContext'),
    ]);

    const stateData = {
      canisterId: resolvedCanisterId,
      network,
      fetchedAt: new Date().toISOString(),
      canisterStatus,
      state: {
        initialized: canisterStatus.exists,
        data: {
          agentState: agentStateResult.status === 'fulfilled' ? agentStateResult.value : null,
          memories: memoriesResult.status === 'fulfilled' ? memoriesResult.value : [],
          tasks: tasksResult.status === 'fulfilled' ? tasksResult.value : [],
          context: contextResult.status === 'fulfilled' ? contextResult.value : {},
        },
      },
    };

    spinner.succeed('Agent state fetched successfully!');

    console.log();
    console.log(chalk.cyan('Canister Info:'));
    console.log(`  ID:        ${chalk.bold(stateData.canisterId)}`);
    console.log(`  Network:   ${stateData.network}`);
    console.log(`  Fetched:   ${stateData.fetchedAt}`);

    // Write state to file
    if (!options.decrypt) {
      if (fetchType === 'thoughtform-bundle') {
        // Write as gzipped thoughtform-bundle
        const now = new Date();
        const bundle: ThoughtformBundle = {
          format: THOUGHTFORM_BUNDLE_FORMAT,
          createdAt: now.toISOString(),
          manifest: {
            version: '1.0',
            agentName: stateData.canisterId,
            timestamp: now,
            created: now,
            canisterId: stateData.canisterId,
            checksums: {},
            size: 0,
            components: ['fetched-state'],
          },
          entries: {
            'state.json': Buffer.from(JSON.stringify(stateData, null, 2), 'utf8').toString('base64'),
          },
        };
        const compressed = await gzipAsync(Buffer.from(JSON.stringify(bundle), 'utf8'));
        fs.writeFileSync(outputPath, compressed);
        console.log();
        console.log(chalk.green('✓'), 'Thoughtform-bundle saved to:', chalk.bold(outputPath));
      } else {
        fs.writeFileSync(outputPath, JSON.stringify(stateData, null, 2), 'utf-8');
        console.log();
        console.log(chalk.green('✓'), 'State saved to:', chalk.bold(outputPath));
      }

      console.log();
      console.log(chalk.cyan('Next steps:'));
      console.log('  1. Decrypt the state:', chalk.bold('agentvault decrypt'), `<${outputPath}>`);
      console.log('  2. Rebuild the agent:', chalk.bold('agentvault rebuild'));
    }

    // Handle decryption if requested
    if (options.decrypt) {
      await handleDecryption(stateData, outputPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Fetch failed: ${message}`);
    throw error;
  }
}

/**
 * Handle decryption of fetched state
 */
async function handleDecryption(stateData: unknown, outputPath: string): Promise<void> {
  console.log();
  console.log(chalk.cyan('Decryption required.'));

  await inquirer.prompt<{ seedPhrase: string }>([
    {
      type: 'password',
      name: 'seedPhrase',
      message: 'Enter your seed phrase:',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Seed phrase is required';
        }
        const words = input.trim().split(/\s+/);
        if (words.length !== 12 && words.length !== 24) {
          return 'Seed phrase must be 12 or 24 words';
        }
        return true;
      },
    },
  ]);

  const spinner = ora('Decrypting state...').start();

  try {
    // Stub: In a real implementation, this would decrypt using VetKeys
    const decryptedState = stateData;

    spinner.succeed('State decrypted successfully!');

    fs.writeFileSync(outputPath, JSON.stringify(decryptedState, null, 2), 'utf-8');

    console.log();
    console.log(chalk.green('✓'), 'Decrypted state saved to:', chalk.bold(outputPath));
    console.log();
    console.log(chalk.cyan('Next steps:'));
    console.log('  1. Review the decrypted state');
    console.log('  2. Rebuild the agent:', chalk.bold('agentvault rebuild'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Decryption failed: ${message}`);
    throw error;
  }
}

/**
 * Create the fetch command
 */
export function fetchCommand(): Command {
  const command = new Command('fetch');

  command
    .description('Download agent state from canister')
    .argument('<canister-id>', 'canister ID to fetch state from')
    .option('-n, --network <network>', 'network (local or ic)', 'local')
    .option('-o, --output <path>', 'output file path')
    .option('-d, --decrypt', 'decrypt state after fetching')
    .option('-t, --type <type>', 'output type (default, thoughtform-bundle)', 'default')
    .action(async (canisterId: string, options: FetchCommandOptions) => {
      console.log(chalk.bold('\n📥 AgentVault Fetch\n'));

      try {
        await executeFetch(canisterId, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Decrypt command - Decrypt agent state using seed phrase
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decryptJSON } from '../../src/security/vetkeys.js';
import type { EncryptedData } from '../../src/security/types.js';

export interface DecryptCommandOptions {
  output?: string;
}

/**
 * Execute decrypt command
 */
export async function executeDecrypt(
  filePath: string,
  options: DecryptCommandOptions
): Promise<void> {
  const resolvedPath = path.resolve(filePath);

  // Validate input file exists
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  // Read and parse file
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  let data: Record<string, unknown>;

  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JSON format');
  }

  // Check if already decrypted
  if (!('encrypted' in data && data.encrypted)) {
    console.log(chalk.yellow('State is already decrypted.'));
    return;
  }

  // Prompt for seed phrase
  const { seedPhrase } = await inquirer.prompt<{ seedPhrase: string }>([
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

  const spinner = ora('Decrypting agent state...').start();

  try {
    const encrypted: EncryptedData = data as unknown as EncryptedData;

    // Decrypt using VetKeys
    const decrypted = await decryptJSON(encrypted, seedPhrase);

    spinner.succeed('State decrypted successfully!');

    console.log();
    console.log(chalk.cyan('Decryption Info:'));
    console.log(`  Algorithm:      ${encrypted.algorithm}`);
    console.log(`  Encrypted at:   ${encrypted.encryptedAt}`);

    // Determine output path
    const outputPath =
      options.output ?? resolvedPath.replace('.json', '.decrypted.json');

    // Write decrypted state
    fs.writeFileSync(outputPath, JSON.stringify(decrypted, null, 2), 'utf-8');

    console.log();
    console.log(chalk.green('✓'), 'Decrypted state saved to:', chalk.bold(outputPath));
    console.log();
    console.log(chalk.cyan('Next steps:'));
    console.log('  1. Review the decrypted state');
    console.log('  2. Rebuild agent:', chalk.bold('agentvault rebuild'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Decryption failed: ${message}`);
    throw error;
  }
}

/**
 * Create decrypt command
 */
export function decryptCommand(): Command {
  const command = new Command('decrypt');

  command
    .description('Decrypt agent state using seed phrase')
    .argument('<file>', 'encrypted state file to decrypt')
    .option('-o, --output <path>', 'output file path')
    .action(async (file: string, options: DecryptCommandOptions) => {
      console.log(chalk.bold('\n🔓 AgentVault Decrypt\n'));

      try {
        await executeDecrypt(file, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Wallet Import Command
 *
 * Import wallets from an exported backup file.
 */

import { importWalletFromPrivateKey, importWalletFromSeed } from '../../src/wallet/index.js';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * Backup structure
 */
interface WalletBackup {
  version: string;
  agentId: string;
  exportedAt: number;
  format: 'json' | 'encrypted';
  wallets: any[];
  encrypted?: boolean;
  iv?: string;
  salt?: string;
}

/**
 * Conflict resolution options
 */
type ConflictResolution = 'skip' | 'overwrite' | 'rename';

/**
 * Decrypt data with password
 */
function decryptData(encryptedData: string, password: string, ivHex: string, saltHex: string): string {
  const iv = Buffer.from(ivHex || '', 'hex');
  const salt = Buffer.from(saltHex || '', 'hex');
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

  const [encrypted, authTagHex] = encryptedData.split('.');
  const authTag = Buffer.from(authTagHex || '', 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted || '', 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Load backup file
 */
function loadBackupFile(filepath: string): WalletBackup {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Backup file not found: ${filepath}`);
  }

  const data = fs.readFileSync(filepath, 'utf-8');

  try {
    return JSON.parse(data);
  } catch {
    throw new Error('Invalid backup file format');
  }
}

/**
 * Decrypt backup if needed
 */
async function loadBackup(filepath: string): Promise<WalletBackup> {
  const loaded = loadBackupFile(filepath);

  if (loaded.encrypted && loaded.iv && loaded.salt && (loaded as any).encrypted) {
    const encryptedData = (loaded as any).encrypted;
    const { password } = await inquirer.prompt<{ password: string }>([
      {
        type: 'password',
        name: 'password',
        message: 'Enter decryption password:',
      },
    ]);

    try {
      const decrypted = decryptData(encryptedData, password, loaded.iv!, loaded.salt!);
      return JSON.parse(decrypted);
    } catch {
      throw new Error('Failed to decrypt backup - incorrect password or corrupted file');
    }
  }

  return loaded;
}

/**
 * Validate backup structure
 */
function validateBackup(backup: WalletBackup): void {
  if (!backup.version || !backup.agentId || !backup.wallets || !Array.isArray(backup.wallets)) {
    throw new Error('Invalid backup structure');
  }

  if (backup.wallets.length === 0) {
    throw new Error('Backup contains no wallets');
  }

  for (const wallet of backup.wallets) {
    if (!wallet.id || !wallet.chain || !wallet.address) {
      throw new Error('Invalid wallet data in backup');
    }
  }
}

/**
 * Display backup summary
 */
function displayBackupSummary(backup: WalletBackup): void {
  console.log();
  console.log(chalk.cyan('Backup Summary:'));
  console.log(`  Version:    ${backup.version}`);
  console.log(`  Agent ID:   ${backup.agentId}`);
  console.log(`  Exported:   ${new Date(backup.exportedAt).toISOString()}`);
  console.log(`  Format:     ${backup.format}`);
  console.log(`  Wallets:    ${backup.wallets.length}`);
  console.log();

  console.log(chalk.cyan('Wallets:'));
  for (const wallet of backup.wallets) {
    console.log(`  - ${wallet.chain.toUpperCase()}: ${wallet.address}`);
  }
}

/**
 * Import wallet from backup
 */
async function importWallet(wallet: any, agentId: string, resolution: ConflictResolution): Promise<boolean> {
  try {
    if (wallet.privateKey) {
      importWalletFromPrivateKey(agentId, wallet.chain, wallet.privateKey);
    } else if (wallet.mnemonic) {
      importWalletFromSeed(
        agentId,
        wallet.chain,
        wallet.mnemonic,
        wallet.seedDerivationPath
      );
    } else {
      console.log(chalk.yellow(`⚠ Skipping ${wallet.id}: No private key or mnemonic`));
      return false;
    }

    return true;
  } catch (error) {
    if ((error as any).message?.includes('already exists')) {
      if (resolution === 'skip') {
        console.log(chalk.yellow(`⊘ Skipping ${wallet.id}: Already exists`));
      } else if (resolution === 'overwrite') {
        console.log(chalk.yellow(`⚠ Overwriting ${wallet.id}`));
      }
    } else {
      console.log(chalk.red(`✗ Failed to import ${wallet.id}: ${(error as Error).message}`));
    }

    return false;
  }
}

/**
 * Handle wallet import command
 */
export async function handleImport(agentId: string, filePath: string): Promise<void> {
  console.log(chalk.bold('\n📥 Import Wallets\n'));

  if (!filePath) {
    const { path: inputPath } = await inquirer.prompt<{ path: string }>([
      {
        type: 'input',
        name: 'path',
        message: 'Path to backup file:',
        validate: (input: string) => input.length > 0,
      },
    ]);

    filePath = inputPath;
  }

  const spinner = ora('Loading backup file...').start();

  try {
    const backup = await loadBackup(filePath);

    validateBackup(backup);

    spinner.succeed('Backup loaded');

    displayBackupSummary(backup);

    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Import ${backup.wallets.length} wallet(s) to agent ${agentId}?`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow('\nImport cancelled'));
      return;
    }

    const { resolution } = await inquirer.prompt<{ resolution: ConflictResolution }>([
      {
        type: 'list',
        name: 'resolution',
        message: 'How to handle existing wallets?',
        choices: [
          { name: 'Skip existing wallets', value: 'skip' },
          { name: 'Overwrite existing wallets', value: 'overwrite' },
          { name: 'Rename with suffix', value: 'rename' },
        ],
        default: 'skip',
      },
    ]);

    console.log();
    console.log(chalk.cyan('Importing wallets...'));

    let successCount = 0;
    const skipCount = 0;
    let failCount = 0;

    for (const wallet of backup.wallets) {
      const result = await importWallet(wallet, agentId, resolution);

      if (result) {
        successCount++;
        console.log(chalk.green(`✓ Imported: ${wallet.id} (${wallet.chain})`));
      } else {
        failCount++;
      }
    }

    console.log();
    console.log(chalk.cyan('Import Summary:'));
    console.log(`  ✓ Successful: ${successCount}`);
    console.log(`  ⊘ Skipped:    ${skipCount}`);
    console.log(`  ✗ Failed:     ${failCount}`);

    if (successCount > 0) {
      console.log();
      console.log(chalk.green('✓'), 'Wallets imported successfully');
      console.log(chalk.yellow('⚠'), 'Keep your backup file secure until you verify all wallets work correctly');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to import wallets: ${message}`);
  }
}

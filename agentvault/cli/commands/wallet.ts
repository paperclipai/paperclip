/**
 * Wallet Command
 *
 * Main wallet management command for AgentVault.
 * Provides CLI interface for wallet operations.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import {
  createWalletProvider,
  generateWallet,
  importWalletFromPrivateKey,
  importWalletFromMnemonic,
  importWalletFromSeed,
  createWalletWithHsm,
  getWallet,
  listAgentWallets,
  normalizeWalletChain,
  removeWallet,
  isHsmAvailable,
} from '../../src/wallet/index.js';

/**
 * Create wallet command
 */
/**
 * Print security warning for sensitive CLI options
 * SECURITY: Secrets passed via CLI are visible in process list and shell history
 */
function warnIfSensitiveOptions(options: WalletCommandOptions): void {
  const sensitiveOptions: Array<keyof WalletCommandOptions> = ['mnemonic', 'privateKey', 'password'];
  const usedSensitive = sensitiveOptions.filter(opt => options[opt]);

  if (usedSensitive.length > 0) {
    console.warn(chalk.yellow('\n⚠️  SECURITY WARNING:'));
    console.warn(chalk.yellow('    Passing secrets via CLI arguments is insecure.'));
    console.warn(chalk.yellow('    Arguments are visible in `ps aux` and shell history.'));
    console.warn(chalk.yellow('    Consider using environment variables instead:'));
    if (options.mnemonic) {
      console.warn(chalk.yellow('      AGENTVAULT_MNEMONIC=... agentvault wallet import --chain eth'));
    }
    if (options.privateKey) {
      console.warn(chalk.yellow('      AGENTVAULT_PRIVATE_KEY=... agentvault wallet import --chain eth'));
    }
    if (options.password) {
      console.warn(chalk.yellow('      AGENTVAULT_PASSWORD=... agentvault wallet import --keystore ...'));
    }
    console.warn('');
  }
}

export function walletCommand(): Command {
  const command = new Command('wallet');

  command
    .description('Manage agent wallets (ckETH, Polkadot, Solana, ICP, Arweave)')
    .argument('<subcommand>', 'wallet subcommand to execute')
    .option('-a, --agent-id <id>', 'agent ID')
    .option('-f, --file <path>', 'file path (for import)')
    .option('--chain <chain>', 'chain (eth, cketh, polkadot, solana, icp, arweave)')
    .option('--name <name>', 'wallet label (used by GUI clients)')
    .option('--json', 'output as JSON')
    // SECURITY NOTE: These options expose secrets in process list and shell history
    // Prefer using environment variables: AGENTVAULT_MNEMONIC, AGENTVAULT_PRIVATE_KEY
    .option('--mnemonic <phrase>', '[INSECURE] mnemonic phrase (prefer AGENTVAULT_MNEMONIC env var)')
    .option('--private-key <key>', '[INSECURE] private key (prefer AGENTVAULT_PRIVATE_KEY env var)')
    .option('--address <address>', 'wallet address for non-interactive balance query')
    .option('--keystore <path>', 'Ethereum keystore JSON file')
    .option('--password <password>', '[INSECURE] password (prefer AGENTVAULT_PASSWORD env var)')
    .option('--pem-file <path>', 'PEM file path (not yet supported in wallet import)')
    .option('--jwk-file <path>', 'JWK file path (not yet supported in wallet import)')
    .option(
      '--hsm <backend>',
      'hardware secure module backend: "ledger" (Ledger device) or "sgx" (Intel SGX TEE). ' +
        'Private key never enters host memory.',
    )
    .option('--hsm-path <derivation>', 'BIP32/SLIP10 derivation path override for HSM keygen')
    .action(async (subcommand, options) => {
      // Show security warning if sensitive options are used
      warnIfSensitiveOptions(options);
      await executeWalletCommand(subcommand, options);
    });

  return command;
}

type WalletCommandOptions = {
  agentId?: string;
  file?: string;
  chain?: string;
  name?: string;
  json?: boolean;
  mnemonic?: string;
  privateKey?: string;
  address?: string;
  keystore?: string;
  password?: string;
  pemFile?: string;
  jwkFile?: string;
  hsm?: string;
  hsmPath?: string;
};

function isNonInteractiveImport(options: WalletCommandOptions): boolean {
  return Boolean(
    options.chain ||
    options.mnemonic ||
    options.privateKey ||
    options.keystore ||
    options.pemFile ||
    options.jwkFile
  );
}

export function normalizeChain(rawChain?: string): string {
  if (!rawChain) {
    throw new Error('--chain is required');
  }
  return normalizeWalletChain(rawChain);
}

function getAgentId(options: WalletCommandOptions): string {
  return options.agentId || 'wallet-app';
}

function printWalletResult(wallet: {
  id: string;
  chain: string;
  address: string;
  mnemonic?: string;
  privateKey?: string;
}, json: boolean = false): void {
  if (json) {
    console.log(JSON.stringify({
      id: wallet.id,
      chain: wallet.chain,
      address: wallet.address,
      mnemonic: wallet.mnemonic ?? null,
      privateKey: wallet.privateKey ?? null,
      publicKey: null,
    }));
    return;
  }

  console.log(chalk.green('✓ Wallet ready'));
  console.log(`ID: ${wallet.id}`);
  console.log(`Chain: ${wallet.chain}`);
  console.log(`Address: ${wallet.address}`);
}

/**
 * Execute wallet subcommand
 */
async function executeWalletCommand(
  subcommand: string,
  options: WalletCommandOptions
): Promise<void> {
  const nonInteractiveImport = subcommand === 'import' && isNonInteractiveImport(options);
  const nonInteractiveBalance = subcommand === 'balance' && Boolean(options.address);
  const nonInteractiveGenerate = subcommand === 'generate';

  if (!options.agentId && subcommand !== 'vetkeys' && !nonInteractiveImport && !nonInteractiveBalance && !nonInteractiveGenerate) {
    console.error(chalk.red('Error: --agent-id is required'));
    process.exit(1);
  }

  switch (subcommand) {
    case 'create':
      await handleCreate(options);
      break;
    case 'generate':
      await handleGenerateNonInteractive(options);
      break;
    case 'connect':
      await handleConnect(options.agentId!);
      break;
    case 'disconnect':
      await handleDisconnect(options.agentId!);
      break;
    case 'balance':
      if (nonInteractiveBalance) {
        await handleBalanceNonInteractive(options);
      } else {
        await handleBalance(options.agentId!);
      }
      break;
    case 'send':
      await handleSend(options.agentId!);
      break;
    case 'list':
      await handleList(options.agentId!);
      break;
    case 'sign':
      await handleSign(options.agentId!);
      break;
    case 'history':
      await handleHistory(options.agentId!);
      break;
    case 'export':
      await handleExport(options.agentId!);
      break;
    case 'import':
      if (nonInteractiveImport) {
        await handleImportNonInteractive(options);
      } else {
        await handleImport(options.agentId!, options.file);
      }
      break;
    case 'sync':
      await handleSync(options.agentId!);
      break;
    case 'status':
      await handleStatus(options.agentId!);
      break;
    case 'vetkeys':
      await handleVetKeys();
      break;
    case 'queue':
      await handleQueue(options.agentId!);
      break;
    default:
      console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
      console.log();
      console.log(chalk.cyan('Available subcommands:'));
      console.log('  create     - Create a wallet (supports --hsm ledger|sgx for air-gapped keygen)');
      console.log('  connect    - Connect or create a wallet (interactive)');
      console.log('  disconnect - Disconnect wallet');
      console.log('  balance   - Check wallet balance');
      console.log('  send      - Send transaction');
      console.log('  list      - List all wallets');
      console.log('  sign      - Sign transaction');
      console.log('  history   - Get transaction history');
      console.log('  export    - Export wallets to backup file');
      console.log('  import    - Import wallets from backup file');
      console.log('  sync      - Sync wallets to canister (Phase 5)');
      console.log('  status    - Get wallet sync status (Phase 5)');
      console.log('  vetkeys    - VetKeys operations (Phase 5)');
      console.log('  queue     - Transaction queue operations (Phase 5)');
      process.exit(1);
  }
}

/**
 * Create wallet – supports both software keygen and HSM/TEE keygen.
 *
 * Examples:
 *   # Software keygen (default)
 *   agentvault wallet create --chain cketh --agent-id my-agent
 *
 *   # Ledger hardware wallet (private key never leaves the device)
 *   agentvault wallet create --chain cketh --agent-id my-agent --hsm ledger
 *
 *   # Intel SGX TEE (private key sealed inside enclave)
 *   agentvault wallet create --chain cketh --agent-id my-agent --hsm sgx
 *
 *   # Custom derivation path on Ledger
 *   agentvault wallet create --chain solana --agent-id my-agent \
 *     --hsm ledger --hsm-path "m/44'/501'/0'/0'/0'"
 */
export async function handleCreate(options: WalletCommandOptions): Promise<void> {
  const chain = normalizeChain(options.chain);
  const agentId = getAgentId(options);

  // ── HSM / TEE path ────────────────────────────────────────────────────────
  if (options.hsm) {
    const backend = options.hsm.toLowerCase();
    if (backend !== 'ledger' && backend !== 'sgx') {
      console.error(chalk.red(`Error: --hsm must be "ledger" or "sgx", got "${options.hsm}"`));
      process.exit(1);
    }

    const spinner = ora(
      backend === 'ledger'
        ? 'Connecting to Ledger device… (unlock device and open the correct app)'
        : 'Connecting to Intel SGX enclave…',
    ).start();

    // Probe availability before committing
    const available = await isHsmAvailable(backend as 'ledger' | 'sgx');
    if (!available) {
      spinner.fail(
        backend === 'ledger'
          ? 'No Ledger device detected. Connect your Ledger, unlock it, and open the relevant app.'
          : 'Intel SGX AESM daemon not found at /var/run/aesmd/aesm.socket. ' +
              'Ensure the SGX driver and platform software are installed.',
      );
      process.exit(1);
    }

    spinner.text =
      backend === 'ledger'
        ? 'Deriving public key on Ledger (key never leaves device)…'
        : 'Requesting public key from SGX enclave (key sealed inside TEE)…';

    let wallet;
    try {
      wallet = await createWalletWithHsm({
        agentId,
        chain: chain as any,
        hsmBackend: backend as 'ledger' | 'sgx',
        derivationPath: options.hsmPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinner.fail(`HSM keygen failed: ${message}`);
      process.exit(1);
    }

    spinner.succeed(
      backend === 'ledger'
        ? 'Public key received from Ledger — private key is air-gapped on device'
        : 'Public key received from SGX enclave — private key is sealed in TEE',
    );

    const hsmMeta = wallet.chainMetadata?.hsm;
    if (options.json) {
      console.log(
        JSON.stringify({
          id: wallet.id,
          chain: wallet.chain,
          address: wallet.address,
          publicKey: hsmMeta?.publicKeyHex ?? null,
          privateKey: null,
          mnemonic: null,
          hsmBackend: backend,
          hsmDeviceId: hsmMeta?.deviceId ?? null,
          derivationPath: wallet.seedDerivationPath,
        }),
      );
      return;
    }

    console.log();
    console.log(chalk.green('✓ HSM wallet created'));
    console.log(`  ID:              ${wallet.id}`);
    console.log(`  Chain:           ${wallet.chain}`);
    console.log(`  Address:         ${wallet.address}`);
    console.log(`  Public key:      ${hsmMeta?.publicKeyHex ?? '(unavailable)'}`);
    console.log(`  Backend:         ${backend}`);
    console.log(`  Device ID:       ${hsmMeta?.deviceId ?? '(unavailable)'}`);
    console.log(`  Derivation path: ${wallet.seedDerivationPath}`);
    console.log();
    console.log(chalk.dim('  Private key and mnemonic were never present in this process.'));
    return;
  }

  // ── Software keygen (fallback) ─────────────────────────────────────────────
  const wallet = generateWallet(agentId, chain);
  printWalletResult(wallet, options.json);
}

/**
 * Non-interactive wallet generation for GUI clients
 */
export async function handleGenerateNonInteractive(options: WalletCommandOptions): Promise<void> {
  const chain = normalizeChain(options.chain);
  const wallet = generateWallet(getAgentId(options), chain);
  printWalletResult(wallet, options.json);
}

/**
 * Non-interactive wallet import for GUI clients
 *
 * SECURITY: Supports reading secrets from environment variables (preferred)
 * or CLI arguments (with warning). Environment variables are:
 * - AGENTVAULT_MNEMONIC: BIP39 mnemonic phrase
 * - AGENTVAULT_PRIVATE_KEY: Hex private key
 * - AGENTVAULT_PASSWORD: Keystore password
 */
export async function handleImportNonInteractive(options: WalletCommandOptions): Promise<void> {
  const chain = normalizeChain(options.chain);
  const agentId = getAgentId(options);

  // SECURITY: Prefer environment variables over CLI arguments
  const mnemonic = options.mnemonic || process.env.AGENTVAULT_MNEMONIC;
  const privateKey = options.privateKey || process.env.AGENTVAULT_PRIVATE_KEY;
  const password = options.password || process.env.AGENTVAULT_PASSWORD;

  if (mnemonic) {
    const wallet = importWalletFromMnemonic(agentId, chain, mnemonic);
    printWalletResult(wallet, options.json);
    return;
  }

  if (privateKey) {
    const wallet = importWalletFromPrivateKey(agentId, chain, privateKey);
    printWalletResult(wallet, options.json);
    return;
  }

  if (options.keystore) {
    if (!password) {
      throw new Error('--password or AGENTVAULT_PASSWORD is required when using --keystore');
    }
    const fs = await import('node:fs/promises');
    const { Wallet } = await import('ethers');
    const encryptedJson = await fs.readFile(options.keystore, 'utf8');
    const decrypted = await Wallet.fromEncryptedJson(encryptedJson, password);
    const wallet = importWalletFromPrivateKey(agentId, chain, decrypted.privateKey);
    printWalletResult(wallet, options.json);
    return;
  }

  if (options.pemFile) {
    throw new Error('PEM import is not supported by the wallet CLI command');
  }

  if (options.jwkFile) {
    throw new Error('JWK import is not supported by the wallet CLI command');
  }

  throw new Error('Provide one of --mnemonic, --private-key, --keystore, or set AGENTVAULT_MNEMONIC/AGENTVAULT_PRIVATE_KEY env var');
}

/**
 * Non-interactive balance lookup by chain + address for GUI clients
 */
export async function handleBalanceNonInteractive(options: WalletCommandOptions): Promise<void> {
  const chain = normalizeChain(options.chain);
  const address = options.address;

  if (!address) {
    throw new Error('--address is required for non-interactive wallet balance');
  }

  const provider = createWalletProvider(chain, { isTestnet: false });

  await provider.connect();
  const balance = await provider.getBalance(address);

  if (options.json) {
    console.log(JSON.stringify({
      chain,
      address,
      balance: balance.amount,
      denomination: balance.denomination,
      blockNumber: balance.blockNumber ?? null,
    }));
    return;
  }

  console.log(`${balance.amount} ${balance.denomination}`);
}

/**
 * Handle wallet connect/create
 */
async function handleConnect(agentId: string): Promise<void> {
  console.log(chalk.bold('\n🔑 Wallet Connect\n'));

  const { method } = await inquirer.prompt<{ method: string }>([
    {
      type: 'list',
      name: 'method',
      message: 'How would you like to create the wallet?',
      choices: [
        { name: 'generate', value: 'Generate new wallet (recommended)' },
        { name: 'seed', value: 'Import from seed phrase' },
        { name: 'private-key', value: 'Import from private key' },
      ],
    },
  ]);

  const { chain } = await inquirer.prompt<{ chain: string }>([
    {
      type: 'list',
      name: 'chain',
      message: 'Which blockchain?',
      choices: [
        { name: 'cketh', value: 'ckETH (Ethereum on ICP)' },
        { name: 'polkadot', value: 'Polkadot' },
        { name: 'solana', value: 'Solana' },
        { name: 'icp', value: 'ICP' },
        { name: 'arweave', value: 'Arweave' },
      ],
    },
  ]);

  let wallet;

  if (method === 'generate') {
    wallet = generateWallet(agentId, chain);
    console.log(chalk.green('✓'), 'New wallet generated');
  } else if (method === 'seed') {
    const { seedPhrase, derivationPath } = await inquirer.prompt<{
      seedPhrase: string;
      derivationPath: string;
    }>([
      {
        type: 'password',
        name: 'seedPhrase',
        message: 'Enter seed phrase (BIP39):',
        validate: (input) => input.split(' ').length >= 12,
      },
      {
        type: 'input',
        name: 'derivationPath',
        message: 'Derivation path (optional):',
        default: '',
      },
    ]);

    wallet = importWalletFromSeed(
      agentId,
      chain,
      seedPhrase,
      derivationPath || undefined
    );
    console.log(chalk.green('✓'), 'Wallet imported from seed phrase');
  } else if (method === 'private-key') {
    const { privateKey } = await inquirer.prompt<{ privateKey: string }>([
      {
        type: 'password',
        name: 'privateKey',
        message: 'Enter private key (hex):',
        validate: (input) => /^0x[0-9a-fA-F]{64}$/.test(input),
      },
    ]);

    wallet = importWalletFromPrivateKey(agentId, chain, privateKey);
    console.log(chalk.green('✓'), 'Wallet imported from private key');
  }

  // Display wallet info
  console.log();
  console.log(chalk.cyan('Wallet Info:'));

  if (!wallet) {
    console.log(chalk.yellow('Wallet not found'));
    return;
  }

  console.log(`  ID:       ${wallet.id}`);
  console.log(`  Chain:    ${wallet.chain}`);
  console.log(`  Address:  ${wallet.address}`);
  console.log(`  Created: ${new Date(wallet.createdAt).toISOString()}`);

  // Test connection to provider
  const spinner = ora('Testing provider connection...').start();

  try {
    const provider = createWalletProvider(chain, { isTestnet: false });

    await provider.connect();
    const balance = await provider.getBalance(wallet.address);

    spinner.succeed('Provider connected');

    console.log();
    console.log(chalk.cyan('Balance:'));
    console.log(`  ${balance.amount} ${balance.denomination}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Provider connection failed: ${message}`);
  }
}

/**
 * Handle wallet disconnect
 */
async function handleDisconnect(agentId: string): Promise<void> {
  const wallets = listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const { walletId } = await inquirer.prompt<{ walletId: string }>([
    {
      type: 'list',
      name: 'walletId',
      message: 'Select wallet to disconnect:',
      choices: wallets,
    },
  ]);

  removeWallet(agentId, walletId);
  console.log(chalk.green('✓'), 'Wallet disconnected');
}

/**
 * Handle wallet balance query
 */
async function handleBalance(agentId: string): Promise<void> {
  const wallets = listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const { walletId } = await inquirer.prompt<{ walletId: string }>([
    {
      type: 'list',
      name: 'walletId',
      message: 'Select wallet:',
      choices: wallets,
    },
  ]);

  const wallet = getWallet(agentId, walletId);

  if (!wallet) {
    console.log(chalk.red('Wallet not found'));
    return;
  }

  const spinner = ora('Fetching balance...').start();

  try {
    const provider = createWalletProvider(wallet.chain, { isTestnet: false });

    await provider.connect();
    const balance = await provider.getBalance(wallet.address);

    spinner.succeed('Balance fetched');

    console.log();
    console.log(chalk.cyan('Balance:'));
    console.log(`  Address:  ${wallet.address}`);
    console.log(`  Amount:  ${balance.amount} ${balance.denomination}`);
    console.log(`  Block:   ${balance.blockNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch balance: ${message}`);
  }
}

/**
 * Handle wallet send transaction
 */
async function handleSend(agentId: string): Promise<void> {
  const wallets = listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const { walletId } = await inquirer.prompt<{ walletId: string }>([
    {
      type: 'list',
      name: 'walletId',
      message: 'Select wallet:',
      choices: wallets,
    },
  ]);

  const wallet = getWallet(agentId, walletId);

  if (!wallet) {
    console.log(chalk.red('Wallet not found'));
    return;
  }

  const { toAddress, amount } = await inquirer.prompt<{
    toAddress: string;
    amount: string;
  }>([
    {
      type: 'input',
      name: 'toAddress',
      message: 'Recipient address:',
      validate: (input) => input.length > 0,
    },
    {
      type: 'input',
      name: 'amount',
      message: 'Amount to send:',
      validate: (input) => parseFloat(input) > 0,
    },
  ]);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Send ${amount} to ${toAddress}?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nTransaction cancelled'));
    return;
  }

  const spinner = ora('Sending transaction...').start();

  try {
    const provider = createWalletProvider(wallet.chain, { isTestnet: false });

    await provider.connect();
    const tx = await provider.sendTransaction(wallet.address, {
      to: toAddress,
      amount,
      chain: wallet.chain as any,
    });

    spinner.succeed('Transaction sent');

    console.log();
    console.log(chalk.cyan('Transaction:'));
    console.log(`  Hash:     ${tx.hash}`);
    console.log(`  From:     ${tx.from}`);
    console.log(`  To:       ${tx.to}`);
    console.log(`  Amount:   ${tx.amount}`);
    console.log(`  Status:   ${tx.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to send transaction: ${message}`);
  }
}

/**
 * Handle wallet list
 */
async function handleList(agentId: string): Promise<void> {
  const wallets = listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  console.log();
  console.log(chalk.cyan(`Wallets for agent: ${agentId}`));
  console.log();

  for (const walletId of wallets) {
    const wallet = getWallet(agentId, walletId);

    if (wallet) {
      console.log(chalk.white(walletId));
      console.log(`  Chain:    ${wallet.chain}`);
      console.log(`  Address:  ${wallet.address}`);
      console.log(`  Created:  ${new Date(wallet.createdAt).toISOString()}`);
      console.log();
    }
  }
}

/**
 * Handle wallet sign
 */
async function handleSign(agentId: string): Promise<void> {
  const { handleSign: signHandler } = await import('./wallet-sign.js');
  await signHandler(agentId);
}

/**
 * Handle wallet history
 */
async function handleHistory(agentId: string): Promise<void> {
  const { handleHistory: historyHandler } = await import('./wallet-history.js');
  await historyHandler(agentId);
}

/**
 * Handle wallet export
 */
async function handleExport(agentId: string): Promise<void> {
  const { handleExport: exportHandler } = await import('./wallet-export.js');
  await exportHandler(agentId);
}

/**
 * Handle wallet import
 */
async function handleImport(agentId: string, filePath?: string): Promise<void> {
  const { handleImport: importHandler } = await import('./wallet-import.js');
  await importHandler(agentId, filePath || '');
}

/**
 * Handle wallet sync to canister (Phase 5)
 */
async function handleSync(agentId: string): Promise<void> {
  console.log(chalk.bold('\n🔄 Wallet Sync to Canister\n'));

  const { canisterId } = await inquirer.prompt<{ canisterId: string }>([
    {
      type: 'input',
      name: 'canisterId',
      message: 'Enter canister ID:',
      validate: (input) => input.length > 0,
    },
  ]);

  const { syncAll } = await inquirer.prompt<{ syncAll: boolean }>([
    {
      type: 'confirm',
      name: 'syncAll',
      message: 'Sync all wallets or specific wallet?',
      default: true,
    },
  ]);

  const spinner = ora('Syncing wallets...').start();

  try {
    const {
      syncAgentWallets,
      syncWalletToCanister,
      listAgentWallets,
    } = await import('../../src/wallet/wallet-manager.js');

    if (syncAll) {
      const result = await syncAgentWallets(agentId, canisterId);

      spinner.succeed('Sync complete');

      console.log();
      console.log(chalk.cyan('Sync Results:'));
      console.log(`  Synced:   ${result.synced.length}`);
      console.log(`  Failed:   ${result.failed.length}`);

      if (result.failed.length > 0) {
        console.log();
        console.log(chalk.yellow('Failed wallets:'));
        for (const fail of result.failed) {
          console.log(`  - ${fail.walletId}: ${fail.error}`);
        }
      }
    } else {
      const wallets = listAgentWallets(agentId);

      if (wallets.length === 0) {
        spinner.warn('No wallets found');
        return;
      }

      spinner.stop();

      const { walletId } = await inquirer.prompt<{ walletId: string }>([
        {
          type: 'list',
          name: 'walletId',
          message: 'Select wallet to sync:',
          choices: wallets,
        },
      ]);

      spinner.start('Syncing wallet...');

      const result = await syncWalletToCanister(agentId, walletId, canisterId);

      if (result.success) {
        spinner.succeed('Wallet synced successfully');
        console.log(`  Registered at: ${new Date(result.registeredAt!).toISOString()}`);
      } else {
        spinner.fail(`Sync failed: ${result.error}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Sync failed: ${message}`);
  }
}

/**
 * Handle wallet sync status (Phase 5)
 */
async function handleStatus(agentId: string): Promise<void> {
  console.log(chalk.bold('\n📊 Wallet Sync Status\n'));

  const { canisterId } = await inquirer.prompt<{ canisterId: string }>([
    {
      type: 'input',
      name: 'canisterId',
      message: 'Enter canister ID:',
      validate: (input) => input.length > 0,
    },
  ]);

  const wallets = (await import('../../src/wallet/wallet-manager.js')).listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  console.log();
  console.log(chalk.cyan(`Wallets for agent: ${agentId}`));
  console.log();

  const { getWalletSyncStatus } = await import('../../src/wallet/wallet-manager.js');

  for (const walletId of wallets) {
    const status = await getWalletSyncStatus(agentId, walletId, canisterId);

    const localIcon = status.localExists ? chalk.green('✓') : chalk.red('✗');
    const canisterIcon = status.inCanister ? chalk.green('✓') : chalk.red('✗');
    const syncIcon = status.synced ? chalk.green('✓') : chalk.yellow('○');

    console.log(chalk.white(walletId));
    console.log(`  Local:     ${localIcon} ${status.localExists ? 'exists' : 'missing'}`);
    console.log(`  Canister:  ${canisterIcon} ${status.inCanister ? 'registered' : 'not registered'}`);
    console.log(`  Synced:    ${syncIcon} ${status.synced ? 'yes' : 'no'}`);
    console.log();
  }
}

/**
 * Handle VetKeys operations (Phase 5)
 */
async function handleVetKeys(): Promise<void> {
  console.log(chalk.bold('\n🔐 VetKeys Operations\n'));

  const { operation } = await inquirer.prompt<{ operation: string }>([
    {
      type: 'list',
      name: 'operation',
      message: 'Select VetKeys operation:',
      choices: [
        { name: 'status', value: 'Get VetKeys status' },
        { name: 'list', value: 'List encrypted secrets' },
        { name: 'get', value: 'Get encrypted secret' },
        { name: 'delete', value: 'Delete encrypted secret' },
      ],
    },
  ]);

  const { canisterId } = await inquirer.prompt<{ canisterId: string }>([
    {
      type: 'input',
      name: 'canisterId',
      message: 'Enter canister ID:',
      validate: (input) => input.length > 0,
    },
  ]);

  const { VetKeysImplementation } = await import('../../src/security/vetkeys.js');
  const vetkeys = new VetKeysImplementation({
    canisterId,
    useCanister: true,
  });

  switch (operation) {
    case 'status':
      await handleVetKeysStatus(vetkeys);
      break;
    case 'list':
      await handleVetKeysList(vetkeys);
      break;
    case 'get':
      await handleVetKeysGet(vetkeys);
      break;
    case 'delete':
      await handleVetKeysDelete(vetkeys);
      break;
  }
}

/**
 * Handle VetKeys status operation
 */
async function handleVetKeysStatus(vetkeys: any): Promise<void> {
  const spinner = ora('Fetching VetKeys status...').start();

  try {
    const status = await vetkeys.getVetKeysStatusFromCanister();

    spinner.succeed('VetKeys status fetched');

    console.log();
    console.log(chalk.cyan('VetKeys Status:'));
    console.log(`  Enabled:           ${status.enabled ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  Threshold Support: ${status.thresholdSupported ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  Mode:              ${status.mode}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch status: ${message}`);
  }
}

/**
 * Handle VetKeys list operation
 */
async function handleVetKeysList(vetkeys: any): Promise<void> {
  const spinner = ora('Listing encrypted secrets...').start();

  try {
    const secrets = await vetkeys.listEncryptedSecretsOnCanister();

    spinner.succeed(`Found ${secrets.length} encrypted secrets`);

    if (secrets.length > 0) {
      console.log();
      console.log(chalk.cyan('Encrypted Secrets:'));
      for (const secretId of secrets) {
        console.log(`  - ${secretId}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to list secrets: ${message}`);
  }
}

/**
 * Handle VetKeys get operation
 */
async function handleVetKeysGet(vetkeys: any): Promise<void> {
  const { secretId } = await inquirer.prompt<{ secretId: string }>([
    {
      type: 'input',
      name: 'secretId',
      message: 'Enter secret ID:',
      validate: (input) => input.length > 0,
    },
  ]);

  const spinner = ora('Fetching encrypted secret...').start();

  try {
    const secret = await vetkeys.getEncryptedSecretFromCanister(secretId);

    if (secret) {
      spinner.succeed('Secret found');
      console.log();
      console.log(chalk.cyan('Encrypted Secret:'));
      console.log(`  ID:       ${secretId}`);
      console.log(`  Algorithm: ${secret.algorithm}`);
      console.log(`  IV:       ${(Array.from(secret.iv) as number[]).map(b => b.toString(16).padStart(2, '0')).join('')}`);
      console.log(`  Tag:      ${(Array.from(secret.tag) as number[]).map(b => b.toString(16).padStart(2, '0')).join('')}`);
      console.log(`  Data:     ${(Array.from(secret.ciphertext) as number[]).slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join('')}...`);
    } else {
      spinner.warn('Secret not found');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch secret: ${message}`);
  }
}

/**
 * Handle VetKeys delete operation
 */
async function handleVetKeysDelete(vetkeys: any): Promise<void> {
  const { secretId } = await inquirer.prompt<{ secretId: string }>([
    {
      type: 'input',
      name: 'secretId',
      message: 'Enter secret ID to delete:',
      validate: (input) => input.length > 0,
    },
  ]);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Are you sure you want to delete secret ${secretId}?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nDelete cancelled'));
    return;
  }

  const spinner = ora('Deleting encrypted secret...').start();

  try {
    const success = await vetkeys.deleteEncryptedSecretFromCanister(secretId);

    if (success) {
      spinner.succeed('Secret deleted successfully');
    } else {
      spinner.warn('Delete failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to delete secret: ${message}`);
  }
}

/**
 * Handle transaction queue operations (Phase 5)
 */
async function handleQueue(agentId: string): Promise<void> {
  console.log(chalk.bold('\n📋 Transaction Queue\n'));

  const { operation } = await inquirer.prompt<{ operation: string }>([
    {
      type: 'list',
      name: 'operation',
      message: 'Select queue operation:',
      choices: [
        { name: 'list', value: 'List all transactions' },
        { name: 'pending', value: 'List pending transactions' },
        { name: 'stats', value: 'Get queue statistics' },
        { name: 'clear', value: 'Clear completed transactions' },
      ],
    },
  ]);

  const { canisterId } = await inquirer.prompt<{ canisterId: string }>([
    {
      type: 'input',
      name: 'canisterId',
      message: 'Enter canister ID:',
      validate: (input) => input.length > 0,
    },
  ]);

  switch (operation) {
    case 'list':
      await handleQueueList(agentId, canisterId);
      break;
    case 'pending':
      await handleQueuePending(agentId, canisterId);
      break;
    case 'stats':
      await handleQueueStats(agentId, canisterId);
      break;
    case 'clear':
      await handleQueueClear(agentId, canisterId);
      break;
  }
}

/**
 * Handle queue list operation
 */
async function handleQueueList(_agentId: string, canisterId: string): Promise<void> {
  const spinner = ora('Fetching transactions...').start();

  try {
    await import('../../src/canister/actor.js');
    const { createActor } = await import('../../src/canister/actor.js');
    const actor = createActor(canisterId);

    const transactions = await actor.getQueuedTransactions();

    spinner.succeed(`Found ${transactions.length} transactions`);

    if (transactions.length > 0) {
      console.log();
      console.log(chalk.cyan('Transaction Queue:'));
      for (const tx of transactions) {
        console.log(`  ID:     ${tx.id}`);
        console.log(`  Action: ${tx.action.action}`);
        console.log(`  Status: ${tx.status}`);
        console.log(`  Created: ${new Date(Number(tx.createdAt)).toISOString()}`);
        console.log();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch transactions: ${message}`);
  }
}

/**
 * Handle queue pending operation
 */
async function handleQueuePending(_agentId: string, canisterId: string): Promise<void> {
  const spinner = ora('Fetching pending transactions...').start();

  try {
    await import('../../src/canister/actor.js');
    const { createActor } = await import('../../src/canister/actor.js');
    const actor = createActor(canisterId);

    const transactions = await actor.getPendingTransactions();

    spinner.succeed(`Found ${transactions.length} pending transactions`);

    if (transactions.length > 0) {
      console.log();
      console.log(chalk.cyan('Pending Transactions:'));
      for (const tx of transactions) {
        console.log(`  ID:     ${tx.id}`);
        console.log(`  Action: ${tx.action.action}`);
        console.log(`  Priority: ${tx.action.priority}`);
        console.log(`  Created: ${new Date(Number(tx.createdAt)).toISOString()}`);
        console.log();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch pending transactions: ${message}`);
  }
}

/**
 * Handle queue stats operation
 */
async function handleQueueStats(_agentId: string, canisterId: string): Promise<void> {
  const spinner = ora('Fetching queue statistics...').start();

  try {
    await import('../../src/canister/actor.js');
    const { createActor } = await import('../../src/canister/actor.js');
    const actor = createActor(canisterId);

    const stats = await actor.getTransactionQueueStats();

    spinner.succeed('Queue statistics fetched');

    console.log();
    console.log(chalk.cyan('Transaction Queue Statistics:'));
    console.log(`  Total:     ${stats.total}`);
    console.log(`  Pending:   ${stats.pending}`);
    console.log(`  Queued:    ${stats.queued}`);
    console.log(`  Signed:    ${stats.signed}`);
    console.log(`  Completed: ${stats.completed}`);
    console.log(`  Failed:    ${stats.failed}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch statistics: ${message}`);
  }
}

/**
 * Handle queue clear operation
 */
async function handleQueueClear(_agentId: string, canisterId: string): Promise<void> {
  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Clear all completed transactions?',
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nClear cancelled'));
    return;
  }

  const spinner = ora('Clearing completed transactions...').start();

  try {
    await import('../../src/canister/actor.js');
    const { createActor } = await import('../../src/canister/actor.js');
    const actor = createActor(canisterId);

    await actor.clearCompletedTransactions();

    spinner.succeed('Completed transactions cleared');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to clear transactions: ${message}`);
  }
}

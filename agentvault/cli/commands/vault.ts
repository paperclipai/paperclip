/**
 * Vault command - Manage agent secrets via HashiCorp Vault or Bitwarden CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import {
  VaultClient,
  loadVaultConfig,
  saveVaultConfig,
  validateVaultConfig,
  loadAgentPolicies,
  getOrCreateAgentPolicy,
  type VaultConfig,
  type VaultAuthMethod,
} from '../../src/vault/index.js';
import { BitwardenProvider } from '../../src/vault/bitwarden.js';
import { HashiCorpVaultProvider } from '../../src/vault/hashicorp-provider.js';
import type { SecretProvider } from '../../src/vault/provider.js';

// ---------------------------------------------------------------------------
// Backend resolution helpers
// ---------------------------------------------------------------------------

type BackendType = 'hashicorp' | 'bitwarden';

function resolveBackend(backendOpt: string | undefined): BackendType {
  const b = (backendOpt ?? process.env.AGENTVAULT_VAULT_BACKEND ?? 'hashicorp').toLowerCase();
  if (b === 'bitwarden' || b === 'bw') return 'bitwarden';
  return 'hashicorp';
}

function buildProvider(agentId: string, backend: BackendType): SecretProvider {
  if (backend === 'bitwarden') {
    return new BitwardenProvider({ agentId });
  }
  return HashiCorpVaultProvider.forAgent(agentId);
}

// ---------------------------------------------------------------------------

const vaultCmd = new Command('vault');

vaultCmd
  .description('Manage agent secrets and API keys (HashiCorp Vault or Bitwarden)')
  .action(async () => {
    console.log(chalk.yellow('Please specify a subcommand: init, store, get, put, list, delete, health, or policy'));
    console.log(chalk.gray(`\nExamples:
  ${chalk.cyan('agentvault vault init')}${chalk.gray('                                         Configure Vault connection')}
  ${chalk.cyan('agentvault vault health')}${chalk.gray('                                       Check backend health')}
  ${chalk.cyan('agentvault vault store --key api_binance --value $KEY')}${chalk.gray('         Store a named secret')}
  ${chalk.cyan('agentvault vault put <agent-id> <key> <value>')}${chalk.gray('                 Store a secret (explicit agent)')}
  ${chalk.cyan('agentvault vault get <agent-id> <key>')}${chalk.gray('                         Retrieve a secret')}
  ${chalk.cyan('agentvault vault list <agent-id>')}${chalk.gray('                              List agent secrets')}
  ${chalk.cyan('agentvault vault delete <agent-id> <key>')}${chalk.gray('                      Delete a secret')}
  ${chalk.cyan('agentvault vault policy <agent-id>')}${chalk.gray('                            View agent policy')}

  ${chalk.gray('Set AGENTVAULT_VAULT_BACKEND=bitwarden to use the Bitwarden CLI instead.')}`));
  });

// --- vault init ---
vaultCmd
  .command('init')
  .description('Configure HashiCorp Vault connection for AgentVault')
  .option('-a, --address <url>', 'Vault server address')
  .option('-t, --token <token>', 'Vault token')
  .option('--auth-method <method>', 'Authentication method (token, approle, userpass, kubernetes)')
  .option('--non-interactive', 'Skip interactive prompts (requires --address and auth flags)')
  .action(async (options) => {
    console.log(chalk.bold('\nAgentVault - Vault Configuration\n'));

    let config: VaultConfig;

    if (options.nonInteractive) {
      if (!options.address) {
        console.error(chalk.red('--address is required in non-interactive mode'));
        process.exit(1);
      }

      config = {
        address: options.address,
        authMethod: (options.authMethod as VaultAuthMethod) ?? 'token',
        token: options.token,
      };
    } else {
      const existingConfig = loadVaultConfig();

      const answers = await inquirer.prompt<{
        address: string;
        authMethod: VaultAuthMethod;
        token?: string;
        roleId?: string;
        secretId?: string;
        username?: string;
        password?: string;
        k8sRole?: string;
        namespace?: string;
      }>([
        {
          type: 'input',
          name: 'address',
          message: 'Vault server address:',
          default: existingConfig?.address ?? 'http://127.0.0.1:8200',
        },
        {
          type: 'list',
          name: 'authMethod',
          message: 'Authentication method:',
          choices: [
            { name: 'Token', value: 'token' },
            { name: 'AppRole', value: 'approle' },
            { name: 'Username/Password', value: 'userpass' },
            { name: 'Kubernetes', value: 'kubernetes' },
          ],
          default: existingConfig?.authMethod ?? 'token',
        },
        {
          type: 'password',
          name: 'token',
          message: 'Vault token:',
          when: (answers) => answers.authMethod === 'token',
        },
        {
          type: 'input',
          name: 'roleId',
          message: 'AppRole role ID:',
          when: (answers) => answers.authMethod === 'approle',
        },
        {
          type: 'password',
          name: 'secretId',
          message: 'AppRole secret ID:',
          when: (answers) => answers.authMethod === 'approle',
        },
        {
          type: 'input',
          name: 'username',
          message: 'Username:',
          when: (answers) => answers.authMethod === 'userpass',
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password:',
          when: (answers) => answers.authMethod === 'userpass',
        },
        {
          type: 'input',
          name: 'k8sRole',
          message: 'Kubernetes auth role:',
          when: (answers) => answers.authMethod === 'kubernetes',
        },
        {
          type: 'input',
          name: 'namespace',
          message: 'Vault namespace (leave empty for none):',
          default: '',
        },
      ]);

      config = {
        address: answers.address,
        authMethod: answers.authMethod,
        token: answers.token,
        roleId: answers.roleId,
        secretId: answers.secretId,
        username: answers.username,
        password: answers.password,
        k8sRole: answers.k8sRole,
        namespace: answers.namespace || undefined,
      };
    }

    // Validate
    const errors = validateVaultConfig(config);
    if (errors.length > 0) {
      console.error(chalk.red('Configuration errors:'));
      for (const error of errors) {
        console.error(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    // Save
    const spinner = ora('Saving Vault configuration...').start();
    try {
      saveVaultConfig(config);
      spinner.succeed(chalk.green('Vault configuration saved'));

      console.log(chalk.gray(`\nConnection: ${config.address}`));
      console.log(chalk.gray(`Auth method: ${config.authMethod}`));
      if (config.namespace) {
        console.log(chalk.gray(`Namespace: ${config.namespace}`));
      }

      console.log(chalk.cyan('\nNext steps:'));
      console.log(`  1. Verify connection: ${chalk.bold('agentvault vault health')}`);
      console.log(`  2. Store a secret:    ${chalk.bold('agentvault vault put <agent-id> <key> <value>')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Failed to save configuration: ${message}`));
      process.exit(1);
    }
  });

// --- vault health ---
vaultCmd
  .command('health')
  .description('Check secret backend health status')
  .option('--backend <backend>', 'Secret backend to use: hashicorp (default) or bitwarden')
  .action(async (options) => {
    const backend = resolveBackend(options.backend as string | undefined);

    // For HashiCorp we still do the detailed health check via VaultClient
    if (backend === 'hashicorp') {
      const config = loadVaultConfig();
      if (!config) {
        console.error(chalk.red('Vault is not configured. Run `agentvault vault init` first.'));
        process.exit(1);
      }

      const spinner = ora('Checking Vault health...').start();
      try {
        const policy = getOrCreateAgentPolicy('_health_check');
        const client = VaultClient.createWithConfig(config, policy);
        const result = await client.health();

        if (result.success && result.data) {
          const status = result.data;
          if (status.sealed) {
            spinner.warn(chalk.yellow('Vault is sealed'));
          } else {
            spinner.succeed(chalk.green('Vault is healthy'));
          }

          console.log(chalk.cyan('\nVault Status:'));
          console.log(`  Backend:     HashiCorp Vault`);
          console.log(`  Address:     ${config.address}`);
          console.log(`  Version:     ${status.version}`);
          console.log(`  Initialized: ${status.initialized ? chalk.green('yes') : chalk.red('no')}`);
          console.log(`  Sealed:      ${status.sealed ? chalk.red('yes') : chalk.green('no')}`);
          if (status.clusterName) {
            console.log(`  Cluster:     ${status.clusterName}`);
          }
        } else {
          spinner.fail(chalk.red(result.error ?? 'Failed to check Vault health'));
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(chalk.red(`Health check failed: ${message}`));
        process.exit(1);
      }
      return;
    }

    // Bitwarden health check
    const spinner = ora('Checking Bitwarden CLI health...').start();
    try {
      const provider = new BitwardenProvider({ agentId: '_health_check' });
      const result = await provider.healthCheck();
      if (result.healthy) {
        spinner.succeed(chalk.green(result.message));
      } else {
        spinner.fail(chalk.red(result.message));
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Health check failed: ${message}`));
      process.exit(1);
    }
  });

// --- vault store ---
// Simplified "store this secret right now" command.
// Uses --key / --value flags instead of positional args so it's shell-friendly:
//   agentvault vault store --key api_binance --value $KEY
// The agent-id defaults to the current project config or can be set via --agent.
vaultCmd
  .command('store')
  .description('Store a named secret (zero persistence in canister)')
  .requiredOption('-k, --key <key>', 'Secret key name, e.g. api_binance')
  .option('-v, --value <value>', 'Secret value (omit to read from stdin or interactive prompt)')
  .option('-a, --agent <agent-id>', 'Agent ID (defaults to "default")')
  .option('--backend <backend>', 'Secret backend: hashicorp (default) or bitwarden')
  .action(async (options) => {
    const agentId: string = (options.agent as string | undefined) ?? 'default';
    const key: string = options.key as string;
    const backend = resolveBackend(options.backend as string | undefined);

    let value: string = options.value as string | undefined ?? '';

    // Read from stdin or prompt when --value is not provided
    if (!value) {
      if (process.stdin.isTTY) {
        const answers = await inquirer.prompt<{ secretValue: string }>([
          {
            type: 'password',
            name: 'secretValue',
            message: `Enter value for "${key}":`,
            mask: '*',
          },
        ]);
        value = answers.secretValue;
      } else {
        // Non-interactive: read from stdin pipe
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        value = Buffer.concat(chunks).toString('utf-8').trim();
      }
    }

    if (!value) {
      console.error(chalk.red('Secret value cannot be empty'));
      process.exit(1);
    }

    const backendLabel = backend === 'bitwarden' ? 'Bitwarden' : 'HashiCorp Vault';
    const spinner = ora(`Storing secret "${key}" for agent "${agentId}" via ${backendLabel}...`).start();

    try {
      const provider = buildProvider(agentId, backend);
      await provider.storeSecret(key, value);
      spinner.succeed(chalk.green(`Secret "${key}" stored for agent "${agentId}" via ${backendLabel}`));
      console.log(chalk.gray('  Value is held only in the backend – zero persistence in canister.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

// --- vault get ---
vaultCmd
  .command('get')
  .description('Retrieve a secret from Vault for an agent')
  .argument('<agent-id>', 'Agent identifier')
  .argument('<key>', 'Secret key')
  .option('--json', 'Output as JSON')
  .action(async (agentId, key, options) => {
    const spinner = ora(`Retrieving secret "${key}" for agent "${agentId}"...`).start();

    try {
      const client = VaultClient.create(agentId);
      const result = await client.getSecret(key);

      if (result.success && result.data) {
        spinner.succeed(chalk.green(`Secret "${key}" retrieved`));

        if (options.json) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          const value = result.data.value;
          if (typeof value === 'string') {
            console.log(chalk.cyan(`\n  ${key}: `) + value);
          } else {
            console.log(chalk.cyan(`\n  ${key}:`));
            for (const [k, v] of Object.entries(value)) {
              console.log(`    ${k}: ${v}`);
            }
          }
          console.log(chalk.gray(`\n  Version: ${result.data.metadata.version}`));
          console.log(chalk.gray(`  Updated: ${result.data.metadata.updatedAt}`));
        }
      } else {
        spinner.fail(chalk.red(result.error ?? `Secret "${key}" not found`));
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

// --- vault put ---
vaultCmd
  .command('put')
  .description('Store a secret in Vault for an agent')
  .argument('<agent-id>', 'Agent identifier')
  .argument('<key>', 'Secret key')
  .argument('[value]', 'Secret value (omit to read from stdin or prompt)')
  .option('--metadata <json>', 'Custom metadata as JSON string')
  .action(async (agentId, key, value, options) => {
    // If no value provided, prompt for it
    if (!value) {
      const answers = await inquirer.prompt<{ secretValue: string }>([
        {
          type: 'password',
          name: 'secretValue',
          message: `Enter value for "${key}":`,
          mask: '*',
        },
      ]);
      value = answers.secretValue;
    }

    let metadata: Record<string, string> | undefined;
    if (options.metadata) {
      try {
        metadata = JSON.parse(options.metadata) as Record<string, string>;
      } catch {
        console.error(chalk.red('Invalid metadata JSON'));
        process.exit(1);
      }
    }

    const spinner = ora(`Storing secret "${key}" for agent "${agentId}"...`).start();

    try {
      const client = VaultClient.create(agentId);
      const result = await client.putSecret(key, value, metadata);

      if (result.success) {
        spinner.succeed(chalk.green(`Secret "${key}" stored for agent "${agentId}"`));
        if (result.data) {
          console.log(chalk.gray(`  Version: ${result.data.version}`));
        }
      } else {
        spinner.fail(chalk.red(result.error ?? 'Failed to store secret'));
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

// --- vault list ---
vaultCmd
  .command('list')
  .description('List all secrets for an agent')
  .argument('<agent-id>', 'Agent identifier')
  .option('--json', 'Output as JSON')
  .action(async (agentId, options) => {
    const spinner = ora(`Listing secrets for agent "${agentId}"...`).start();

    try {
      const client = VaultClient.create(agentId);
      const result = await client.listSecrets();

      if (result.success && result.data) {
        const count = result.data.length;
        spinner.succeed(chalk.green(`Found ${count} secret(s) for agent "${agentId}"`));

        if (count === 0) {
          console.log(chalk.gray('\nNo secrets stored yet.'));
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.log(chalk.cyan('\nSecrets:'));
          for (const entry of result.data) {
            console.log(`  - ${entry.key}`);
          }
        }
      } else {
        spinner.fail(chalk.red(result.error ?? 'Failed to list secrets'));
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

// --- vault delete ---
vaultCmd
  .command('delete')
  .description('Delete a secret from Vault for an agent')
  .argument('<agent-id>', 'Agent identifier')
  .argument('<key>', 'Secret key to delete')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (agentId, key, options) => {
    if (!options.yes) {
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Delete secret "${key}" for agent "${agentId}"?`,
          default: false,
        },
      ]);

      if (!confirmed) {
        console.log(chalk.yellow('Deletion cancelled.'));
        return;
      }
    }

    const spinner = ora(`Deleting secret "${key}" for agent "${agentId}"...`).start();

    try {
      const client = VaultClient.create(agentId);
      const result = await client.deleteSecret(key);

      if (result.success) {
        spinner.succeed(chalk.green(`Secret "${key}" deleted for agent "${agentId}"`));
      } else {
        spinner.fail(chalk.red(result.error ?? 'Failed to delete secret'));
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

// --- vault policy ---
vaultCmd
  .command('policy')
  .description('View or configure agent Vault access policy')
  .argument('<agent-id>', 'Agent identifier')
  .option('--json', 'Output as JSON')
  .action(async (agentId, options) => {
    const policies = loadAgentPolicies();
    const policy = policies.get(agentId);

    if (!policy) {
      console.log(chalk.yellow(`No policy configured for agent "${agentId}".`));
      console.log(chalk.gray('A default policy will be created when the agent first accesses Vault.'));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(policy, null, 2));
    } else {
      console.log(chalk.bold(`\nVault Policy for "${agentId}"\n`));
      console.log(`  Secret Path:    ${chalk.cyan(policy.secretPath)}`);
      console.log(`  Engine:         ${policy.engine}`);
      console.log(`  Allow Create:   ${policy.allowCreate ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`  Allow Update:   ${policy.allowUpdate ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`  Allow Delete:   ${policy.allowDelete ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`  Allow List:     ${policy.allowList ? chalk.green('yes') : chalk.red('no')}`);
      if (policy.maxSecrets) {
        console.log(`  Max Secrets:    ${policy.maxSecrets}`);
      }
      if (policy.allowedKeyPatterns && policy.allowedKeyPatterns.length > 0) {
        console.log(`  Key Patterns:   ${policy.allowedKeyPatterns.join(', ')}`);
      }
    }
  });

export { vaultCmd };

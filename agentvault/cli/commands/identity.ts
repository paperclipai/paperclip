/**
 * Identity Command
 *
 * Manages identities for ICP operations.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  listIdentities,
  createIdentity,
  exportIdentity,
  getIdentityPrincipal,
  importIdentity,
  setDefaultIdentity,
} from '../../src/icp/identity.js';

export function identityCommand(): Command {
  const command = new Command('identity');

  command
    .description('Manage ICP identities')
    .action(() => {
      command.outputHelp();
    })
    .addCommand(listSubcommand())
    .addCommand(createSubcommand())
    .addCommand(exportSubcommand())
    .addCommand(importSubcommand())
    .addCommand(principalSubcommand())
    .addCommand(defaultSubcommand());

  return command;
}

async function executeList(): Promise<void> {
  const spinner = ora('Listing identities...').start();

  try {
    const result = await listIdentities();
    spinner.succeed('Identities listed successfully');
    console.log();
    console.log(chalk.cyan('Available Identities:'));
    console.log(result.stdout || 'No identities found');
  } catch (error) {
    spinner.fail(`Failed to list identities: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeCreate(options: any): Promise<void> {
  const { name } = options;

  const spinner = ora('Creating identity...').start();

  try {
    await createIdentity(name);
    spinner.succeed(`Identity '${name}' created successfully`);
  } catch (error) {
    spinner.fail(`Failed to create identity: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeExport(options: any): Promise<void> {
  const { name } = options;

  const spinner = ora('Exporting identity...').start();

  try {
    const result = await exportIdentity(name);
    spinner.succeed(`Identity '${name}' exported successfully`);
    console.log();
    console.log(chalk.cyan('PEM Content:'));
    console.log(result.stdout || 'No PEM content returned');
  } catch (error) {
    spinner.fail(`Failed to export identity: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeImport(options: any): Promise<void> {
  const { name, pemFile } = options;

  const spinner = ora('Importing identity...').start();

  try {
    await importIdentity(name, pemFile);
    spinner.succeed(`Identity '${name}' imported successfully`);
    console.log(chalk.cyan('Imported from:'), pemFile);
  } catch (error) {
    spinner.fail(`Failed to import identity: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executePrincipal(options: any): Promise<void> {
  const { name } = options;

  const spinner = ora('Getting identity principal...').start();

  try {
    const result = await getIdentityPrincipal(name);
    spinner.succeed(`Identity '${name}' principal: ${result || 'N/A'}`);
  } catch (error) {
    spinner.fail(`Failed to get identity principal: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeSetDefault(options: any): Promise<void> {
  const { name } = options;

  const spinner = ora('Setting default identity...').start();

  try {
    await setDefaultIdentity(name);
    spinner.succeed(`Identity '${name}' set as default`);
  } catch (error) {
    spinner.fail(`Failed to set default identity: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

function listSubcommand(): Command {
  return new Command('list')
    .description('List all ICP identities')
    .action(executeList);
}

function createSubcommand(): Command {
  return new Command('create')
    .description('Create a new ICP identity')
    .argument('<name>', 'Identity name')
    .action(executeCreate);
}

function exportSubcommand(): Command {
  return new Command('export')
    .description('Export identity to PEM file')
    .argument('<name>', 'Identity name')
    .argument('[pem-file]', 'Path to PEM file')
    .action(executeExport);
}

function importSubcommand(): Command {
  return new Command('import')
    .description('Import identity from PEM file')
    .argument('<name>', 'Identity name')
    .argument('[pem-file]', 'Path to PEM file')
    .action(executeImport);
}

function principalSubcommand(): Command {
  return new Command('principal')
    .description('Get the principal of an identity')
    .argument('[name]', 'Identity name (optional)')
    .action(executePrincipal);
}

function defaultSubcommand(): Command {
  return new Command('default')
    .description('Set the default identity')
    .argument('<name>', 'Identity name')
    .action(executeSetDefault);
}

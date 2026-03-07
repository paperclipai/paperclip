/**
 * List command - List all agents
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ListCommandOptions {
  all?: boolean;
  deployed?: boolean;
  local?: boolean;
  json?: boolean;
}

export interface AgentInfo {
  name: string;
  type: string;
  sourcePath: string;
  deployed?: boolean;
  canisterId?: string;
  network?: string;
  lastUpdated?: string;
}

/**
 * Get list of all agents
 */
export async function getAgents(options: ListCommandOptions): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];

  // Get agents from local filesystem
  const localAgents = await getLocalAgents();

  if (options.local || !options.deployed) {
    agents.push(...localAgents);
  }

  // In a real implementation, this would query deployed canisters
  if (options.deployed || options.all) {
    const deployedAgents = await getDeployedAgents();
    agents.push(...deployedAgents);
  }

  return agents;
}

/**
 * Get local agents from filesystem
 */
async function getLocalAgents(): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];

  // Check for agentvault directory
  const agentDir = path.join(process.cwd(), '.agentvault');

  if (fs.existsSync(agentDir)) {
    const agentsDir = path.join(agentDir, 'agents');

    if (fs.existsSync(agentsDir)) {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const agentPath = path.join(agentsDir, entry.name);
          const stateFile = path.join(agentPath, 'state.json');

          if (fs.existsSync(stateFile)) {
            try {
              const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              agents.push({
                name: entry.name,
                type: state.agent?.type || 'generic',
                sourcePath: agentPath,
                deployed: false,
                lastUpdated: state.metadata?.createdAt,
              });
            } catch {
              // Skip invalid state files
            }
          }
        }
      }
    }
  }

  // Also check for dist directories with WASM files
  const distDir = path.join(process.cwd(), 'dist');

  if (fs.existsSync(distDir)) {
    const entries = fs.readdirSync(distDir);

    for (const entry of entries) {
      if (entry.endsWith('.wasm')) {
        const name = entry.replace('.wasm', '');
        const stateFile = path.join(distDir, `${name}.state.json`);

        if (fs.existsSync(stateFile)) {
          try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            agents.push({
              name,
              type: state.agent?.type || 'generic',
              sourcePath: process.cwd(),
              deployed: false,
              lastUpdated: state.metadata?.createdAt,
            });
          } catch {
            agents.push({
              name,
              type: 'generic',
              sourcePath: process.cwd(),
              deployed: false,
            });
          }
        }
      }
    }
  }

  return agents;
}

/**
 * Get deployed agents (stub)
 */
async function getDeployedAgents(): Promise<AgentInfo[]> {
  // Stub: In a real implementation, this would query the canister registry
  return [];
}

/**
 * Display list of agents
 */
export function displayAgents(agents: AgentInfo[], options: ListCommandOptions): void {
  if (options.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }

  console.log();

  if (agents.length === 0) {
    console.log(chalk.yellow('No agents found.'));
    console.log();
    console.log('Create a new agent with:', chalk.bold('agentvault init'));
    return;
  }

  console.log(chalk.cyan(`Found ${agents.length} agent(s):\n`));

  for (const agent of agents) {
    console.log(chalk.bold(agent.name));

    console.log(`  Type:     ${agent.type}`);
    console.log(`  Source:    ${agent.sourcePath}`);

    if (agent.deployed && agent.canisterId) {
      console.log(`  Canister:  ${agent.canisterId}`);
      console.log(`  Network:   ${agent.network}`);
    } else {
      console.log(`  Status:    ${chalk.yellow('Not deployed')}`);
    }

    if (agent.lastUpdated) {
      console.log(`  Updated:   ${agent.lastUpdated}`);
    }

    console.log();
  }
}

/**
 * Execute list command
 */
export async function executeList(options: ListCommandOptions): Promise<void> {
  const spinner = ora('Scanning for agents...').start();

  try {
    const agents = await getAgents(options);

    spinner.succeed('Scan complete!');

    displayAgents(agents, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`List failed: ${message}`);
    throw error;
  }
}

/**
 * Create list command
 */
export function listCommand(): Command {
  const command = new Command('list');

  command
    .description('List all agents')
    .option('-a, --all', 'show all agents (local and deployed)')
    .option('--deployed', 'show only deployed agents')
    .option('--local', 'show only local agents')
    .option('-j, --json', 'output as JSON')
    .action(async (options: ListCommandOptions) => {
      console.log(chalk.bold('\n📋 AgentVault List\n'));

      try {
        await executeList(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}

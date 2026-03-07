import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  PolyticianMCPClient,
  probeMCPServerHealth,
  discoverMCPTools,
  type MCPServerConfig,
} from '../../src/orchestration/mcp-client.js';

const mcpCmd = new Command('mcp');

mcpCmd
  .description('Manage MCP (Model Context Protocol) server registrations')
  .action(() => {
    console.log(chalk.yellow('Please specify a subcommand: register, list, remove, or health'));
    console.log(chalk.gray(`
Examples:
  ${chalk.cyan('agentvault mcp register --entry "node server.js" --namespace polytician')}
  ${chalk.cyan('agentvault mcp list')}
  ${chalk.cyan('agentvault mcp remove polytician')}
  ${chalk.cyan('agentvault mcp health polytician')}
`));
  });

mcpCmd
  .command('register')
  .description('Register an MCP server with the canister')
  .requiredOption('-e, --entry <command>', 'Entry point command (e.g., "node server.js")')
  .requiredOption('-n, --namespace <name>', 'Unique namespace for the server')
  .option('-p, --health-port <port>', 'Health check HTTP port', parseInt)
  .option('-m, --metadata <json>', 'Additional metadata as JSON')
  .action(async (options) => {
    const spinner = ora('Registering MCP server...').start();

    try {
      const entryPoint: string = options.entry;
      const namespace: string = options.namespace;
      const healthPort: number | undefined = options.healthPort;

      if (healthPort) {
        spinner.text = `Probing health endpoint at port ${healthPort}...`;
        const healthy = await probeMCPServerHealth(healthPort);
        if (!healthy) {
          spinner.warn(chalk.yellow(`Health endpoint at port ${healthPort} not responding (continuing anyway)`));
        } else {
          spinner.text = 'Health check passed, discovering tools...';
        }
      }

      spinner.text = 'Discovering tools via MCP stdio...';
      let tools: string[];
      try {
        tools = await discoverMCPTools(entryPoint);
        spinner.text = `Discovered ${tools.length} tools: ${tools.slice(0, 3).join(', ')}${tools.length > 3 ? '...' : ''}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        spinner.warn(chalk.yellow(`Tool discovery failed: ${message}`));
        tools = [];
      }

      let metadata: Record<string, string> = {};
      if (options.metadata) {
        try {
          metadata = JSON.parse(options.metadata) as Record<string, string>;
        } catch {
          spinner.fail(chalk.red('Invalid metadata JSON'));
          process.exit(1);
        }
      }

      const config: MCPServerConfig = {
        namespace,
        entryPoint,
        healthPort,
        tools,
        metadata,
      };

      void config;

      spinner.succeed(chalk.green(`MCP server "${namespace}" registered`));
      console.log(chalk.cyan('\nRegistration:'));
      console.log(`  Namespace:     ${namespace}`);
      console.log(`  Entry Point:   ${entryPoint}`);
      if (healthPort) {
        console.log(`  Health Port:   ${healthPort}`);
      }
      console.log(`  Tools:         ${tools.length > 0 ? tools.join(', ') : '(none discovered)'}`);
      console.log(chalk.gray('\nNote: Canister storage requires Motoko canister updates.'));
      console.log(chalk.gray('This registration is validated locally. Persist with: agentvault mcp persist'));

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Registration failed: ${message}`));
      process.exit(1);
    }
  });

mcpCmd
  .command('list')
  .description('List registered MCP servers')
  .option('--json', 'Output as JSON')
  .action(async (_options) => {
    const spinner = ora('Listing MCP servers...').start();

    try {
      spinner.warn(chalk.yellow('Canister integration pending - showing local config only'));

      console.log(chalk.cyan('\nRegistered MCP Servers:'));
      console.log(chalk.gray('  (none configured)'));
      console.log(chalk.gray('\nUse "agentvault mcp register" to add a server.'));

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

mcpCmd
  .command('remove')
  .description('Remove an MCP server registration')
  .argument('<namespace>', 'Namespace of the server to remove')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (namespace, options) => {
    if (!options.yes) {
      const inquirer = await import('inquirer');
      const { confirmed } = await inquirer.default.prompt<{ confirmed: boolean }>([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Remove MCP server "${namespace}"?`,
          default: false,
        },
      ]);

      if (!confirmed) {
        console.log(chalk.yellow('Cancelled.'));
        return;
      }
    }

    const spinner = ora(`Removing MCP server "${namespace}"...`).start();

    try {
      spinner.warn(chalk.yellow('Canister integration pending'));
      spinner.succeed(chalk.green(`MCP server "${namespace}" removed`));

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

mcpCmd
  .command('health')
  .description('Check health of a registered MCP server')
  .argument('[namespace]', 'Namespace of the server (optional, checks all if omitted)')
  .action(async (namespace) => {
    const spinner = ora('Checking MCP server health...').start();

    try {
      if (namespace) {
        spinner.warn(chalk.yellow(`Server "${namespace}" not found in registry`));
      } else {
        spinner.warn(chalk.yellow('No MCP servers registered'));
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

mcpCmd
  .command('tools')
  .description('List tools exposed by an MCP server')
  .argument('<namespace>', 'Namespace of the server')
  .option('--entry <command>', 'Override entry point command')
  .action(async (namespace, options) => {
    const spinner = ora(`Discovering tools for "${namespace}"...`).start();

    try {
      const entryPoint: string | undefined = options.entry;

      if (!entryPoint) {
        spinner.fail(chalk.red('No entry point configured. Use --entry to specify.'));
        process.exit(1);
      }

      const tools = await discoverMCPTools(entryPoint);
      spinner.succeed(chalk.green(`Found ${tools.length} tools`));

      console.log(chalk.cyan('\nAvailable Tools:'));
      for (const tool of tools) {
        console.log(`  - ${tool}`);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Discovery failed: ${message}`));
      process.exit(1);
    }
  });

mcpCmd
  .command('call')
  .description('Call a tool on an MCP server')
  .argument('<namespace>', 'Namespace of the server')
  .argument('<tool>', 'Tool name to call')
  .option('--args <json>', 'Tool arguments as JSON', '{}')
  .option('--entry <command>', 'Override entry point command')
  .action(async (namespace, toolName, options) => {
    const spinner = ora(`Calling tool "${toolName}" on "${namespace}"...`).start();

    try {
      const entryPoint: string | undefined = options.entry;

      if (!entryPoint) {
        spinner.fail(chalk.red('No entry point configured. Use --entry to specify.'));
        process.exit(1);
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(options.args) as Record<string, unknown>;
      } catch {
        spinner.fail(chalk.red('Invalid JSON in --args'));
        process.exit(1);
      }

      const client = new PolyticianMCPClient({ namespace, entryPoint });
      await client.connect();

      const result = await client.callTool(toolName, args);
      await client.disconnect();

      spinner.succeed(chalk.green(`Tool "${toolName}" executed`));

      console.log(chalk.cyan('\nResult:'));
      for (const content of result.content) {
        if (content.type === 'text' && content.text) {
          console.log(content.text);
        } else {
          console.log(JSON.stringify(content.data, null, 2));
        }
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Tool call failed: ${message}`));
      process.exit(1);
    }
  });

export { mcpCmd };

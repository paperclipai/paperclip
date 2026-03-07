#!/usr/bin/env node
/**
 * AgentVault CLI
 *
 * Command-line interface for the AgentVault platform.
 */

import { Command } from 'commander';
import { VERSION } from '../src/index.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { packageCommand } from './commands/package.js';
import { deployCommand } from './commands/deploy.js';
import { fetchCommand } from './commands/fetch.js';
import { decryptCommand } from './commands/decrypt.js';
import { rebuildCommand } from './commands/rebuild.js';
import { execCommand } from './commands/exec.js';
import { listCommand } from './commands/list.js';
import { showCommand } from './commands/show.js';
import { walletCommand } from './commands/wallet.js';
import { identityCommand } from './commands/identity.js';
import { cyclesCommand } from './commands/cycles.js';
import { tokensCommand } from './commands/tokens.js';
import { infoCommand } from './commands/info.js';
import { statsCommand } from './commands/stats.js';
import { monitorCommand } from './commands/monitor.js';
import { healthCommand } from './commands/health.js';

// Phase 3 commands
import { networkCmd } from './commands/network.js';
import { testCmd } from './commands/test.js';
import { promoteCmd } from './commands/promote.js';
import { logsCmd } from './commands/logs.js';
import { rollbackCmd } from './commands/rollback.js';
import { instrumentCmd } from './commands/instrument.js';
import { traceCmd } from './commands/trace.js';
import { profileCmd } from './commands/profile.js';

// Phase 4 commands
import { backupCmd } from './commands/backup.js';
import { archiveCmd } from './commands/archive.js';
import { inferenceCmd } from './commands/inference.js';
import { approveCmd } from './commands/approve.js';
import { cloudBackupCmd } from './commands/cloud-backup.js';

// Phase 5 commands
import { vaultCmd } from './commands/vault.js';

// Phase 6 commands (PRD-004: Private ICP Replica)
import { pilotCmd } from './commands/pilot.js';
// iOS skills command
import { skillsCmd } from './commands/skills.js';
// Phase 6 commands
import { orchestrateCmd } from './commands/orchestrate.js';
// Google ADK / A2A agent minting
import { mintCmd } from './commands/mint.js';

// Fault Tolerance commands
import { cronCmd } from './commands/cron.js';
import { mirrorCmd } from './commands/mirror.js';

// Security & audit commands
import { repoCmd } from './commands/repo.js';

// MemoryRepo commands
import { memoryCmd } from './commands/memory.js';

// MCP commands (Phase 2)
import { mcpCmd } from './commands/mcp.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentvault')
    .description('Persistent On-Chain AI Agent Platform - Sovereign, Reconstructible, Autonomous')
    .version(VERSION, '-v, --version', 'output the current version');

  // Register commands
  program.addCommand(initCommand());
  program.addCommand(statusCommand());
  program.addCommand(packageCommand());
  program.addCommand(deployCommand());
  program.addCommand(fetchCommand());
  program.addCommand(decryptCommand());
  program.addCommand(rebuildCommand());
  program.addCommand(execCommand());
  program.addCommand(listCommand());
  program.addCommand(showCommand());
  program.addCommand(walletCommand());

  // Phase 2 commands
  program.addCommand(identityCommand());
  program.addCommand(cyclesCommand());
  program.addCommand(tokensCommand());
  program.addCommand(infoCommand());
  program.addCommand(statsCommand());
  program.addCommand(monitorCommand());
  program.addCommand(healthCommand());

  // Phase 3 commands
  program.addCommand(networkCmd);
  program.addCommand(testCmd);
  program.addCommand(promoteCmd);
  program.addCommand(logsCmd);
  program.addCommand(rollbackCmd);
  program.addCommand(instrumentCmd);
  program.addCommand(traceCmd);
  program.addCommand(profileCmd);

  // Phase 4 commands
  program.addCommand(backupCmd);
  program.addCommand(archiveCmd);
  program.addCommand(inferenceCmd);
  program.addCommand(approveCmd);
  program.addCommand(cloudBackupCmd);

  // Phase 5 commands
  program.addCommand(vaultCmd);

  // Phase 6 commands (PRD-004: Private ICP Replica)
  program.addCommand(pilotCmd);
  // iOS skills command
  program.addCommand(skillsCmd);
  // Phase 6 commands
  program.addCommand(orchestrateCmd());
  // Google ADK / A2A agent minting
  program.addCommand(mintCmd());

  // Fault Tolerance commands
  program.addCommand(cronCmd());
  program.addCommand(mirrorCmd());

  // Security & audit commands
  program.addCommand(repoCmd);

  // MemoryRepo commands
  program.addCommand(memoryCmd);

  // MCP commands
  program.addCommand(mcpCmd);

  return program;
}

export async function run(args: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(args);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error: Error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

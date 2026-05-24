#!/usr/bin/env tsx
/**
 * Import Agents - Full Workflow
 * Orchestrates github-repo-reader + agent-format-converter + agent creation
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the functions from our scripts
// In production, these would be proper modules
async function runCommand(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || 1
    };
  }
}

async function importAgents(repoUrl: string, options: {
  companyId?: string;
  githubToken?: string;
  dryRun?: boolean;
  reportsTo?: string;
}) {
  console.log('🚀 Starting agent import workflow...\n');

  // Parse GitHub URL
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) {
    throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  }

  const [, owner, repo] = match;
  console.log(`📦 Repository: ${owner}/${repo}`);

  // Step 1: Fetch agents from GitHub
  console.log('\n📖 Step 1: Reading GitHub repository...');

  const scriptDir = path.dirname(__filename);
  const readerScript = path.join(scriptDir, 'github-repo-reader.ts');

  const readerResult = await runCommand(
    `cd ${path.join(scriptDir, '..')} && npx tsx ${readerScript} ${owner}/${repo} ${options.githubToken || ''}`
  );

  if (readerResult.exitCode !== 0) {
    throw new Error(`Failed to read repository: ${readerResult.stderr}`);
  }

  // Extract JSON output
  const jsonMatch = readerResult.stdout.match(/---JSON---\n([\s\S]+)$/);
  if (!jsonMatch) {
    throw new Error('No agent data found in repository');
  }

  const externalAgents = JSON.parse(jsonMatch[1]);
  console.log(`✅ Found ${externalAgents.length} agent(s)`);

  if (externalAgents.length === 0) {
    console.log('⚠️  No agents found. Exiting.');
    return { imported: 0, failed: 0, agents: [] };
  }

  // Step 2: Convert to Paperclip format
  console.log('\n🔄 Step 2: Converting to Paperclip format...');

  const converterScript = path.join(scriptDir, 'agent-format-converter.ts');

  // Write external agents to temp file
  const tempFile = `/tmp/import-agents-${Date.now()}.json`;
  writeFileSync(tempFile, JSON.stringify(externalAgents, null, 2));

  const converterResult = await runCommand(
    `npx tsx ${converterScript} ${tempFile}`
  );

  if (converterResult.exitCode !== 0) {
    throw new Error(`Failed to convert agents: ${converterResult.stderr}`);
  }

  // Extract JSON output
  const convertedJsonMatch = converterResult.stdout.match(/---JSON---\n([\s\S]+)$/);
  if (!convertedJsonMatch) {
    throw new Error('No converted agents found');
  }

  const convertedAgents = JSON.parse(convertedJsonMatch[1]);
  console.log(`✅ Converted ${convertedAgents.length} agent(s)`);

  // Step 3: Create agents (or show in dry-run)
  console.log('\n📝 Step 3: Creating agents...');

  const results = {
    imported: 0,
    failed: 0,
    agents: [] as any[],
    errors: [] as string[]
  };

  for (const agent of convertedAgents) {
    if (options.reportsTo) {
      agent.reportsTo = options.reportsTo;
    }

    if (options.dryRun) {
      console.log(`  [DRY-RUN] Would create: ${agent.name} (${agent.role})`);
      results.agents.push(agent);
      results.imported++;
      continue;
    }

    try {
      // Create agent via Paperclip API
      const createResult = await createAgentViaAPI(agent, options.companyId);

      if (createResult.success) {
        console.log(`  ✅ Created: ${agent.name}`);
        results.imported++;
        results.agents.push({ ...agent, id: createResult.id });
      } else {
        console.log(`  ❌ Failed: ${agent.name} - ${createResult.error}`);
        results.failed++;
        results.errors.push(`${agent.name}: ${createResult.error}`);
      }
    } catch (error: any) {
      console.log(`  ❌ Failed: ${agent.name} - ${error.message}`);
      results.failed++;
      results.errors.push(`${agent.name}: ${error.message}`);
    }
  }

  // Step 4: Log import to database
  if (!options.dryRun && options.companyId) {
    console.log('\n💾 Step 4: Logging import to database...');
    await logImportToDB({
      companyId: options.companyId,
      sourceUrl: repoUrl,
      agentsFound: externalAgents.length,
      agentsCreated: results.imported,
      agentsFailed: results.failed,
      details: {
        agents: results.agents.map((a: any) => a.name),
        errors: results.errors
      }
    });
    console.log('✅ Import logged');
  }

  // Step 5: Notify user
  console.log('\n📧 Step 5: Sending notification...');
  await sendNotification({
    imported: results.imported,
    failed: results.failed,
    total: externalAgents.length,
    errors: results.errors
  });

  // Cleanup
  try {
    unlinkSync(tempFile);
  } catch { /* ignore */ }

  return results;
}

async function createAgentViaAPI(agent: any, companyId?: string): Promise<{ success: boolean; id?: string; error?: string }> {
  const apiUrl = process.env.PAPERCLIP_API_URL || 'http://localhost:3100';

  try {
    const response = await fetch(`${apiUrl}/api/companies/${companyId}/agent-hires`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: agent.name,
        role: agent.role,
        title: agent.title,
        icon: agent.icon,
        reportsTo: agent.reportsTo,
        capabilities: agent.capabilities,
        desiredSkills: agent.desiredSkills,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
        instructionsBundle: agent.instructionsBundle
      })
    });

    if (response.ok) {
      const data = await response.json();
      return { success: true, id: data.id };
    } else {
      const error = await response.text();
      return { success: false, error: `API Error ${response.status}: ${error}` };
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function logImportToDB(logData: {
  companyId: string;
  sourceUrl: string;
  agentsFound: number;
  agentsCreated: number;
  agentsFailed: number;
  details: any;
}) {
  // In production, this would insert into the agent_imports table
  // For now, we log to console
  console.log('  Import log:', JSON.stringify(logData, null, 2));
}

async function sendNotification(results: {
  imported: number;
  failed: number;
  total: number;
  errors: string[];
}) {
  const message = `
🚀 Agent Import Complete!

✅ Imported: ${results.imported}
❌ Failed: ${results.failed}
📊 Total: ${results.total}

${results.errors.length > 0 ? '⚠️ Errors:\n' + results.errors.map(e => `- ${e}`).join('\n') : ''}
  `.trim();

  console.log('\n' + message);

  // In production, send to Telegram/Email
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (telegramBotToken && telegramChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: message
        })
      });
      console.log('📨 Telegram notification sent');
    } catch (error) {
      console.log('⚠️ Failed to send Telegram notification');
    }
  }
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx tsx scripts/import-agents.ts <github-repo-url> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --company-id <id>    Company ID for agent creation');
    console.log('  --github-token <tok> GitHub API token');
    console.log('  --reports-to <id>    Agent ID to report to');
    console.log('  --dry-run            Show what would be created without creating');
    console.log('');
    console.log('Example:');
    console.log('  npx tsx scripts/import-agents.ts https://github.com/msitarzewski/agency-agents --dry-run');
    process.exit(1);
  }

  const repoUrl = args[0];
  const options: any = {};

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--company-id':
        options.companyId = args[++i];
        break;
      case '--github-token':
        options.githubToken = args[++i];
        break;
      case '--reports-to':
        options.reportsTo = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
    }
  }

  try {
    const results = await importAgents(repoUrl, options);

    console.log('\n=== Final Results ===');
    console.log(`✅ Imported: ${results.imported}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`📊 Total: ${results.imported + results.failed}`);

    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error('\n❌ Import failed:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { importAgents };
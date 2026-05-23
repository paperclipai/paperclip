#!/usr/bin/env tsx
/**
 * Agent Format Converter
 * Converts external agent definitions to Paperclip/Levi native schema
 */

import { readFileSync } from 'fs';

interface ExternalAgent {
  source: string;
  sourceUrl: string;
  name: string;
  role: string;
  title?: string;
  description: string;
  capabilities?: string[];
  skills?: string[];
  adapterType?: string;
  icon?: string;
}

interface PaperclipAgent {
  name: string;
  role: string;
  title: string;
  icon: string;
  reportsTo: string | null;
  capabilities: string;
  desiredSkills: string[];
  adapterType: string;
  adapterConfig: Record<string, any>;
  instructionsBundle: {
    files: {
      'AGENTS.md': string;
    };
  };
}

interface ConversionResult {
  agent: PaperclipAgent;
  warnings: string[];
  errors: string[];
}

// Allowed icons in Paperclip
const ALLOWED_ICONS = [
  'bot', 'cpu', 'brain', 'zap', 'rocket', 'code', 'terminal', 'shield', 'eye', 'search',
  'wrench', 'hammer', 'lightbulb', 'sparkles', 'star', 'heart', 'flame', 'bug', 'cog',
  'database', 'globe', 'lock', 'mail', 'message-square', 'file-code', 'git-branch',
  'package', 'puzzle', 'target', 'wand', 'atom', 'circuit-board', 'radar', 'swords',
  'telescope', 'microscope', 'crown', 'gem', 'hexagon', 'pentagon', 'fingerprint'
];

// Supported adapter types
const SUPPORTED_ADAPTERS = ['process', 'openai', 'claude_local', 'codex_local'];

// Valid roles in Paperclip
const VALID_ROLES = [
  'ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer',
  'pm', 'qa', 'devops', 'researcher', 'general'
];

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function validateName(name: string, existingNames: string[]): { name: string; warnings: string[] } {
  const warnings: string[] = [];
  let validName = toKebabCase(name);

  if (!validName) {
    validName = 'unnamed-agent';
    warnings.push(`Invalid name "${name}", using "unnamed-agent"`);
  }

  if (validName.length > 50) {
    validName = validName.substring(0, 50);
    warnings.push(`Name truncated to 50 chars: "${validName}"`);
  }

  // Check for duplicates
  let finalName = validName;
  let counter = 2;
  while (existingNames.includes(finalName)) {
    finalName = `${validName}-${counter}`;
    counter++;
  }

  if (finalName !== validName) {
    warnings.push(`Name "${validName}" already exists, using "${finalName}"`);
  }

  return { name: finalName, warnings };
}

function validateRole(role: string, existingRoles: string[]): { role: string; warnings: string[] } {
  const warnings: string[] = [];
  let validRole = toKebabCase(role);

  if (!validRole) {
    validRole = 'general';
    warnings.push(`Invalid role "${role}", using "general"`);
  }

  // Check for duplicates
  let finalRole = validRole;
  let counter = 2;
  while (existingRoles.includes(finalRole)) {
    finalRole = `${validRole}-${counter}`;
    counter++;
  }

  if (finalRole !== validRole) {
    warnings.push(`Role "${validRole}" already exists, using "${finalRole}"`);
  }

  return { role: finalRole, warnings };
}

function mapIcon(icon: string | undefined): { icon: string; warning?: string } {
  if (!icon) {
    return { icon: 'user' };
  }

  const normalized = icon.toLowerCase().replace(/[^a-z]/g, '');

  // Direct match
  if (ALLOWED_ICONS.includes(normalized)) {
    return { icon: normalized };
  }

  // Common mappings
  const iconMap: Record<string, string> = {
    'megaphone': 'megaphone', 'speaker': 'megaphone', 'announce': 'megaphone',
    'code': 'code', 'developer': 'code', 'programmer': 'code', 'coding': 'code',
    'shield': 'shield', 'protect': 'shield', 'guard': 'shield',
    'chart': 'chart', 'graph': 'chart', 'analytics': 'chart', 'data': 'chart',
    'pen': 'pen', 'write': 'pen', 'writer': 'pen', 'content': 'pen',
    'users': 'users', 'team': 'users', 'group': 'users', 'people': 'users',
    'dollar': 'dollar', 'money': 'dollar', 'finance': 'dollar', 'cash': 'dollar',
    'globe': 'globe', 'world': 'globe', 'international': 'globe',
    'crown': 'crown', 'king': 'crown', 'executive': 'crown', 'ceo': 'crown',
    'cpu': 'cpu', 'tech': 'cpu', 'technology': 'cpu', 'computer': 'cpu',
    'briefcase': 'briefcase', 'business': 'briefcase', 'work': 'briefcase',
    'gear': 'gear', 'settings': 'gear', 'config': 'gear',
    'star': 'star', 'favorite': 'star', 'best': 'star',
    'heart': 'heart', 'love': 'heart', 'like': 'heart',
    'zap': 'zap', 'bolt': 'zap', 'fast': 'zap', 'speed': 'zap',
    'eye': 'eye', 'view': 'eye', 'watch': 'eye',
    'mail': 'mail', 'email': 'mail', 'message': 'mail',
    'file': 'file', 'document': 'file', 'paper': 'file',
    'folder': 'folder', 'directory': 'folder',
    'calendar': 'calendar', 'date': 'calendar', 'schedule': 'calendar',
    'clock': 'clock', 'time': 'clock', 'timer': 'clock',
    'search': 'search', 'find': 'search', 'lookup': 'search',
    'check': 'check', 'done': 'check', 'complete': 'check',
    'x': 'x', 'close': 'x', 'remove': 'x',
    'plus': 'plus', 'add': 'plus', 'create': 'plus',
    'minus': 'minus', 'delete': 'minus', 'subtract': 'minus',
    'arrow': 'arrow', 'navigate': 'arrow', 'move': 'arrow',
    'menu': 'menu', 'list': 'menu', 'hamburger': 'menu'
  };

  if (iconMap[normalized]) {
    return { icon: iconMap[normalized] };
  }

  return {
    icon: 'user',
    warning: `Icon "${icon}" not recognized, using "user"`
  };
}

function mapAdapter(adapterType: string | undefined): { adapterType: string; warning?: string } {
  if (!adapterType) {
    return { adapterType: 'process' };
  }

  const normalized = adapterType.toLowerCase();

  if (SUPPORTED_ADAPTERS.includes(normalized)) {
    return { adapterType: normalized };
  }

  // Mappings
  const adapterMap: Record<string, string> = {
    'openai': 'openai',
    'gpt': 'openai',
    'claude': 'claude_local',
    'anthropic': 'claude_local',
    'codex': 'codex_local',
    'local': 'process',
    'default': 'process',
    'standard': 'process'
  };

  if (adapterMap[normalized]) {
    return { adapterType: adapterMap[normalized] };
  }

  return {
    adapterType: 'process',
    warning: `Adapter "${adapterType}" not supported, using "process"`
  };
}

function buildCapabilities(capabilities: string[] | undefined, description: string): string {
  if (capabilities && capabilities.length > 0) {
    return capabilities.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ');
  }

  if (description) {
    // Use first sentence of description
    const firstSentence = description.split(/[.!?]/)[0];
    if (firstSentence && firstSentence.length > 10) {
      return firstSentence;
    }
  }

  return 'General purpose agent';
}

function buildDesiredSkills(skills: string[] | undefined): string[] {
  if (!skills || skills.length === 0) {
    return [];
  }

  return skills.map(skill => {
    return toKebabCase(skill);
  }).filter(Boolean);
}

function buildInstructions(title: string, role: string, capabilities: string): string {
  const capList = capabilities.split(',').map(c => c.trim()).filter(Boolean);

  return `# ${title}

## Role
${title} specializing in ${capabilities}.

## Responsibilities
${capList.map(c => `- ${c}`).join('\n')}

## Context
You are part of a team of AI agents working together on projects.
Report to your manager and collaborate with other agents.
Follow company guidelines and respect budget constraints.

## Execution Contract
- Start actionable work immediately
- Do not stop at planning unless requested
- Leave durable progress with clear next actions
- Use child issues for long or parallel work
- Mark blocked work with owner and action
- Respect approval gates and company boundaries

## Boundaries
- Do not access production systems without approval
- Do not share confidential information
- Escalate issues you cannot resolve
`;
}

function convertAgent(
  external: ExternalAgent,
  existingNames: string[],
  existingRoles: string[]
): ConversionResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Validate required fields
  if (!external.name) {
    errors.push('Agent name is required');
  }

  if (!external.description) {
    errors.push('Agent description is required');
  }

  if (errors.length > 0) {
    return {
      agent: null as any,
      warnings,
      errors
    };
  }

  // Convert name
  const nameResult = validateName(external.name, existingNames);
  warnings.push(...nameResult.warnings);

  // Convert role
  const roleResult = validateRole(external.role || external.name, existingRoles);
  warnings.push(...roleResult.warnings);

  // Convert title
  const title = external.title || external.name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  // Convert icon
  const iconResult = mapIcon(external.icon);
  if (iconResult.warning) {
    warnings.push(iconResult.warning);
  }

  // Convert adapter
  const adapterResult = mapAdapter(external.adapterType);
  if (adapterResult.warning) {
    warnings.push(adapterResult.warning);
  }

  // Build capabilities string
  const capabilities = buildCapabilities(external.capabilities, external.description);

  // Build desired skills
  const desiredSkills = buildDesiredSkills(external.skills);

  // Build instructions
  const instructions = buildInstructions(title, roleResult.role, capabilities);

  const paperclipAgent: PaperclipAgent = {
    name: nameResult.name,
    role: roleResult.role,
    title: title,
    icon: iconResult.icon,
    reportsTo: null, // User can set this later
    capabilities: capabilities,
    desiredSkills: desiredSkills,
    adapterType: adapterResult.adapterType,
    adapterConfig: {},
    instructionsBundle: {
      files: {
        'AGENTS.md': instructions
      }
    }
  };

  return {
    agent: paperclipAgent,
    warnings,
    errors
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/agent-format-converter.ts <json-file>');
    console.error('   or: cat agents.json | npx tsx scripts/agent-format-converter.ts');
    process.exit(1);
  }

  let inputData: string;

  if (args[0] === '-') {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    inputData = Buffer.concat(chunks).toString('utf-8');
  } else {
    // Read from file
    inputData = readFileSync(args[0], 'utf-8');
  }

  try {
    const externalAgents: ExternalAgent[] = JSON.parse(inputData);

    if (!Array.isArray(externalAgents)) {
      console.error('Input must be an array of agent definitions');
      process.exit(1);
    }

    const existingNames: string[] = [];
    const existingRoles: string[] = [];
    const results: ConversionResult[] = [];

    console.log(`Converting ${externalAgents.length} agent(s)...\n`);

    for (const external of externalAgents) {
      const result = convertAgent(external, existingNames, existingRoles);
      results.push(result);

      if (result.errors.length === 0) {
        existingNames.push(result.agent.name);
        existingRoles.push(result.agent.role);
      }
    }

    // Summary
    const successful = results.filter(r => r.errors.length === 0);
    const failed = results.filter(r => r.errors.length > 0);

    console.log(`\n=== Summary ===`);
    console.log(`Total: ${results.length}`);
    console.log(`Success: ${successful.length}`);
    console.log(`Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.log(`\n=== Failed ===`);
      for (const result of failed) {
        console.log(`- Errors: ${result.errors.join(', ')}`);
      }
    }

    if (successful.length > 0) {
      console.log(`\n=== Converted Agents ===`);
      for (const result of successful) {
        console.log(`- ${result.agent.name} (${result.agent.role})`);
        if (result.warnings.length > 0) {
          console.log(`  Warnings: ${result.warnings.join(', ')}`);
        }
      }
    }

    // Output converted agents as JSON
    console.log('\n---JSON---');
    console.log(JSON.stringify(successful.map(r => r.agent), null, 2));

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { convertAgent, validateName, validateRole, mapIcon, mapAdapter };
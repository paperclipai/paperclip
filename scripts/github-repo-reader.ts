#!/usr/bin/env tsx
/**
 * GitHub Repo Reader
 * Fetches agent definitions from public GitHub repositories
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

interface AgentDefinition {
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

async function fetchGitHubRepo(owner: string, repo: string, githubToken?: string): Promise<AgentDefinition[]> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Paperclip-Agent-Importer'
  };

  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  // Fetch README
  const readmeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/readme`,
    { headers }
  );

  if (!readmeResponse.ok) {
    throw new Error(`Failed to fetch README: ${readmeResponse.status} ${readmeResponse.statusText}`);
  }

  const readmeData = await readmeResponse.json();
  const readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf-8');

  // Parse agent definitions from README
  const agents = parseReadmeAgents(readmeContent, owner, repo);

  // If no agents found in README, try agents.json or agents.yaml
  if (agents.length === 0) {
    const jsonAgents = await fetchJsonAgents(owner, repo, headers);
    if (jsonAgents.length > 0) return jsonAgents;

    const yamlAgents = await fetchYamlAgents(owner, repo, headers);
    if (yamlAgents.length > 0) return yamlAgents;
  }

  return agents;
}

function parseReadmeAgents(content: string, owner: string, repo: string): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  // Look for agent sections (## Agent Name or ### Agent Name)
  const agentRegex = /^#{2,3}\s+(.+?)(?:\n|$)/gm;
  const sections: { title: string; content: string }[] = [];

  let match;
  let lastIndex = 0;
  while ((match = agentRegex.exec(content)) !== null) {
    if (lastIndex > 0) {
      sections[sections.length - 1].content = content.slice(lastIndex, match.index);
    }
    sections.push({ title: match[1].trim(), content: '' });
    lastIndex = match.index + match[0].length;
  }

  if (sections.length > 0 && lastIndex > 0) {
    sections[sections.length - 1].content = content.slice(lastIndex);
  }

  for (const section of sections) {
    // Skip non-agent sections (common README headers)
    const skipWords = ['introduction', 'overview', 'installation', 'usage', 'contributing', 'license', 'table of contents'];
    if (skipWords.some(w => section.title.toLowerCase().includes(w))) {
      continue;
    }

    const agent = parseAgentSection(section.title, section.content, owner, repo);
    if (agent) {
      agents.push(agent);
    }
  }

  return agents;
}

function parseAgentSection(title: string, content: string, owner: string, repo: string): AgentDefinition | null {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  let role = '';
  let description = '';
  const capabilities: string[] = [];
  const skills: string[] = [];

  for (const line of lines) {
    // Parse role
    const roleMatch = line.match(/(?:\*\*)?Role(?:\*\*)?\s*:?\s*(.+)/i);
    if (roleMatch) {
      role = roleMatch[1].trim();
      continue;
    }

    // Parse description
    const descMatch = line.match(/(?:\*\*)?Description(?:\*\*)?\s*:?\s*(.+)/i);
    if (descMatch) {
      description = descMatch[1].trim();
      continue;
    }

    // Parse capabilities (bullet points)
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const cap = line.replace(/^[-*]\s+/, '').trim();
      if (cap && !cap.toLowerCase().includes('skill')) {
        capabilities.push(cap);
      } else if (cap) {
        skills.push(cap);
      }
    }
  }

  // If no explicit description, use first non-empty line
  if (!description && lines.length > 0) {
    description = lines[0];
  }

  // Derive role from title if not found
  if (!role) {
    role = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  // Skip if no meaningful data
  if (!description && capabilities.length === 0) {
    return null;
  }

  return {
    source: 'github',
    sourceUrl: `https://github.com/${owner}/${repo}`,
    name: title.replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, ''),
    role: role.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    title: title,
    description: description || `${title} agent`,
    capabilities: capabilities.length > 0 ? capabilities : [description],
    skills: skills,
    adapterType: 'process',
    icon: deriveIcon(title)
  };
}

async function fetchJsonAgents(owner: string, repo: string, headers: Record<string, string>): Promise<AgentDefinition[]> {
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/agents.json`,
      { headers }
    );
    if (!response.ok) return [];

    const data = await response.json();
    return parseStructuredAgents(data, owner, repo);
  } catch {
    return [];
  }
}

async function fetchYamlAgents(owner: string, repo: string, headers: Record<string, string>): Promise<AgentDefinition[]> {
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/agents.yaml`,
      { headers }
    );
    if (!response.ok) return [];

    const yaml = await response.text();
    // Simple YAML parsing (for production, use a YAML library)
    const lines = yaml.split('\n');
    const agents: AgentDefinition[] = [];
    let currentAgent: Partial<AgentDefinition> = {};

    for (const line of lines) {
      const nameMatch = line.match(/^\s*-\s*name:\s*(.+)/);
      if (nameMatch) {
        if (currentAgent.name) {
          agents.push(currentAgent as AgentDefinition);
        }
        currentAgent = {
          source: 'github',
          sourceUrl: `https://github.com/${owner}/${repo}`,
          name: nameMatch[1].trim(),
          adapterType: 'process'
        };
      }

      const roleMatch = line.match(/^\s*role:\s*(.+)/);
      if (roleMatch) currentAgent.role = roleMatch[1].trim();

      const descMatch = line.match(/^\s*description:\s*(.+)/);
      if (descMatch) currentAgent.description = descMatch[1].trim();
    }

    if (currentAgent.name) {
      agents.push(currentAgent as AgentDefinition);
    }

    return agents;
  } catch {
    return [];
  }
}

function parseStructuredAgents(data: any, owner: string, repo: string): AgentDefinition[] {
  if (!Array.isArray(data)) return [];

  return data.map((agent: any) => ({
    source: 'github',
    sourceUrl: `https://github.com/${owner}/${repo}`,
    name: agent.name || 'unnamed-agent',
    role: agent.role || agent.name?.toLowerCase().replace(/\s+/g, '-') || 'general',
    title: agent.title || agent.name,
    description: agent.description || agent.capabilities?.join(', ') || '',
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
    skills: Array.isArray(agent.skills) ? agent.skills : [],
    adapterType: agent.adapterType || 'process',
    icon: agent.icon || deriveIcon(agent.name || '')
  }));
}

function deriveIcon(name: string): string {
  const iconMap: Record<string, string> = {
    'market': 'megaphone',
    'sale': 'megaphone',
    'support': 'headphones',
    'help': 'headphones',
    'code': 'code',
    'dev': 'code',
    'engineer': 'code',
    'security': 'shield',
    'analyst': 'chart',
    'data': 'chart',
    'writer': 'pen',
    'content': 'pen',
    'hr': 'users',
    'people': 'users',
    'finance': 'dollar',
    'money': 'dollar',
    'global': 'globe',
    'international': 'globe',
    'ceo': 'crown',
    'cto': 'crown',
    'chief': 'crown',
    'tech': 'cpu',
    'research': 'cpu'
  };

  const lowerName = name.toLowerCase();
  for (const [key, icon] of Object.entries(iconMap)) {
    if (lowerName.includes(key)) return icon;
  }

  return 'user';
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/github-repo-reader.ts <owner/repo> [github-token]');
    process.exit(1);
  }

  const [repoPath, token] = args;
  const [owner, repo] = repoPath.split('/');

  if (!owner || !repo) {
    console.error('Invalid repo format. Use: owner/repo');
    process.exit(1);
  }

  console.log(`Fetching agents from https://github.com/${owner}/${repo}...`);

  try {
    const agents = await fetchGitHubRepo(owner, repo, token);

    console.log(`\nFound ${agents.length} agent(s):\n`);

    for (const agent of agents) {
      console.log(`- ${agent.name}`);
      console.log(`  Role: ${agent.role}`);
      console.log(`  Description: ${agent.description}`);
      console.log(`  Capabilities: ${agent.capabilities?.join(', ') || 'N/A'}`);
      console.log(`  Icon: ${agent.icon}`);
      console.log();
    }

    // Output as JSON for piping
    console.log('---JSON---');
    console.log(JSON.stringify(agents, null, 2));

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { fetchGitHubRepo, parseReadmeAgents, deriveIcon };
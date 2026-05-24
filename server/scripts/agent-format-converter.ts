import * as fs from 'fs';

const VALID_ADAPTERS = ['process', 'slack', 'email', 'claude_local', 'claude_api', 'openai_api', 'openai_local'];
const VALID_CONTEXT_MODES = ['disabled', 'messages', 'full', 'channel', 'thread'];
const VALID_STATUSES = ['idle', 'working', 'complete', 'error', 'paused'];

const VALID_ROLES = ['ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer', 'pm', 'qa', 'devops', 'researcher', 'general'];

function mapRole(externalRole: string): string {
  const roleMap: Record<string, string> = {
    'frontend developer': 'engineer',
    'backend architect': 'engineer',
    'mobile app builder': 'engineer',
    'ai engineer': 'engineer',
    'devops automator': 'devops',
    'rapid prototyper': 'engineer',
    'senior developer': 'engineer',
    'filament optimization specialist': 'engineer',
    'security engineer': 'security',
    'autonomous optimization architect': 'engineer',
    'embedded firmware engineer': 'engineer',
    'incident response commander': 'devops',
    'solidity smart contract engineer': 'engineer',
    'codebase onboarding engineer': 'engineer',
    'technical writer': 'general',
    'threat detection engineer': 'security',
    'wechat mini program developer': 'engineer',
    'code reviewer': 'engineer',
    'database optimizer': 'engineer',
    'git workflow master': 'engineer',
    'software architect': 'engineer',
    'sre': 'devops',
    'ai data remediation engineer': 'engineer',
    'data engineer': 'engineer',
    'feishu integration developer': 'engineer',
    'cms developer': 'engineer',
    'email intelligence engineer': 'engineer',
    'voice ai integration engineer': 'engineer',
  };
  
  const normalizedRole = externalRole.toLowerCase().trim();
  return roleMap[normalizedRole] || 'general';
}

function convertAgent(externalAgent: any) {
  const adapterType = VALID_ADAPTERS.includes(externalAgent.adapter_type)
    ? externalAgent.adapter_type : 'process';
  
  const contextMode = VALID_CONTEXT_MODES.includes(externalAgent.context_mode)
    ? externalAgent.context_mode : 'messages';
  
  const status = VALID_STATUSES.includes(externalAgent.status)
    ? externalAgent.status : 'idle';
  
  const mappedRole = mapRole(externalAgent.role);
  
  return {
    name: externalAgent.name,
    role: mappedRole,
    title: externalAgent.title || `${externalAgent.role} Agent`,
    description: externalAgent.description || externalAgent.file_content?.substring(0, 500) || 'Auto-imported from GitHub',
    status: status,
    adapter_type: adapterType,
    adapter_config: externalAgent.adapter_config || {},
    context_mode: contextMode,
    source_url: externalAgent.source_url,
    source_repo: externalAgent.source_repo,
  };
}

const inputPath = process.argv[2] || '/tmp/agents.json';
const outputPath = process.argv[3] || '/tmp/converted.json';

const sourceData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const converted = sourceData.agents.map(convertAgent);

const result = {
  repo: sourceData.repo,
  total: converted.length,
  agents: converted
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
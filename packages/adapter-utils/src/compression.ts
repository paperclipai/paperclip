export interface CompressionResult {
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  reductionPercent: number;
}

// Main compression function — applies multiple techniques
export function compressPrompt(input: string): CompressionResult {
  const original = input;
  let compressed = input;

  // 1. Remove articles (a, an, the)
  compressed = compressed.replace(/\b(a|an|the)\b/gi, '');

  // 2. Remove conversational filler
  compressed = compressed.replace(/\b(I'd be happy to|Sure!|Let me help|I'd be glad to|Certainly|Of course|Absolutely)\b/gi, '');

  // 3. Remove transition phrases
  compressed = compressed.replace(/\b(Furthermore|Additionally|In other words|Moreover|However|Therefore|Thus|Hence|Consequently)\b/gi, '');

  // 4. Use symbols instead of words
  compressed = compressed.replace(/\bleads to\b/gi, '→');
  compressed = compressed.replace(/\bresults in\b/gi, '→');
  compressed = compressed.replace(/\bcauses\b/gi, '→');
  compressed = compressed.replace(/\bdue to\b/gi, '→');
  compressed = compressed.replace(/\bbecause of\b/gi, '→');

  // 5. Use abbreviations
  compressed = compressed.replace(/\btechnology\b/gi, 'tech');
  compressed = compressed.replace(/\bimplementation\b/gi, 'impl');
  compressed = compressed.replace(/\bconfiguration\b/gi, 'config');
  compressed = compressed.replace(/\benvironment\b/gi, 'env');
  compressed = compressed.replace(/\bdevelopment\b/gi, 'dev');
  compressed = compressed.replace(/\bproduction\b/gi, 'prod');

  // 6. Remove explanatory clauses (basic)
  compressed = compressed.replace(/\bwhich means\b/gi, '');
  compressed = compressed.replace(/\bthat means\b/gi, '');
  compressed = compressed.replace(/\bthis means\b/gi, '');

  // 7. Clean up extra spaces
  compressed = compressed.replace(/\s+/g, ' ').trim();

  const originalTokens = Math.ceil(original.length / 4); // Rough token estimation
  const compressedTokens = Math.ceil(compressed.length / 4);
  const reductionPercent = originalTokens > 0 ? ((originalTokens - compressedTokens) / originalTokens) * 100 : 0;

  return {
    original,
    compressed,
    originalTokens,
    compressedTokens,
    reductionPercent,
  };
}

export function compressInstructions(fullInstructions: string): string {
  // Extract only task-critical parts from agent instructions file
  // Remove philosophy, background, unnecessary detail
  // Keep: hard constraints, required outputs, critical decision points
  // Expected reduction: 50-70%

  let compressed = fullInstructions;

  // Remove sections that are not task-critical
  compressed = compressed.replace(/You are an AI assistant[\s\S]*?You should:/gi, 'Agent:');
  compressed = compressed.replace(/Your role is to[\s\S]*?When working on tasks:/gi, 'Task focus:');
  compressed = compressed.replace(/Remember to[\s\S]*?Always/gi, '');

  // Keep only essential constraints
  const lines = compressed.split('\n');
  const essentialLines = lines.filter(line =>
    line.includes('must') ||
    line.includes('required') ||
    line.includes('critical') ||
    line.includes('never') ||
    line.includes('always') ||
    line.includes('Task:') ||
    line.includes('Goal:')
  );

  return essentialLines.join('\n');
}

export function compressWakeContext(wakePayload: unknown): string {
  // Current: Full comment bodies + execution stage details + decision history
  // New: Summary line per comment + only actionable execution stage info
  // Format:
  //   Comment #1: <1-line summary of what changed>
  //   Execution: <current role> → <next action needed>
  // Expected reduction: 70-80%

  if (!wakePayload || typeof wakePayload !== 'object') {
    return '';
  }

  const payload = wakePayload as Record<string, unknown>;
  const comments = payload.comments as unknown[];
  const execution = payload.execution as Record<string, unknown>;

  let result = '';

  if (comments && Array.isArray(comments)) {
    comments.forEach((comment, i) => {
      if (typeof comment === 'object' && comment !== null) {
        const c = comment as Record<string, unknown>;
        const body = String(c.body || '');
        // Create 1-line summary
        const summary = body.split('\n')[0]?.substring(0, 100) || 'Updated';
        result += `Comment #${i + 1}: ${summary}\n`;
      }
    });
  }

  if (execution) {
    const currentRole = String(execution.currentRole || 'unknown');
    const nextAction = String(execution.nextAction || 'continue');
    result += `Execution: ${currentRole} → ${nextAction}`;
  }

  return result;
}

export function compressBootstrapPrompt(template: string): string {
  // Remove: "You are agent X with these capabilities"
  // Keep: "Agent X. Task: [task]. Workspace: [path]."
  // Expected reduction: 80-90%

  let compressed = template;

  // Remove capability descriptions
  compressed = compressed.replace(/You are[\s\S]*?capabilities:/gi, '');
  compressed = compressed.replace(/Your capabilities include[\s\S]*?You can:/gi, '');

  // Extract agent name and task
  const agentMatch = template.match(/agent\s+([^\s.]+)/i);
  const taskMatch = template.match(/Task:\s*([^\n]+)/i);
  const workspaceMatch = template.match(/Workspace:\s*([^\n]+)/i);

  const agent = agentMatch ? agentMatch[1] : 'Agent';
  const task = taskMatch ? taskMatch[1] : 'Unknown task';
  const workspace = workspaceMatch ? workspaceMatch[1] : 'Unknown workspace';

  return `Agent: ${agent}. Task: ${task}. Workspace: ${workspace}.`;
}

export function compressEnvironmentNotes(env: Record<string, string>): string {
  // Current: Lists all PAPERCLIP_* vars with descriptions
  // New: Only list vars that are actually used by skills/tools
  // If unused: remove entirely
  // Expected reduction: 90% (most sessions have unused vars)

  const usedVars = [
    'PAPERCLIP_WORKSPACE_ID',
    'PAPERCLIP_RUNTIME_ID',
    'PAPERCLIP_AGENT_ID',
    'PAPERCLIP_TASK_KEY',
  ];

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (usedVars.includes(key)) {
      filtered[key] = value;
    }
  }

  if (Object.keys(filtered).length === 0) {
    return '';
  }

  return Object.entries(filtered)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

export function compressApiNotes(): string {
  // Current: Full curl examples showing GET, POST, PATCH patterns
  // New: Link to external doc, zero inline examples
  // Instead of 1KB of examples, use 100 chars: "API examples: github.com/paperclip/api-examples"
  // Expected reduction: 95%

  return 'API docs: github.com/paperclipai/paperclip/docs/api';
}
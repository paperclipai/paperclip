# Hermes Agent Integration

Integrate Paperclip with Hermes Agent for advanced multi-agent orchestration, semantic memory, and browser automation.

## Overview

Paperclip's Hermes integration provides three powerful plugins that work together:

| Plugin | Purpose | Key Capabilities |
|--------|---------|------------------|
| `@paperclipai/plugin-playwright-mcp` | Browser automation | Navigate, click, fill, screenshot, extract data |
| `@paperclipai/plugin-ruflo-bridge` | Multi-agent orchestration | Spawn agents, swarm coordination, semantic memory, workflows |
| `@paperclipai/plugin-skills-hub` | Skills marketplace | Browse, install, and manage 50+ pre-built skills |

## Installation

```bash
# Install all three plugins
pnpm add @paperclipai/plugin-playwright-mcp @paperclipai/plugin-ruflo-bridge @paperclipai/plugin-skills-hub

# Enable in your Paperclip server config
# config.yaml or .env
PAPERCLIP_PLUGINS=playwright-mcp,ruflo-bridge,skills-hub
```

## Quickstart: Browser + Multi-Agent Workflow

Combine browser automation with multi-agent research:

```typescript
import { paperclip } from '@paperclipai/sdk';

const company = await paperclip.company.create({
  name: 'Market Research Team',
  agents: [
    {
      name: 'Researcher',
      type: 'hermes',
      skills: ['last30days', 'domain-intel', 'autonomous-continuous-research']
    },
    {
      name: 'Browser Operator',
      type: 'hermes',
      tools: ['playwright-mcp']
    },
    {
      name: 'Coordinator',
      type: 'hermes',
      tools: ['ruflo-bridge']
    }
  ]
});

// Task: Research competitors and capture screenshots
await company.tasks.create({
  title: 'Competitive Analysis: AI Note-Taking Apps',
  description: `
    1. Use browser automation to visit top 5 AI note-taking app websites
    2. Capture full-page screenshots of pricing pages
    3. Extract feature lists and pricing tiers
    4. Store findings in semantic memory for future reference
    5. Generate comparison report
  `,
  assignee: 'Coordinator'
});
```

## Plugin: Playwright MCP

Full browser automation for Paperclip agents.

### Example: Visual Verification Workflow

```typescript
// Agent skill: browser-verification.ts
import { browser_navigate, browser_screenshot, browser_extract } from '@paperclipai/plugin-playwright-mcp';

export async function verifyProductionDeploy(url: string) {
  // Navigate and wait for network idle
  await browser_navigate({ url, waitUntil: 'networkidle' });
  
  // Capture full-page screenshot
  const screenshot = await browser_screenshot({ fullPage: true });
  
  // Extract key metrics
  const metrics = await browser_extract({
    selectors: {
      title: 'h1',
      status: '[data-testid="status"]',
      version: '[data-testid="version"]'
    }
  });
  
  return { screenshot, metrics };
}
```

### Tools Reference

| Tool | Description | Example |
|------|-------------|---------|
| `browser_navigate` | Navigate to URL with wait condition | `{ url: "https://...", waitUntil: "networkidle" }` |
| `browser_click` | Click elements | `{ selector: "button.submit", count: 1 }` |
| `browser_fill` | Fill form fields | `{ selector: "#email", value: "test@example.com" }` |
| `browser_screenshot` | Capture screenshots | `{ fullPage: true, format: "webp", quality: 90 }` |
| `browser_extract` | Extract structured data | `{ selectors: { name: ".title", price: ".price" } }` |
| `browser_evaluate` | Execute JavaScript | `{ script: "document.title" }` |
| `browser_wait_for` | Wait for element state | `{ selector: ".loaded", state: "visible" }` |

## Plugin: Ruflo Bridge

Multi-agent orchestration with semantic memory.

### Example: Parallel Research Swarm

```typescript
import { agent_spawn, swarm_init, memory_store, memory_search } from '@paperclipai/plugin-ruflo-bridge';

// Initialize a research swarm
const swarm = await swarm_init({
  topology: 'hierarchical-mesh',
  maxAgents: 12,
  strategy: 'adaptive'
});

// Spawn specialized researchers
const agents = await Promise.all([
  agent_spawn({
    agentType: 'specialist',
    task: 'Research crypto staking automation opportunities',
    domain: 'crypto',
    model: 'opus'
  }),
  agent_spawn({
    agentType: 'specialist',
    task: 'Research DeFi lending automation opportunities',
    domain: 'defi',
    model: 'opus'
  }),
  agent_spawn({
    agentType: 'specialist',
    task: 'Research airdrop farming automation opportunities',
    domain: 'airdrops',
    model: 'opus'
  })
]);

// Store findings in semantic memory
await memory_store({
  key: 'research:automation:opportunities:2026-03',
  value: {
    categories: ['staking', 'lending', 'airdrops'],
    totalOpportunities: 47,
    avgROI: '84%',
    topPick: 'liquid-staking-auto'
  },
  namespace: 'paperclip',
  tags: ['automation', 'crypto', 'research']
});

// Later: search memory semantically
const results = await memory_search({
  query: 'What crypto automation opportunities have highest ROI?',
  namespace: 'paperclip',
  limit: 5
});
```

### Tools Reference

| Tool | Description | Example |
|------|-------------|---------|
| `agent_spawn` | Spawn specialized agent | `{ agentType: "specialist", task: "...", model: "opus" }` |
| `swarm_init` | Initialize agent swarm | `{ topology: "hierarchical-mesh", maxAgents: 50 }` |
| `memory_store` | Store with vector embeddings | `{ key: "...", value: {...}, tags: [...] }` |
| `memory_search` | Semantic vector search | `{ query: "...", namespace: "...", limit: 5 }` |
| `workflow_create` | Create structured workflow | `{ name: "...", steps: [...] }` |
| `workflow_execute` | Execute workflow | `{ workflowId: "...", variables: {...} }` |

## Plugin: Skills Hub

Access 50+ pre-built Hermes Agent skills.

### Example: Production Deploy Workflow

```typescript
import { skills_list, skills_install } from '@paperclipai/plugin-skills-hub';

// Browse available skills
const devopsSkills = await skills_list({ category: 'devops' });
// Returns: ['production-health-audit', 'github-actions-deploy-astro', ...]

// Install a skill
await skills_install({
  name: 'production-health-audit',
  source: 'hermes-registry'
});

// Use in agent workflow
const workflow = await ruflo.workflow_create({
  name: 'Production Deploy',
  steps: [
    { name: 'audit', type: 'task', config: { skill: 'production-health-audit' } },
    { name: 'build', type: 'task', config: { skill: 'github-actions-deploy-astro' } },
    { name: 'validate', type: 'task', config: { skill: 'post-deploy-visual-validation' } }
  ]
});
```

### Popular Skills by Category

| Category | Skills |
|----------|--------|
| **devops** | `production-health-audit`, `github-actions-deploy-astro`, `cloudflare-dns-api`, `datadog-startup-monitoring` |
| **mlops** | `huggingface-hub`, `vllm`, `qdrant`, `trl-fine-tuning`, `unsloth` |
| **research** | `last30days`, `autonomous-continuous-research`, `domain-intel`, `multi-agent-automation-research` |
| **software-development** | `frontend-fullstack-sota`, `systematic-debugging`, `code-reviewer`, `test-driven-development` |
| **crypto-operations** | `godmode-crypto-hunter-deploy`, `real-faucet-automation-godmode`, `cold-wallet-godmode-deploy` |

## Complete Example: Autonomous Research Company

```typescript
import { paperclip } from '@paperclipai/sdk';
import { swarm_init, agent_spawn, memory_store } from '@paperclipai/plugin-ruflo-bridge';

// Create company with Hermes-powered agents
const company = await paperclip.company.create({
  name: 'Autonomous Research Labs',
  mission: 'Discover and validate passive income opportunities 24/7',
  agents: [
    {
      name: 'Chief Research Officer',
      type: 'hermes',
      role: 'coordinator',
      tools: ['ruflo-bridge', 'skills-hub'],
      skills: ['autonomous-continuous-research', 'skill-router']
    },
    {
      name: 'Browser Researcher',
      type: 'hermes',
      role: 'specialist',
      tools: ['playwright-mcp'],
      skills: ['last30days', 'domain-intel']
    },
    {
      name: 'Data Analyst',
      type: 'hermes',
      role: 'analyst',
      tools: ['ruflo-bridge'],
      skills: ['autonomous-continuous-research']
    }
  ]
});

// Initialize research swarm (12 agents)
const swarm = await swarm_init({
  topology: 'hierarchical-mesh',
  maxAgents: 12,
  strategy: 'adaptive'
});

// Spawn category specialists
const categories = [
  'staking-auto', 'lending-auto', 'airdrops-auto',
  'testnet-auto', 'liquidity-auto', 'yield-auto',
  'node-auto', 'P2E-auto', 'content-auto'
];

await Promise.all(
  categories.map(cat =>
    agent_spawn({
      agentType: 'specialist',
      task: `Research full automation opportunities for ${cat}`,
      domain: cat.split('-')[0],
      model: 'opus'
    })
  )
);

// Create ongoing research task
await company.tasks.create({
  title: 'Continuous Opportunity Discovery',
  description: 'Research and validate new passive income opportunities every 15 minutes',
  routine: '*/15 * * * *', // Every 15 minutes
  assignee: 'Chief Research Officer'
});

// Store research state
await memory_store({
  key: 'company:research-labs:state',
  value: {
    swarmId: swarm.id,
    categories: categories,
    lastRun: new Date().toISOString(),
    opportunitiesFound: 0
  },
  namespace: 'paperclip'
});
```

## Best Practices

### 1. Session Management

- Reuse browser sessions across multiple pages
- Close sessions explicitly when done
- Set reasonable timeouts (300s default)

### 2. Agent Granularity

- One agent per specialized task
- Use swarms for parallel research
- Coordinator agent for orchestration

### 3. Memory Organization

- Use namespaces per company/project
- Tag memories for filtering
- Store structured data (JSON) not raw text

### 4. Error Handling

```typescript
try {
  await browser_navigate({ url, waitUntil: 'networkidle' });
} catch (error) {
  // Log error and notify human
  await company.notifications.create({
    type: 'error',
    message: `Browser automation failed: ${error.message}`,
    assignee: 'human-supervisor'
  });
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Browser session timeout | Increase timeout in config, reuse sessions |
| Agent spawning fails | Check Ruflo server is running, verify API keys |
| Skills not found | Run `skills_install` first, check `~/.hermes/skills/` |
| Memory search returns empty | Verify namespace matches, check tags |

## Next Steps

- [Playwright MCP Plugin](./playwright-mcp) — Full tool reference
- [Ruflo Bridge Plugin](./ruflo-bridge) — Orchestration patterns
- [Skills Hub Plugin](./skills-hub) — Skills catalog
- [Creating a Plugin](./creating-a-plugin) — Build your own

# Ruflo Bridge Plugin

Multi-agent orchestration, semantic memory, and workflow automation for Paperclip.

## Installation

```bash
pnpm add @paperclipai/plugin-ruflo-bridge
```

Enable in your Paperclip config:

```yaml
# config.yaml
plugins:
  - ruflo-bridge
```

Or via environment variable:

```bash
export PAPERCLIP_PLUGINS=ruflo-bridge
```

## Features

- **Agent Spawning** — Create specialized agents with intelligent model routing
- **Swarm Orchestration** — Initialize coordinated agent swarms (up to 300 agents)
- **Semantic Memory** — HNSW-indexed vector search for persistent knowledge
- **Workflow Automation** — Create and execute structured multi-step workflows
- **Coordination Primitives** — Consensus protocols, load balancing, synchronization

## Available Tools

| Tool | Description |
|------|-------------|
| `agent_spawn` | Spawn a new Ruflo agent with intelligent model selection |
| `swarm_init` | Initialize a coordinated swarm (hierarchical/mesh/hybrid topology) |
| `memory_store` | Store values with vector embeddings for semantic search |
| `memory_search` | HNSW-accelerated semantic vector search (150-12,500x faster) |
| `workflow_create` | Create structured workflows with task/condition/parallel/loop steps |
| `workflow_execute` | Execute workflows with runtime variable injection |
| `coordination_orchestrate` | Multi-agent coordination for complex tasks |
| `coordination_consensus` | BFT/Raft/Quorum consensus protocols |
| `coordination_sync` | State synchronization across nodes |

## Usage Examples

### Spawn a Specialist Agent

```typescript
// Spawn a security specialist agent
const agent = await agent_spawn({
  agentType: "specialist",
  task: "Review security implications of authentication flow",
  domain: "security",
  model: "opus" // haiku (fast), sonnet (balanced), opus (most capable)
});

console.log(`Spawned agent: ${agent.agentId}`);
```

### Initialize a Research Swarm

```typescript
// Initialize a swarm for parallel research
const swarm = await swarm_init({
  topology: "hierarchical-mesh",
  maxAgents: 50,
  strategy: "adaptive"
});

console.log(`Swarm initialized with ${swarm.agentCount} agents`);
```

### Store and Search Semantic Memory

```typescript
// Store semantic memory
await memory_store({
  key: "project:uniteia:architecture",
  value: {
    pattern: "multi-site",
    domains: ["especial.uniteia.com", "spain.uniteia.com"],
    deploy: "caddy+astro"
  },
  namespace: "paperclip",
  tags: ["architecture", "uniteia", "production"]
});

// Search memory semantically
const results = await memory_search({
  query: "How does Uniteia handle multiple sites?",
  namespace: "paperclip",
  limit: 5,
  threshold: 0.5 // minimum similarity score
});

console.log(results);
// [{ key: "project:uniteia:architecture", value: {...}, score: 0.92 }, ...]
```

### Create and Execute a Workflow

```typescript
// Create a deployment workflow
const workflow = await workflow_create({
  name: "Production Deploy",
  description: "Audit → Build → Deploy → Validate",
  steps: [
    { name: "audit", type: "task", config: { skill: "production-health-audit" } },
    { name: "build", type: "task", config: { skill: "github-actions-deploy-astro" } },
    { name: "validate", type: "task", config: { skill: "post-deploy-visual-validation" } }
  ]
});

// Execute the workflow
const result = await workflow_execute({
  workflowId: workflow.id,
  variables: {
    targetEnv: "production",
    branch: "main"
  }
});

console.log(`Workflow completed: ${result.status}`);
```

### Multi-Agent Coordination

```typescript
// Orchestrate a complex task across multiple agents
const coordination = await coordination_orchestrate({
  task: "Research and synthesize AI agent trends",
  agents: ["researcher-1", "analyst-1", "writer-1"],
  strategy: "pipeline", // parallel, sequential, pipeline, broadcast
  timeout: 300000 // 5 minutes
});
```

### Consensus Protocol

```typescript
// Propose a decision via consensus
const proposal = await coordination_consensus({
  action: "propose",
  proposal: {
    type: "architecture-decision",
    value: "Use Qdrant Cloud for semantic memory"
  },
  strategy: "raft", // bft, raft, quorum
  quorumPreset: "majority" // unanimous, majority, supermajority
});

// Vote on the proposal
await coordination_consensus({
  action: "vote",
  proposalId: proposal.id,
  vote: "accept",
  voterId: "agent-1"
});
```

## Agent Types

| Type | Use Case |
|------|----------|
| `worker` | General purpose task execution |
| `specialist` | Domain-specific expertise (security, devops, etc.) |
| `scout` | Research and discovery |
| `coordinator` | Orchestration and task distribution |
| `analyst` | Data analysis and synthesis |

## Swarm Topologies

| Topology | Description | Best For |
|----------|-------------|----------|
| `hierarchical` | Tree structure with clear reporting lines | Structured org charts |
| `mesh` | All agents can communicate directly | Collaborative research |
| `hierarchical-mesh` | Hybrid: hierarchy + peer communication | Most production use cases |
| `ring` | Sequential token passing | Pipeline workflows |
| `star` | Central coordinator, radial workers | Hub-and-spoke patterns |
| `adaptive` | Dynamically adjusts based on load | Variable workloads |

## Memory Tiers

Ruflo provides three memory tiers:

| Tier | Persistence | Use Case |
|------|-------------|----------|
| `working` | Session-only | Temporary task state |
| `episodic` | Cross-session | Recent conversation history |
| `semantic` | Permanent | Durable knowledge, patterns, policies |

### Example: Tiered Memory

```typescript
// Working memory (temporary)
await memory_store({
  key: "task:123:state",
  value: { progress: 50, currentStep: "build" },
  tier: "working"
});

// Episodic memory (session history)
await memory_store({
  key: "session:abc:summary",
  value: "Completed production deploy with 3 validations",
  tier: "episodic"
});

// Semantic memory (permanent knowledge)
await memory_store({
  key: "pattern:deploy:astro",
  value: {
    steps: ["audit", "build", "deploy", "validate"],
    tools: ["github-actions", "ssh", "playwright"]
  },
  tier: "semantic",
  tags: ["deploy", "astro", "production"]
});
```

## Advanced Patterns

### Parallel Research with Swarm

```typescript
// Initialize swarm for parallel research
const swarm = await swarm_init({
  topology: "mesh",
  maxAgents: 10,
  strategy: "adaptive"
});

// Spawn specialized researchers
const agents = [
  await agent_spawn({ agentType: "scout", task: "Research staking automation", domain: "crypto" }),
  await agent_spawn({ agentType: "scout", task: "Research lending automation", domain: "crypto" }),
  await agent_spawn({ agentType: "scout", task: "Research airdrop automation", domain: "crypto" })
];

// Coordinate synthesis
await coordination_orchestrate({
  task: "Synthesize research findings into report",
  agents: agents.map(a => a.agentId),
  strategy: "sequential"
});
```

### Workflow with Conditions

```typescript
const workflow = await workflow_create({
  name: "CI/CD Pipeline",
  steps: [
    { name: "checkout", type: "task", config: { cmd: "git pull" } },
    { name: "test", type: "task", config: { cmd: "pnpm test" } },
    {
      name: "deploy-check",
      type: "condition",
      config: {
        condition: "test.exitCode === 0",
        ifTrue: { name: "deploy", type: "task", config: { cmd: "pnpm deploy" } },
        ifFalse: { name: "notify-failure", type: "task", config: { cmd: "notify slack" } }
      }
    }
  ]
});
```

### Semantic Search with Filters

```typescript
// Search with tag filtering
const results = await memory_search({
  query: "production deployment patterns",
  namespace: "paperclip",
  tags: ["production", "deploy"], // AND logic
  limit: 10,
  threshold: 0.6
});
```

## Configuration

The plugin respects Ruflo's configuration hierarchy:

- `/root/.hermes/config.yaml` — User-level Ruflo settings
- Environment variables: `RUFLO_HOME`, `RUFLO_CONFIG_PATH`

### Key Configuration Options

```yaml
# ~/.hermes/config.yaml
swarm:
  maxAgents: 300  # Can exceed hard-coded 50 via workaround
embeddings:
  cacheSize: 8192
memory:
  maxEntries: 150000
  memory_char_limit: 50000
hive:
  workers: 7  # vCPU - 1
```

## Performance Tips

1. **Use semantic memory** — HNSW search is 150-12,500x faster than keyword search
2. **Batch agent spawning** — Spawn multiple agents in parallel when possible
3. **Choose right topology** — `hierarchical-mesh` works for most cases
4. **Set appropriate timeouts** — Long-running workflows need 5-10min timeouts
5. **Use tiered memory** — Don't store everything in semantic tier

## Troubleshooting

### Agent Spawning Fails

Check Ruflo is running and accessible:

```bash
ruflo system status
```

### Memory Search Returns Empty

- Verify namespace matches: `memory_search({ namespace: "paperclip" })`
- Lower threshold: `threshold: 0.3` (default is 0.5)
- Check if memory was stored: `memory_store` succeeded

### Swarm Limit of 50 Agents

Ruflo has a hard-coded 50 agent limit in `swarm_init()`. Workaround:

```typescript
// Use agent_spawn directly instead
for (let i = 0; i < 200; i++) {
  await agent_spawn({
    agentType: "worker",
    agentId: `worker-${i}`
  });
}
```

## Requirements

- Ruflo MCP server running locally or accessible via network
- Node.js >= 20
- Paperclip server with plugin support enabled
- Ruflo installed: `npm install -g ruflo`

## License

MIT

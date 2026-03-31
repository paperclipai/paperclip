# Ruflo MCP Bridge Plugin

Multi-agent orchestration, semantic memory, and workflow automation for Paperclip.

## Features

- **Agent Spawning** — Create specialized agents (worker, specialist, scout, coordinator, analyst) with intelligent model routing
- **Swarm Orchestration** — Initialize coordinated agent swarms with hierarchical, mesh, or hybrid topologies (up to 300 agents)
- **Semantic Memory** — HNSW-indexed vector search for persistent cross-session knowledge
- **Workflow Automation** — Create and execute structured multi-step workflows
- **Coordination Primitives** — Consensus protocols, load balancing, node management, synchronization

## Tools

| Tool | Description |
|------|-------------|
| `agent_spawn` | Spawn a new Ruflo agent with intelligent model selection |
| `swarm_init` | Initialize a coordinated swarm (hierarchical/mesh/hybrid topology) |
| `memory_store` | Store values with vector embeddings for semantic search |
| `memory_search` | HNSW-accelerated semantic vector search (150-12,500x faster than keyword) |
| `workflow_create` | Create structured workflows with task/condition/parallel/loop steps |
| `workflow_execute` | Execute workflows with runtime variable injection |
| `coordination_orchestrate` | Multi-agent coordination for complex tasks |
| `coordination_consensus` | BFT/Raft/Quorum consensus protocols |
| `coordination_sync` | State synchronization across nodes |

## Usage

```typescript
// Spawn a specialist agent
const agent = await ruflo.agent_spawn({
  agentType: "specialist",
  task: "Review security implications of authentication flow",
  domain: "security",
  model: "opus"
});

// Initialize a swarm for parallel research
const swarm = await ruflo.swarm_init({
  topology: "hierarchical-mesh",
  maxAgents: 50,
  strategy: "adaptive"
});

// Store semantic memory
await ruflo.memory_store({
  key: "project:uniteia:architecture",
  value: { pattern: "multi-site", domains: ["especial.uniteia.com", "spain.uniteia.com"] },
  namespace: "paperclip",
  tags: ["architecture", "uniteia"]
});

// Search memory semantically
const results = await ruflo.memory_search({
  query: "How does Uniteia handle multiple sites?",
  namespace: "paperclip",
  limit: 5
});
```

## Configuration

The plugin respects Ruflo's configuration hierarchy:
- `/root/.hermes/config.yaml` — User-level Ruflo settings
- Environment variables: `RUFLO_HOME`, `RUFLO_CONFIG_PATH`

## Requirements

- Ruflo MCP server running locally or accessible via network
- Node.js >= 20
- Paperclip server with plugin support enabled

## License

MIT

# Skills Hub Plugin

Discover, browse, and install Hermes Agent skills directly within Paperclip.

## Installation

```bash
pnpm add @paperclipai/plugin-skills-hub
```

Enable in your Paperclip config:

```yaml
# config.yaml
plugins:
  - skills-hub
```

Or via environment variable:

```bash
export PAPERCLIP_PLUGINS=skills-hub
```

## Features

- **Skill Discovery** — Search and browse available skills by category, name, or description
- **One-Click Install** — Install skills directly to `~/.hermes/skills/`
- **Skill Management** — Enable/disable skills per platform (CLI, Telegram, Discord, etc.)
- **Category Browsing** — Organized by domain: devops, mlops, research, productivity, etc.

## Available Tools

| Tool | Description |
|------|-------------|
| `skills_list` | List all available skills with name, description, and category |
| `skills_search` | Search skills by keyword in name/description/tags |
| `skills_install` | Download and install a skill to the local skills directory |
| `skills_enable` | Enable a skill for specific platforms |
| `skills_disable` | Disable a skill for specific platforms |
| `skills_info` | Get detailed information about a specific skill |

## Usage Examples

### List Skills by Category

```typescript
// List all devops skills
const devopsSkills = await skills_list({
  category: "devops"
});

console.log(devopsSkills);
// [
//   { name: "github-actions-deploy-astro", description: "...", category: "devops" },
//   { name: "production-health-audit", description: "...", category: "devops" },
//   ...
// ]
```

### Search Skills by Keyword

```typescript
// Search for deployment-related skills
const results = await skills_search({
  query: "deployment production"
});

console.log(results);
// Skills matching "deployment" OR "production" in name/description/tags
```

### Install a Skill

```typescript
// Install a skill from the Hermes registry
await skills_install({
  name: "github-actions-deploy-astro",
  source: "hermes-registry" // or "local", "github"
});

console.log("Skill installed to ~/.hermes/skills/github-actions-deploy-astro/");
```

### Enable/Disable Skills per Platform

```typescript
// Enable skill for CLI and Telegram
await skills_enable({
  name: "ruflo-swarm-maximization",
  platforms: ["cli", "telegram"]
});

// Disable skill for Discord
await skills_disable({
  name: "ruflo-swarm-maximization",
  platforms: ["discord"]
});
```

### Get Skill Details

```typescript
// Get detailed information about a skill
const info = await skills_info({
  name: "production-health-audit"
});

console.log(info);
// {
//   name: "production-health-audit",
//   description: "...",
//   version: "1.0.0",
//   category: "devops",
//   tags: ["production", "audit", "health"],
//   related_skills: ["post-deploy-visual-validation", "remote-uniteia-root"],
//   ...
// }
```

## Skill Categories

| Category | Description | Example Skills |
|----------|-------------|----------------|
| `devops` | Deployment, monitoring, Cloudflare, GitHub Actions | `github-actions-deploy-astro`, `production-health-audit`, `cloudflare-dns-api` |
| `mlops` | Model training, fine-tuning, vector databases, inference | `huggingface-hub`, `qdrant`, `trl-fine-tuning`, `vllm` |
| `research` | Academic papers, market research, continuous mining | `arxiv`, `last30days`, `multi-agent-automation-research` |
| `productivity` | Autonomous operations, session management, routing | `hermes-continuous-operator`, `skill-router`, `session-bootstrap-mem9-ruflo` |
| `software-development` | Code review, architecture, debugging, TDD | `code-reviewer`, `software-architect`, `systematic-debugging`, `test-driven-development` |
| `crypto-operations` | Crypto hunter, mining discovery, wallet management | `crypto-hunter-container`, `mining-discovery-engine`, `cold-wallet-godmode-deploy` |
| `mcp` | MCP server building, mem9 integration, OpenCode mirroring | `mcp-builder`, `mem9-integration`, `opencode-config-mirroring` |
| `frontend-fullstack` | Astro 6, Qwik, Hono, UnoCSS, Biome, Vitest | `frontend-fullstack-sota`, `astro-project-audit`, `ui-ux-pro-max` |

## Integration with Paperclip Workflows

Skills can be invoked as part of Paperclip agent workflows:

```typescript
// Create a workflow that uses skills
const workflow = await workflow_create({
  name: "Production Deploy",
  steps: [
    {
      name: "audit",
      type: "task",
      config: {
        skill: "production-health-audit",
        params: { target: "uniteia.com" }
      }
    },
    {
      name: "build",
      type: "task",
      config: {
        skill: "github-actions-deploy-astro",
        params: { repo: "uniteia", branch: "main" }
      }
    },
    {
      name: "validate",
      type: "task",
      config: {
        skill: "post-deploy-visual-validation",
        params: { url: "https://uniteia.com", screenshots: true }
      }
    }
  ]
});

// Execute the workflow
await workflow_execute({ workflowId: workflow.id });
```

## Skill Workflow Pattern

### 1. Discover

```typescript
// Browse available skills
const allSkills = await skills_list({});
const devopsSkills = await skills_list({ category: "devops" });

// Search for specific capability
const deploySkills = await skills_search({
  query: "deploy production github actions"
});
```

### 2. Evaluate

```typescript
// Get detailed info before installing
const info = await skills_info({
  name: "github-actions-deploy-astro"
});

console.log(`Version: ${info.version}`);
console.log(`Tags: ${info.tags.join(", ")}`);
console.log(`Related: ${info.related_skills.join(", ")}`);
```

### 3. Install

```typescript
// Install the skill
await skills_install({
  name: "github-actions-deploy-astro",
  source: "hermes-registry"
});
```

### 4. Enable

```typescript
// Enable for your platforms
await skills_enable({
  name: "github-actions-deploy-astro",
  platforms: ["cli", "telegram", "discord"]
});
```

### 5. Use

```typescript
// Skill is now available as a slash command in Hermes
// /github-actions-deploy-astro <args>
```

## Common Patterns

### Skill-Based Agent Workflow

```typescript
// Spawn an agent with specific skills enabled
const agent = await agent_spawn({
  agentType: "specialist",
  task: "Deploy Uniteia production",
  domain: "devops",
  skills: [
    "production-health-audit",
    "github-actions-deploy-astro",
    "post-deploy-visual-validation"
  ]
});
```

### Skill Discovery for New Projects

```typescript
// When starting a new project, discover relevant skills
const projectType = "astro-frontend";

const relevantSkills = await skills_search({
  query: projectType === "astro-frontend"
    ? "astro turborepo bun biome playwright"
    : projectType === "rust-backend"
    ? "rust cargo clippy tokio"
    : "general development"
});

// Install top matches
for (const skill of relevantSkills.slice(0, 5)) {
  await skills_install({ name: skill.name });
  await skills_enable({ name: skill.name, platforms: ["cli"] });
}
```

### Skill Audit

```typescript
// List all installed skills
const installed = await skills_list({});

// Check which are enabled for CLI
const cliEnabled = installed.filter(s => s.platforms?.includes("cli"));

console.log(`Installed: ${installed.length}`);
console.log(`CLI enabled: ${cliEnabled.length}`);
```

## Best Practices

### 1. Start Minimal

Install only skills you need for the current task. Add more as requirements emerge.

### 2. Group by Project

Use namespaces or tags to organize skills by project:

```typescript
await memory_store({
  key: "project:uniteia:skills",
  value: {
    installed: [
      "production-health-audit",
      "github-actions-deploy-astro",
      "post-deploy-visual-validation"
    ]
  },
  namespace: "paperclip",
  tags: ["uniteia", "skills", "config"]
});
```

### 3. Keep Skills Updated

Periodically check for skill updates:

```typescript
// Search for newer versions
const latest = await skills_search({
  query: "production-health-audit"
});

if (latest[0].version !== installed.version) {
  console.log(`Update available: ${installed.version} → ${latest[0].version}`);
  // Re-install to get latest version
  await skills_install({ name: installed.name });
}
```

### 4. Share Skill Configs

Export skill configurations for team consistency:

```typescript
const skillConfig = {
  project: "uniteia",
  skills: [
    { name: "production-health-audit", platforms: ["cli", "telegram"] },
    { name: "github-actions-deploy-astro", platforms: ["cli"] },
    { name: "post-deploy-visual-validation", platforms: ["cli", "telegram"] }
  ]
};

// Save to repo
await write_file({
  path: ".paperclip/skills.json",
  content: JSON.stringify(skillConfig, null, 2)
});
```

## Troubleshooting

### Skill Not Found

Ensure the skill is installed and enabled:

```typescript
// Check if installed
const installed = await skills_list({});
const isInstalled = installed.some(s => s.name === "skill-name");

if (!isInstalled) {
  await skills_install({ name: "skill-name" });
}

// Check if enabled
const info = await skills_info({ name: "skill-name" });
console.log(`Enabled for: ${info.platforms?.join(", ")}`);
```

### Skill Not Working

Check skill dependencies and requirements:

```typescript
const info = await skills_info({ name: "skill-name" });

console.log("Required tools:", info.required_tools);
console.log("Required env:", info.required_env);
console.log("Category:", info.category);
```

### Platform Compatibility

Some skills are CLI-only or gateway-only:

```typescript
const info = await skills_info({ name: "skill-name" });

if (info.cli_only) {
  console.log("This skill only works in CLI mode");
}

if (info.gateway_only) {
  console.log("This skill only works in messaging platforms");
}
```

## Requirements

- Hermes Agent skills directory accessible (`~/.hermes/skills/`)
- Node.js >= 20
- Paperclip server with plugin support enabled
- Hermes Agent installed (for skill execution)

## License

MIT

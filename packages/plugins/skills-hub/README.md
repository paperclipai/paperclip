# Skills Hub Plugin

Discover, browse, and install Hermes Agent skills directly within Paperclip.

## Features

- **Skill Discovery** — Search and browse available skills by category, name, or description
- **One-Click Install** — Install skills directly to `~/.hermes/skills/`
- **Skill Management** — Enable/disable skills per platform (CLI, Telegram, Discord, etc.)
- **Category Browsing** — Organized by domain: devops, mlops, research, productivity, etc.

## Tools

| Tool | Description |
|------|-------------|
| `skills_list` | List all available skills with name, description, and category |
| `skills_search` | Search skills by keyword in name/description/tags |
| `skills_install` | Download and install a skill to the local skills directory |
| `skills_enable` | Enable a skill for specific platforms |
| `skills_disable` | Disable a skill for specific platforms |
| `skills_info` | Get detailed information about a specific skill |

## Usage

```typescript
// List all skills in a category
const devopsSkills = await skills_list({
  category: "devops"
});

// Search for skills by keyword
const results = await skills_search({
  query: "deployment production"
});

// Install a skill
await skills_install({
  name: "github-actions-deploy-astro",
  source: "hermes-registry" // or "local", "github"
});

// Enable skill for CLI and Telegram
await skills_enable({
  name: " Ruflo-swarm-maximization",
  platforms: ["cli", "telegram"]
});

// Get skill details
const info = await skills_info({
  name: "production-health-audit"
});
```

## Skill Categories

- **devops** — Deployment, monitoring, Cloudflare, GitHub Actions, production audits
- **mlops** — Model training, fine-tuning, vector databases, inference optimization
- **research** — Academic papers, market research, continuous mining, domain intel
- **productivity** — Autonomous operations, session management, skill routing
- **software-development** — Code review, architecture, debugging, TDD, frontend fullstack
- **crypto-operations** — Crypto hunter, mining discovery, wallet management
- **mcp** — MCP server building, mem9 integration, OpenCode mirroring

## Integration with Paperclip Workflows

Skills can be invoked as part of Paperclip agent workflows:

```typescript
// Agent workflow example
const workflow = await ruflo.workflow_create({
  name: "Production Deploy",
  steps: [
    { name: "audit", type: "task", config: { skill: "production-health-audit" } },
    { name: "build", type: "task", config: { skill: "github-actions-deploy-astro" } },
    { name: "validate", type: "task", config: { skill: "post-deploy-visual-validation" } }
  ]
});
```

## Requirements

- Hermes Agent skills directory accessible (`~/.hermes/skills/`)
- Node.js >= 20
- Paperclip server with plugin support enabled

## License

MIT

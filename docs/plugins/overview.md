# Plugins Overview

Paperclip supports a plugin architecture that extends agent capabilities with specialized tools and integrations.

## What are Plugins?

Plugins are Node.js packages that register additional MCP (Model Context Protocol) tools with the Paperclip server. They allow you to:

- Add new agent capabilities without modifying core
- Share reusable integrations across companies
- Enable/disable features per deployment
- Community-contributed extensions

## Available Plugins

| Plugin | Description | Tools |
|--------|-------------|-------|
| [`@paperclipai/plugin-playwright-mcp`](./playwright-mcp) | Browser automation with Playwright | Navigate, click, fill, screenshot, extract, evaluate |
| [`@paperclipai/plugin-ruflo-bridge`](./ruflo-bridge) | Multi-agent orchestration | Spawn agents, swarm init, semantic memory, workflows |
| [`@paperclipai/plugin-skills-hub`](./skills-hub) | Hermes Agent skills marketplace | Browse, search, install, enable/disable skills |

## Installing Plugins

Plugins are installed as npm packages and registered in your Paperclip server config:

```bash
# Install the plugin package
pnpm add @paperclipai/plugin-playwright-mcp

# Enable in your server config (config.yaml or env)
PAPERCLIP_PLUGINS=playwright-mcp,ruflo-bridge,skills-hub
```

## Building a Plugin

See [Creating a Plugin](./creating-a-plugin) for a step-by-step guide to building your own plugin.

## Plugin Lifecycle

1. **Discovery** — Paperclip scans `node_modules/@paperclipai/plugin-*` at startup
2. **Registration** — Each plugin registers its tools via the Plugin SDK
3. **Execution** — Tools are invoked by agents during task execution
4. **Cleanup** — Resources (browser sessions, agent processes) are cleaned up on session end

## Requirements

- Node.js >= 20
- Paperclip server with plugin support enabled
- Plugin SDK: `@paperclipai/plugin-sdk` (workspace package)

## Next Steps

- [Browser Automation with Playwright](./playwright-mcp)
- [Multi-Agent Orchestration with Ruflo](./ruflo-bridge)
- [Skills Discovery with Skills Hub](./skills-hub)
- [Creating Your Own Plugin](./creating-a-plugin)

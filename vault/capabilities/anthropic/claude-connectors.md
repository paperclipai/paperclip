---
name: "Claude Connectors"
kind: connector
one_liner: "Claude Connectors are pre-built integrations that link Claude.ai (and the Claude API via the MCP Connector) to third-party services like Google Drive, GitHub, Slack, Notion, Asana, Gmail, Google Calendar, Windsor.ai, and Zapier — each connector is a managed MCP server hosted by Anthropic with OAuth-based user authorization."
shipped: "2026-04-15"
status: ga
description: "Pre-built MCP-based integrations from Claude.ai to popular SaaS services."
primary_url: "https://www.anthropic.com/news/agent-capabilities-api"
related_terms: [mcp, tool-use]
related_courses: [production-agents-claude-agent-sdk-mcp-connector]
related_blogs: []
sameAs: []
---

## What Connectors are

Connectors are vendor-managed MCP servers that Anthropic operates and Claude.ai users authorize via OAuth. The user clicks "Connect Google Drive," logs in to Google, and Claude can now read/write Drive files within the chat session via MCP tool calls.

The April 28, 2026 expansion shipped 9 connectors covering the most common SaaS surfaces. The MCP Connector API (separate product, also April 28) lets developers add the same capability to their own Anthropic API calls — so an agent built on the Anthropic API can `connectors: ["google-drive", "github"]` in its request and inherit the same managed integrations.

## Connector vs. building your own MCP server

Use a Connector when: the third-party service is on the supported list, you want vendor-managed auth + lifecycle, and you don't need custom tools beyond the SaaS's standard surface. Build your own MCP server when: the service isn't supported, you need custom tools (e.g., a domain-specific resource type), or you need to embed business logic between the model and the service.

The economic tradeoff: Connectors charge per-tool-call usage on top of the Claude inference cost. For high-volume integrations, self-hosted MCP can be cheaper.

## Supported services as of April 2026

Google Drive, GitHub, Gmail, Google Calendar, Slack, Notion, Asana, Linear, Windsor.ai, plus Zapier (gives access to 7,000+ Zapier-connected apps via a single integration).

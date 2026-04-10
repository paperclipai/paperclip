# 2026-04-10 Composio Tool Gateway Rollout

Status: In Progress
Date: 2026-04-10
Audience: Platform and adapter engineering
Related:
- `doc/SPEC-implementation.md`
- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md`
- `skills/composio-gmail/SKILL.md`
- `skills/composio-heygen/SKILL.md`
- `skills/composio-tiktok/SKILL.md`
- `skills/composio-youtube/SKILL.md`

## 1. Goal

Paperclip should expose Composio once, centrally, instead of wiring Gmail, TikTok, YouTube, and HeyGen separately into each model adapter.

The target architecture is:

- Paperclip orchestration
- Paperclip tool gateway
- Composio sessions
- external SaaS APIs

## 2. Decision

Use Composio sessions as the universal tool layer.

Paperclip should own:

- session creation
- toolkit allowlists per workflow
- connected-account selection
- approval and policy controls
- runtime exposure of Composio tools to agents

Paperclip should not:

- hardcode direct SaaS adapters independently per model runtime
- duplicate auth and account selection logic in Claude, OpenAI, and Pi integrations

## 3. Runtime Strategy

### 3.1 Claude and Codex now

Claude local and Codex local already have a viable distribution path:

- bundled Paperclip skills are mounted or synced to every local run
- shared host config is the effective MCP discovery point

This rollout adds:

- bundled Composio skills for `gmail`, `heygen`, `tiktok`, and `youtube`
- startup-time sync of a shared external MCP server definition into:
  - `~/.claude/mcp-servers.json`
  - `~/.codex/config.toml`

The initial shared MCP target is the Composio/Rube endpoint.

### 3.2 Pi next

Pi does not yet have an equivalent first-class MCP integration path inside Paperclip.

Phase 2 should implement a Paperclip-owned Composio custom provider for Pi, using Composio's custom-provider model to:

- transform discovered Composio tools into Pi's native tool schema
- route execution back through Paperclip policy gates
- preserve the same session and account model used by Claude and OpenAI paths

If Pi gains stable MCP consumption first, that becomes the simpler Phase 2 path. Otherwise the custom provider remains the preferred design.

## 4. Phase 1 Scope

This change set implements:

- startup-time external MCP sync for Claude and Codex shared homes
- dedicated env contract for the Composio/Rube MCP endpoint
- bundled Composio skills for the selected toolkits only:
  - Gmail
  - HeyGen
  - TikTok
  - YouTube
- tests covering env parsing and config merge behavior

This change set does not yet implement:

- a first-class server-side Composio session broker API
- per-company connected-account selection UI
- Pi custom-provider execution
- OpenAI Agents SDK native provider wiring inside Paperclip

## 5. Env Contract

Paperclip server startup should honor:

- `PAPERCLIP_RUBE_MCP_URL`
- `PAPERCLIP_RUBE_MCP_NAME` with default `rube`
- `PAPERCLIP_RUBE_MCP_HEADERS_JSON`
- `PAPERCLIP_EXTERNAL_MCP_SERVERS_JSON`

This lets the VPS define the authoritative shared MCP endpoint once and have Paperclip project it into the local agent runtimes it already controls.

## 6. Why This Shape

This is the lowest-risk route to make Composio available to all local agents now.

It avoids:

- per-adapter SaaS sprawl
- copying credentials and tool maps into multiple runtimes
- blocking the rollout on Pi-specific provider work

It also keeps the future clean:

- the central session model stays valid
- the selected skills continue to work
- Pi and OpenAI-native flows can converge on the same Paperclip-owned gateway later

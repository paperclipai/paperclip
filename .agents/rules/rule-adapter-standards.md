---
trigger: model_decision
description: Apply when a new LLM CLI adapter needs to be added in Paperclip.
---

# Rule: LLM Adapter Standards

Activation: Always On

## Rule
All Paperclip agent adapters (e.g., OpenCode, Claude, Codex) must implement plugin tool support via the standardized MCP Bridge architecture defined in the "Gold Standard" doc.

## Reference
@/doc/GOLD-STANDARD-ADAPTER.md
@/doc/GOLD-STANDARD-ADAPTER-DETAILS.md
@/doc/plugins/GOLD-STANDARD-mcp-injection.md

## Key Requirements
- Use `getPaperclipMcpConfig(ctx)` from `@paperclipai/adapter-utils`.
- Inject plugin tools into agent runtime configuration using the bridge.
- Ensure `PAPERCLIP_API_KEY` is preserved for authentication and auditing.

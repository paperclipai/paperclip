# Paperclip assistant plugins

One shared set of workflows, with packages for OpenAI (ChatGPT/Codex) and Claude.
The packages use only individually exposed first-party Paperclip tools. Agent
impersonation and generic connected-tool execution are not included.

## Build

```sh
# Development package outputs checked into this repository:
node integrations/assistant-plugins/build.mjs

# Replace with the operator's actual deployed endpoint before testing remotely:
node integrations/assistant-plugins/build.mjs https://YOUR-PAPERCLIP-HOST/mcp/paperclip
```

The builder accepts a fixed HTTPS endpoint (HTTP loopback is allowed for local
work). It never adds credentials to packages. It does not install plugins,
register a store listing or create a team. The checked-in localhost outputs are
**development packages**, not public-store submissions.

Edit workflows in `shared/skills/`, then rebuild both packages. OpenAI output has
portable `plugin.json` / `mcp.json` plus a Codex compatibility manifest. Claude
output has `.claude-plugin/plugin.json` and `.mcp.json`. The MCP endpoint is the
same for both. No lifecycle hook, embedded UI or client-side executor is needed.

See [server setup and release gates](../../doc/public-mcp.md). Configure the
client to request `paperclip:read paperclip:write offline_access` for delegation
and refresh, or just `paperclip:read` for a read-only connection. The person may
decline write access during consent. Use each client's normal OAuth connection
flow; do not put agent keys or browser cookies into plugin manifests.

## Distribution

Package `openai/paperclip/` and `claude/paperclip/` separately. Before publishing,
build against the stable Paperclip-owned public endpoint and complete the
provider's review metadata, branding, privacy/support links and live tests.
Submit the Claude remote connector and workflow plugin separately, paired by
server URL. OpenAI currently supports one connected MCP server per public
plugin. Existing registered OpenAI app IDs, if required by the installation
surface, are deployment-specific and are not invented in this source package.

Authoritative packaging references (checked 2026-09-30):

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI submission](https://developers.openai.com/plugins/deploy/submission)
- [Claude plugin structure](https://claude.com/docs/plugins/build)
- [Claude publication](https://claude.com/docs/directory/publish)

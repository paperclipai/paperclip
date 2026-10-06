# @paperclipai/mcp-connector

Outbound connector that lets Paperclip agents use MCP servers on a private
network through the governed gateway (profiles, policies, approvals, audit)
without exposing those servers and without weakening Paperclip's SSRF guard.

It runs inside the private network, dials **out** to Paperclip over a
WebSocket, and relays MCP Streamable HTTP requests to upstreams that are named
in its own config. Paperclip only ever addresses an upstream by name.

Full setup, security model and troubleshooting:
[doc/connections/MCP-CONNECTOR.md](../../doc/connections/MCP-CONNECTOR.md).

## Quick start

1. In Paperclip: **Apps → Advanced → Connectors → Create connector**. Copy the
   one-time enrollment token.
2. Next to your MCP servers:

   ```sh
   PAPERCLIP_URL=https://paperclip.example.com \
   PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN=pcmce_... \
   PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE=/data/credentials.json \
   PAPERCLIP_MCP_CONNECTOR_UPSTREAMS="unifi=http://unifi-network-mcp.unifi-mcp.svc.cluster.local:3000/mcp" \
   paperclip-mcp-connector
   ```

3. Back in Paperclip, use **Add connection** on the connector and review the
   discovered actions under **Apps**.

## Development

```sh
pnpm --filter @paperclipai/mcp-connector test
pnpm --filter @paperclipai/mcp-connector typecheck
pnpm --filter @paperclipai/mcp-connector build   # dist/main.js (bundled)
docker build -f packages/mcp-connector/Dockerfile -t paperclip-mcp-connector .
```

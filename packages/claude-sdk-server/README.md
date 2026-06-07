# @paperclipai/claude-sdk-server

Thin WebSocket JSON-RPC bridge for running `claude_local` on a remote host.

Example:

```bash
pnpm build

paperclip-claude-sdk-server \
  --listen ws://127.0.0.1:4400 \
  --token-file "$HOME/.claude/paperclip-bridge.token"
```

This server speaks the Paperclip-specific bridge protocol used by
`claude_local` when `agentSdkServerUrl` is configured.

If you only want to build the minimum required packages instead of the whole
workspace, build the bridge package:

```bash
pnpm --filter @paperclipai/claude-sdk-server build
node packages/claude-sdk-server/dist/cli.js --listen ws://127.0.0.1:4400
```

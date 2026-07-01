# @paperclipai/claude-sdk-server

Thin WebSocket JSON-RPC bridge for running Claude on a remote host for Paperclip.

This package is now self-contained on the remote side. The remote host does not
need the rest of Paperclip's runtime packages just to execute Claude through the
bridge. It only needs:

- this bridge package
- the `claude` CLI installed and authenticated on that host

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

Current limitation:

- The standalone bridge intentionally uses a slimmer local Claude execution
  path than the full in-process `claude_local` adapter. It supports the remote
  WebSocket control flow, prompt templates, resume IDs, auth/env injection, and
  normal Claude CLI flags, but it does not currently materialize Paperclip's
  managed Claude skill/runtime assets on the remote host.

Archive workflow:

```bash
pnpm --filter @paperclipai/claude-sdk-server bundle
```

That produces:

- `packages/claude-sdk-server/bundle/paperclip-claude-sdk-server-bundle/`
- `packages/claude-sdk-server/bundle/paperclip-claude-sdk-server-bundle.tar.gz`

On the remote host:

```bash
tar -xzf paperclip-claude-sdk-server-bundle.tar.gz
cd paperclip-claude-sdk-server-bundle
npm install --omit=dev
node dist/cli.js --listen ws://127.0.0.1:4400
```

Only the `ws` package is installed on the remote host from npm. The rest of the
bridge runtime is already bundled into `dist/`.

# paperclip-claude-sdk-server-bundle

This is a minimal runtime bundle for the standalone Paperclip Claude bridge.

Requirements:
- Node.js 20+
- `claude` installed and authenticated on this host

Install runtime dependencies:

```bash
npm install --omit=dev
```

Run:

```bash
node dist/cli.js --listen ws://127.0.0.1:4400
```

With bearer auth:

```bash
node dist/cli.js --listen ws://127.0.0.1:4400 --token-file "$HOME/.claude/paperclip-bridge.token"
```

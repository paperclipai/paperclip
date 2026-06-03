# MJI-12 MCP SDK Compatibility Check

Date: 2026-05-03

## Canonical source wiring
- Added direct dependency in `cli/package.json`:
  - `"@modelcontextprotocol/sdk": "1.29.0"`
- Updated workspace lockfile via:
  - `corepack pnpm install --lockfile-only --filter paperclipai`

## Runtime resolution evidence
Command:
- `npm ls @modelcontextprotocol/sdk --all` (run in installed runtime package path)

Output:
- `paperclipai@2026.428.0 ...`
- `└── @modelcontextprotocol/sdk@1.29.0`

Resolved location observed in runtime install tree:
- `/Users/marxcrackedupmac/.hermes/node/lib/node_modules/paperclipai/node_modules/@modelcontextprotocol/sdk`

## Issue API flow smoke checks
Attempted commands:
- `node dist/index.js issue checkout --help`
- `node dist/index.js issue comment --help`
- `node dist/index.js issue update --help`

Result in this workspace:
- Blocked by local runtime dependency resolution (`ERR_MODULE_NOT_FOUND` for `zod`) when executing built `dist/index.js`.
- This does **not** affect the dependency wiring verification above (`npm ls @modelcontextprotocol/sdk --all`), which confirms the canonical package now resolves `@modelcontextprotocol/sdk@1.29.0`.

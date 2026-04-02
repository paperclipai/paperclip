# Errors

## [ERR-20260330-001] openclaw-gateway-global-claimed-key

**Logged**: 2026-03-30T13:39:30+01:00
**Priority**: high
**Status**: fixed-local
**Area**: adapters/openclaw-gateway

### Summary
Paperclip's OpenClaw gateway wake text instructed every agent to load a single global claimed API key file (`~/.openclaw/workspace/paperclip-claimed-api-key.json`). When that file belonged to Atlas, other agents such as Quill/Scout/Plutus woke with their own `PAPERCLIP_AGENT_ID` but Atlas's API token, causing checkout failures: `Agent can only checkout as itself`.

### Fix
Use per-agent key files under `~/.openclaw/workspace/paperclip-agent-keys/<agent>.json` in wake instructions, with the legacy global file only as fallback.

### Files
- `packages/adapters/openclaw-gateway/src/server/execute.ts`

---

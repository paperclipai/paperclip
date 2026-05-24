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
## [ERR-20260524-001] vitest

**Logged**: 2026-05-24T01:50:15+01:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
Temporary assertion mismatch while extending OpenClaw onboarding tests for new autosetup text/command output.

### Error
```
invite-onboarding-text assertions expected stale phrases/paths after onboarding autoSetup changes
```

### Context
- Command: pnpm test:run server/src/__tests__/invite-onboarding-text.test.ts ...
- Cause: expected string did not match new wording; command contains require(process.env.HOME+"/.openclaw/openclaw.json") rather than literal ~/.openclaw/openclaw.json

### Suggested Fix
Update assertions to match current generated text or assert the intended semantic markers instead of brittle exact phrases.

### Metadata
- Reproducible: yes
- Related Files: server/src/__tests__/invite-onboarding-text.test.ts

### Resolution
- **Resolved**: 2026-05-24T01:51:00+01:00
- **Notes**: Adjusted assertions to target current approval-boundary wording and command contents.

---

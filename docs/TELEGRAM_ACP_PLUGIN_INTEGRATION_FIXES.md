# Telegram-ACP Plugin Integration Fixes

## Executive Summary

This document comprehensively addresses 5 critical bugs (#3642-#3646) in the cross-plugin communication between `paperclip-plugin-telegram` and `paperclip-plugin-acp`. These issues collectively break all Telegram-initiated ACP sessions globally.

**Impact:** Every user attempting to spawn an ACP agent via Telegram fails silently or crashes.

**Root Cause:** Telegram plugin sends events on incorrect channel names, with incomplete payloads, and using incorrect field names. ACP plugin can't receive them.

**Risk:** Critical (Feature broken)

---

## Issue #3642: Wrong Event Channel Names (Root Cause)

### Problem
Telegram emits on bare channel names (`acp-spawn`, `acp-message`), but ACP listens on namespaced channels (`plugin.paperclip-plugin-telegram.acp-spawn`, `plugin.paperclip-plugin-telegram.acp-message`).

### Current Code (BROKEN)
```ts
// paperclip-plugin-telegram/dist/acp-bridge.js
export const ACP_SPAWN_EVENT = "acp-spawn";

// Both spawn AND message routed to same channel:
ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
    type: "spawn",
    sessionId,
    agentName: trimmedName,
    chatId,
    threadId: messageThreadId,
});

ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {  // ← WRONG! Should use ACP_MESSAGE_EVENT
    type: "message",
    sessionId: targetSession.sessionId,
    chatId,
    threadId,
    text,
});
```

### ACP Listener (What it expects)
```ts
// paperclip-plugin-acp/dist/worker.js
for (const platformPlugin of CHAT_PLATFORM_PLUGINS) {
    ctx.events.on(`plugin.${platformPlugin}.acp-spawn`, async (rawEvent) => {
        // ← Telegram emits as "acp-spawn", listener never fires
    });
    ctx.events.on(`plugin.${platformPlugin}.acp-message`, async (rawEvent) => {
        // ← Telegram never emits to this channel
    });
}
```

### Fix
**In `paperclip-plugin-telegram/dist/acp-bridge.js`:**

```ts
// Define plugin namespace constant
const PLUGIN_NAME = "paperclip-plugin-telegram";

export const ACP_SPAWN_EVENT = `plugin.${PLUGIN_NAME}.acp-spawn`;
export const ACP_MESSAGE_EVENT = `plugin.${PLUGIN_NAME}.acp-message`;

// Spawn:
ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
    type: "spawn",
    sessionId,
    agentName: trimmedName,
    chatId,
    threadId: messageThreadId,
});

// Message (NEW):
ctx.events.emit(ACP_MESSAGE_EVENT, resolvedCompanyId, {
    type: "message",
    sessionId: targetSession.sessionId,
    chatId,
    threadId,
    text,
});
```

### Testing
- [ ] Verify event listener matches namespace: `plugin.paperclip-plugin-telegram.acp-spawn`
- [ ] Verify message listener receives: `plugin.paperclip-plugin-telegram.acp-message`
- [ ] Spawn from Telegram → check ACP spawn listener fires (add debug log)
- [ ] Send message to ACP session → check ACP message listener fires

---

## Issue #3644: Missing companyId in Event Payload

### Problem
Telegram passes `companyId` as the event scope arg (2nd param to `emit`), not in the payload. ACP plugin reads it from the payload, gets `undefined`, and emits output events to wrong company scope.

### Current Code (BROKEN)
```ts
// Telegram sends:
ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {  // ← companyId is 2nd arg, not in object
    type: "spawn",
    sessionId,
    agentName: trimmedName,
    chatId,
    threadId: messageThreadId,
    // NO companyId here
});

// ACP reads:
async function handleSpawn(ctx, config, enabledAgents, event, sourcePlatform) {
    const companyId = event.companyId;   // ← undefined!
    ctx.events.emit(OUTBOUND_EVENTS.output, companyId, {  // ← emits to undefined scope
        ...
    });
}
```

### Fix (Option A - Recommended)
**In `paperclip-plugin-telegram/dist/acp-bridge.js`:**

```ts
ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
    type: "spawn",
    sessionId,
    agentName: trimmedName,
    companyId: resolvedCompanyId,  // ← Add companyId to payload
    chatId,
    threadId: messageThreadId,
});
```

### Fix (Option B - ACP reads from scope)
**In `paperclip-plugin-acp/dist/worker.js`:**

```ts
ctx.events.on(`plugin.${platformPlugin}.acp-spawn`, async (rawEvent) => {
    const event = rawEvent.payload;
    const companyId = rawEvent.companyId ?? event.companyId;  // ← Fall back to scope
    await handleSpawn(ctx, config, enabledAgents, { ...event, companyId }, platformPlugin);
});
```

**Recommendation:** Implement Option A (self-contained payload) + Option B (defensive fallback).

### Testing
- [ ] Add debug log: `console.log("companyId from payload:", event.companyId)`
- [ ] Verify companyId is present and non-undefined before emit
- [ ] Verify output events arrive at correct company scope

---

## Issue #3643: Agent Name/ID Mismatch

### Problem
Telegram sends human-readable agent display names (`"EA"`, `"DevOps"`) as `agentName`, but ACP plugin expects ACP agent IDs (`"claude"`, `"codex"`, `"gemini"`, `"opencode"`).

### Current Code (BROKEN)
```ts
// Telegram sends:
ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
    type: "spawn",
    sessionId,
    agentName: trimmedName,  // ← "EA" or "DevOps" from user
    chatId,
    threadId: messageThreadId,
});

// ACP plugin reads:
async function handleSpawn(ctx, config, enabledAgents, event, sourcePlatform) {
    const agentId = event.agentName || config.defaultAgent;  // ← "EA" is not valid ACP agent
    const agent = getAgent(agentId);  // ← Fails to find "EA" in BUILT_IN_AGENTS
    if (!agent) {
        // Emits error: "Unknown agent: EA. Available: claude, codex, gemini, opencode"
    }
}
```

### Fix
**In `paperclip-plugin-telegram/dist/acp-bridge.js`:**

1. Resolve the Paperclip agent to get its adapter type
2. Map adapter type to ACP agent ID
3. Send `agentId` (not `agentName`) in payload

```ts
// Get the agent from Paperclip's registry
const agent = ctx.agents.get(agentId, companyId);
if (!agent) {
    // Handle missing agent
    return;
}

// Map adapter type to ACP agent ID
const adapterToAcpAgent = {
    "claude_code": "claude",
    "codex": "codex",
    "gemini": "gemini",
    "opencode": "opencode",
    // Add mappings as needed
};
const acpAgentId = adapterToAcpAgent[agent.adapterType] || "claude";  // Default to claude

ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
    type: "spawn",
    sessionId,
    agentId: acpAgentId,  // ← Changed from agentName to agentId
    companyId: resolvedCompanyId,
    chatId,
    threadId: messageThreadId,
});
```

### Testing
- [ ] List available Paperclip agents and their adapter types
- [ ] Verify adapter type maps to valid ACP agent ID
- [ ] Spawn "EA" agent → verify ACP receives valid `agentId` (not `agentName`)
- [ ] Verify no "Unknown agent" errors

---

## Issue #3645: Claude Spawned with Empty Args

### Problem
ACP plugin spawns `claude` CLI with empty `args: []`. In non-interactive server environments (no TTY, piped stdin), Claude Code exits immediately.

### Current Code (BROKEN)
```ts
// paperclip-plugin-acp/dist/agents.js
const BUILT_IN_AGENTS = {
    claude: {
        id: "claude",
        command: "claude",
        args: [],  // ← Empty!
        displayName: "Claude Code",
        ...
    },
};

// Spawned with:
// stdio: ["pipe", "pipe", "pipe"] (non-interactive)
// No TTY → Claude CLI error: "Input must be provided through stdin or as prompt argument"
```

### Fix
**In `paperclip-plugin-acp/dist/agents.js`:**

```ts
const BUILT_IN_AGENTS = {
    claude: {
        id: "claude",
        command: "claude",
        args: [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
            "--replay-user-messages",
        ],
        displayName: "Claude Code",
        ...
    },
};
```

### Rationale
- `-p`: Print mode (required for non-interactive)
- `--input-format stream-json`: Receive NDJSON from stdin
- `--output-format stream-json`: Send NDJSON to stdout (matches `acp-spawn.js` NDJSON parsing)
- `--verbose`: Better debugging
- `--dangerously-skip-permissions`: Allow tool use in server context
- `--replay-user-messages`: Maintain session context across calls

### Testing
- [ ] Build a test environment with no TTY (Docker or systemd service)
- [ ] Attempt to spawn claude agent
- [ ] Verify process stays alive (no immediate exit)
- [ ] Verify stdout/stdin communication with NDJSON payloads

---

## Issue #3646: Error-Type ACP Events Crash Telegram Handler

### Problem
When ACP emits `type: "error"` events (no `text` field), Telegram handler crashes trying to access `text.length`.

### Current Code (BROKEN)
```ts
// paperclip-plugin-acp emits:
ctx.events.emit(OUTBOUND_EVENTS.output, companyId, {
    sessionId: null,
    type: "error",
    error: `Unknown agent: ${agentId}. Available: ...`,
    // ← no "text" field
});

// Telegram handler reads:
export async function handleAcpOutput(ctx, token, event) {
    const { sessionId, chatId, threadId, text, done } = event;
    // text is undefined when event.type === "error"
    ...
    await sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done);
}

async function sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done) {
    ...
    if (text.length <= TELEGRAM_MAX_LENGTH) {  // ← TypeError: Cannot read properties of undefined
```

### Fix (Recommended: Option B)
**In `paperclip-plugin-telegram/dist/acp-bridge.js`:**

Handle error type explicitly and send user-facing message:

```ts
export async function handleAcpOutput(ctx, token, event) {
    const { sessionId, chatId, threadId, text, done, type, error } = event;
    
    // Handle error-type events
    if (type === "error") {
        const displayName = "System";
        const errorMsg = `❌ ${error ?? "Unknown error"}`;
        await sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, errorMsg, true);
        return;
    }
    
    const displayName = ctx.sessions.get(sessionId)?.agentName || "Agent";
    await sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done);
}
```

### Fix (Defensive: Option A)
**In `sendLabeledOutput`:**

```ts
async function sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done) {
    const safeText = text ?? "";  // ← Coerce undefined/null to empty string
    if (safeText.length <= TELEGRAM_MAX_LENGTH) {
        // ...
    }
}
```

**Recommendation:** Implement both. Option B gives users visible error messages; Option A prevents crashes even if Option B is missed.

### Testing
- [ ] Trigger an error condition (unknown agent, spawn failure)
- [ ] Verify Telegram handler doesn't crash
- [ ] Verify user sees error message in Telegram (not silent failure)
- [ ] Verify session is marked as complete/failed

---

## Implementation Order

**Priority 1 (Blocking):**
1. Fix #3642 (channel names) — **Event listeners won't fire without this**
2. Fix #3644 (companyId in payload) — **Output events go to wrong scope**
3. Fix #3643 (agentId vs agentName) — **Agent lookup fails**

**Priority 2 (Enablers):**
4. Fix #3645 (claude args) — **Process exits immediately without this**

**Priority 3 (UX):**
5. Fix #3646 (error handling) — **Silent failures with no error message**

---

## Testing Checklist

### Unit Tests
- [ ] Channel name constants are correct
- [ ] Payload includes all required fields (companyId, agentId, etc.)
- [ ] Error event handling doesn't crash
- [ ] Claude args enable stdin/stdout communication

### Integration Tests
- [ ] Full flow: Telegram spawn → ACP receives → process starts
- [ ] Message routing: Telegram sends message → ACP receives on correct channel
- [ ] Error scenario: Unknown agent → user sees error in Telegram
- [ ] Session lifecycle: Create → interact → complete → cleanup

### End-to-End Tests
- [ ] User sends `/spawn claude` in Telegram
- [ ] Claude Code process starts in ACP
- [ ] User sends message to session
- [ ] Session gets response in Telegram
- [ ] Session can be closed cleanly

---

## Cross-Plugin Communication Contract

After these fixes, the event flow should be:

```
Telegram Plugin:
├── Listen: plugin.paperclip-plugin-acp.acp-output (from ACP)
├── Emit: plugin.paperclip-plugin-telegram.acp-spawn {
│   ├── type: "spawn"
│   ├── sessionId: string
│   ├── agentId: "claude" | "codex" | "gemini" | "opencode"
│   ├── companyId: string (for scope + payload)
│   ├── chatId: string
│   └── threadId: string | null
│ }
├── Emit: plugin.paperclip-plugin-telegram.acp-message {
│   ├── type: "message"
│   ├── sessionId: string
│   ├── companyId: string
│   ├── text: string
│   ├── chatId: string
│   └── threadId: string | null
│ }
└── Listen: agent.tool.* events (for future integration)

ACP Plugin:
├── Listen: plugin.paperclip-plugin-telegram.acp-spawn
├── Listen: plugin.paperclip-plugin-telegram.acp-message
├── Spawn: local subprocess (claude/codex/etc)
├── Route: input messages → subprocess stdin
├── Parse: subprocess stdout (NDJSON)
├── Emit: plugin.paperclip-plugin-telegram.acp-output {
│   ├── type: "output" | "error" | "done"
│   ├── sessionId: string
│   ├── companyId: string
│   ├── text?: string
│   ├── error?: string
│   └── done: boolean
│ }
└── Cleanup: subprocess on session end
```

---

## Related Issues & PR References

- Companion to #3106 (sessionPrompt propagation)
- Related to plugin event routing infrastructure
- Affects all cross-plugin ACP integrations

---

## Rollback Plan

If issues arise post-deployment:
1. Revert channel names to bare `acp-spawn`/`acp-message` (breaks again, but known state)
2. Restore empty claude args (process exits, but no crashes)
3. Remove error handling (silent failures, but no visible errors)

**Preferred:** All fixes are additive or corrective; no rollback should be needed. Tests will verify before merge.


# Implementation Example: Error-Type Event Handling (#3646)

## Objective

Demonstrate how to implement the error-type event handling fix from the Telegram-ACP integration analysis.

## Problem Recap

When ACP plugin emits `type: "error"` events (without a `text` field), the Telegram handler crashes:

```ts
// Crashes here:
if (text.length <= TELEGRAM_MAX_LENGTH) {
    // TypeError: Cannot read properties of undefined (reading 'length')
}
```

## Solution

Implement defensive error handling in the output handler.

### Recommended Implementation (Option B)

Handle error events explicitly before processing:

```ts
// In paperclip-plugin-telegram/dist/acp-bridge.js

export async function handleAcpOutput(ctx, token, event) {
    const { sessionId, chatId, threadId, text, done, type, error } = event;
    
    // Handle error-type events
    if (type === "error") {
        const errorMessage = `❌ ${error ?? "Unknown error occurred"}`;
        const displayName = "System";
        await sendLabeledOutput(
            ctx, 
            token, 
            chatId, 
            threadId, 
            sessionId, 
            displayName, 
            errorMessage, 
            true  // Mark as done
        );
        return;
    }
    
    // Normal output handling
    const displayName = ctx.sessions.get(sessionId)?.agentName || "Agent";
    await sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done);
}
```

### Defensive Implementation (Option A)

Coerce undefined text to empty string in the sending function:

```ts
// In paperclip-plugin-telegram/dist/acp-bridge.js

async function sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done) {
    // Defensive: coerce undefined/null to empty string
    const safeText = text ?? "";
    
    // Check length safely
    if (safeText.length <= TELEGRAM_MAX_LENGTH) {
        // Send as single message
        await ctx.sendMessage(token, chatId, {
            text: `**${displayName}**\n${safeText}`,
            threadId,
        });
    } else {
        // Split into chunks
        const chunks = chunkText(safeText, TELEGRAM_MAX_LENGTH);
        for (const chunk of chunks) {
            await ctx.sendMessage(token, chatId, {
                text: `**${displayName}**\n${chunk}`,
                threadId,
            });
        }
    }
    
    if (done) {
        // Session complete
        ctx.sessions.delete(sessionId);
    }
}
```

## Combined Implementation (Recommended)

Use both options together:

```ts
// Option B: Handle error type explicitly
export async function handleAcpOutput(ctx, token, event) {
    const { sessionId, chatId, threadId, text, done, type, error } = event;
    
    if (type === "error") {
        const errorMessage = `❌ ${error ?? "Unknown error occurred"}`;
        await sendLabeledOutput(
            ctx, token, chatId, threadId, sessionId, "System", errorMessage, true
        );
        return;
    }
    
    const displayName = ctx.sessions.get(sessionId)?.agentName || "Agent";
    await sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done);
}

// Option A: Defensive coercion
async function sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done) {
    const safeText = text ?? "";  // Coerce to empty if undefined
    
    if (safeText.length <= TELEGRAM_MAX_LENGTH) {
        await ctx.sendMessage(token, chatId, {
            text: `**${displayName}**\n${safeText}`,
            threadId,
        });
    } else {
        const chunks = chunkText(safeText, TELEGRAM_MAX_LENGTH);
        for (const chunk of chunks) {
            await ctx.sendMessage(token, chatId, {
                text: `**${displayName}**\n${chunk}`,
                threadId,
            });
        }
    }
    
    if (done) {
        ctx.sessions.delete(sessionId);
    }
}
```

## Testing

### Unit Test

```ts
describe("handleAcpOutput - error handling", () => {
    it("should handle error-type events without crashing", async () => {
        const ctx = createMockContext();
        const token = "test-token";
        const event = {
            type: "error",
            error: "Unknown agent: EA. Available: claude, codex",
            sessionId: "session-123",
            chatId: 123,
            threadId: null,
            text: undefined,  // ← No text field for error type
            done: true,
        };
        
        // Should not throw
        await expect(handleAcpOutput(ctx, token, event)).resolves.not.toThrow();
        
        // Should have called sendLabeledOutput with error message
        expect(ctx.sendMessage).toHaveBeenCalledWith(
            token,
            123,
            expect.objectContaining({
                text: expect.stringContaining("❌"),
                text: expect.stringContaining("Unknown agent"),
            })
        );
    });
    
    it("should handle text=undefined gracefully in sendLabeledOutput", async () => {
        const ctx = createMockContext();
        const token = "test-token";
        
        await sendLabeledOutput(
            ctx,
            token,
            123,           // chatId
            null,          // threadId
            "session-123", // sessionId
            "Agent",       // displayName
            undefined,     // ← text is undefined
            false          // done
        );
        
        // Should have called sendMessage (not crashed)
        expect(ctx.sendMessage).toHaveBeenCalled();
    });
});
```

### Integration Test

```ts
describe("Telegram-ACP error scenario", () => {
    it("should send user-visible error when unknown agent spawned", async () => {
        const ctx = createIntegrationContext();
        
        // Trigger error: spawn unknown agent
        ctx.emit("plugin.paperclip-plugin-telegram.acp-spawn", companyId, {
            type: "spawn",
            agentName: "INVALID_AGENT",  // ← Will cause error
            sessionId: "s1",
            chatId: 123,
            threadId: null,
        });
        
        // Wait for error event
        const errorEvent = await waitFor(() => 
            ctx.capturedEvents.find(e => e.type === "error")
        );
        
        // Handle the error event
        await handleAcpOutput(ctx, token, errorEvent);
        
        // User should see error message in Telegram
        const telegramMessage = ctx.telegramMessages[0];
        expect(telegramMessage.text).toContain("❌");
        expect(telegramMessage.text).toContain("Unknown agent");
    });
});
```

## Verification Checklist

- [ ] Error events don't crash the handler
- [ ] User sees human-readable error message in Telegram
- [ ] Session is marked as complete/done after error
- [ ] Regular text events still work (no regression)
- [ ] Text chunking still works for large outputs
- [ ] Session cleanup happens correctly

## Related Files

- Main analysis: `docs/TELEGRAM_ACP_PLUGIN_INTEGRATION_FIXES.md` (Issue #3646)
- Plugin repos:
  - `paperclip-plugin-telegram`: Implement Option B handler
  - `paperclip-plugin-acp`: Ensure error events include `error` field

## Deployment

1. Implement in `paperclip-plugin-telegram`
2. Run unit + integration tests
3. Deploy with other fixes from #3642-#3645
4. Monitor error logs for any remaining undefined text cases

---

**Example PR Title:**
```
fix(plugin-telegram): handle error-type ACP output events gracefully (#3646)

- Explicitly handle type=error events with user-visible messages
- Add defensive text coercion in sendLabeledOutput
- Prevents crashes on ACP error events
```

# Server-Driven Messages (Trigger Patterns)

Fetch https://developers.cloudflare.com/agents/api-reference/trigger-patterns/ for complete documentation.

Patterns for server-initiated LLM turns in `AIChatAgent` — from schedules, webhooks, email, or other agents.

## `saveMessages` — Trigger an LLM Turn

```typescript
await this.saveMessages((existingMessages) => [
  ...existingMessages,
  { role: "user", content: "Check for new notifications" }
]);
```

`saveMessages` persists the messages AND triggers `onChatMessage`.

## `persistMessages` — Save Without Triggering

```typescript
await this.persistMessages([
  ...this.messages,
  { role: "assistant", content: "System note: checked at " + new Date() }
]);
```

## `waitUntilStable`

**Always call before `saveMessages` from non-chat contexts** (schedules, webhooks, email):

```typescript
async checkNotifications(payload: unknown, schedule: Schedule) {
  await this.waitUntilStable({ timeout: 30_000 });
  await this.saveMessages((msgs) => [
    ...msgs,
    { role: "user", content: "Run scheduled notification check" }
  ]);
}
```

## `onChatResponse`

Runs after each LLM turn completes. Use for chaining:

```typescript
async onChatResponse(result: ChatResponseResult) {
  if (result.type === "finish" && needsFollowUp(result)) {
    await this.saveMessages((msgs) => [
      ...msgs,
      { role: "user", content: "Continue with next step" }
    ]);
  }
}
```

## Client Status

```tsx
const { isStreaming, isServerStreaming } = useAgentChat({ agent });
```

- `isStreaming` — true during any streaming (user-initiated or server-initiated)
- `isServerStreaming` — true only during server-initiated streams

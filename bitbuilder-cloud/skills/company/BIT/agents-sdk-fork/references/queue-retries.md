# Queue & Retries

Fetch https://developers.cloudflare.com/agents/api-reference/queue-tasks/ and https://developers.cloudflare.com/agents/api-reference/retries/ for complete documentation.

## Built-in Queue

FIFO queue persisted in SQLite. Sequential processing, one item at a time.

```typescript
export class MyAgent extends Agent<Env, State> {
  async onRequest(request: Request) {
    this.queue("processItem", { id: "abc", data: "..." });
    this.queue("processItem", { id: "def", data: "..." }, { retry: { maxAttempts: 5 } });
    return new Response("Queued");
  }

  async processItem(payload: { id: string; data: string }, queueItem: QueueItem) {
    await doWork(payload);
  }
}
```

### Queue Management

```typescript
const items = this.getQueue();
const byCallback = this.getQueues("processItem");
this.dequeue(itemId);
this.dequeueAll();
this.dequeueAllByCallback("processItem");
```

## Retries

Exponential backoff with full jitter. Defaults: 3 attempts, 100ms base, 3000ms max.

```typescript
const result = await this.retry(
  async () => {
    const res = await fetch("https://api.example.com/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  {
    maxAttempts: 5,
    baseDelayMs: 200,
    maxDelayMs: 5000,
    shouldRetry: (err, nextAttempt) => {
      if (err.message.includes("429")) return true;
      if (err.message.includes("401")) return false;
      return nextAttempt <= 3;
    }
  }
);
```

### Retry on Schedules and Queue

```typescript
await this.schedule(60, "task", payload, { retry: { maxAttempts: 3 } });
await this.scheduleEvery(30, "poll", undefined, { retry: { maxAttempts: 2 } });
this.queue("handler", payload, { retry: { maxAttempts: 5 } });
```

### Class-level Defaults

```typescript
export class MyAgent extends Agent<Env, State> {
  static options = {
    retry: { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 10000 }
  };
}
```

## Important

- `shouldRetry` only works on `this.retry()` — not on schedule/queue (callbacks aren't serializable)
- Queue retries block head-of-line; long delays keep the DO awake — use `schedule` for long waits instead
- No dead-letter queue — failed items are removed after retries exhausted

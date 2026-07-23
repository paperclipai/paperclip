# State & Scheduling

Fetch https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/ and https://developers.cloudflare.com/agents/api-reference/schedule-tasks/ for complete documentation.

## State Management

State persists to SQLite and broadcasts to connected clients automatically.

### Define Typed State

```typescript
type State = { 
  count: number;
  items: string[];
};

export class MyAgent extends Agent<Env, State> {
  initialState: State = { count: 0, items: [] };
}
```

### Read and Update

```typescript
// Read (lazy-loaded from SQLite)
const count = this.state.count;

// Write (sync, persists, broadcasts)
this.setState({ count: this.state.count + 1 });
```

### Validation Hook

`validateStateChange()` runs synchronously before state persists. Throw to reject the update.

```typescript
validateStateChange(nextState: State, source: Connection | "server") {
  if (nextState.count < 0) {
    throw new Error("Count cannot be negative");
  }
}
```

### Execution Order

1. `validateStateChange(nextState, source)` - sync, gating
2. State persisted to SQLite
3. State broadcast to connected clients
4. `onStateUpdate(nextState, source)` - async via `ctx.waitUntil`, non-gating

### Client-Side Sync (React)

```tsx
import { useAgent } from "agents/react";

function App() {
  const [state, setLocalState] = useState<State>({ count: 0 });
  
  const agent = useAgent<State>({
    agent: "MyAgent",
    name: "instance-1",
    onStateUpdate: (newState) => setLocalState(newState)
  });

  return <button onClick={() => agent.setState({ count: state.count + 1 })}>
    Count: {state.count}
  </button>;
}
```

## SQL API

Direct SQLite access for custom queries:

```typescript
// Create table
this.sql`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )
`;

// Insert
this.sql`INSERT INTO items (id, name) VALUES (${id}, ${name})`;

// Query with types
const items = this.sql<{ id: string; name: string }>`
  SELECT * FROM items WHERE name LIKE ${`%${search}%`}
`;
```

## Scheduling

### Schedule Types

| Mode | Syntax | Use Case |
|------|--------|----------|
| Delay | `this.schedule(60, ...)` | Run in 60 seconds |
| Date | `this.schedule(new Date(...), ...)` | Run at specific time |
| Cron | `this.schedule("0 8 * * *", ...)` | Recurring schedule |
| Interval | `this.scheduleEvery(30, ...)` | Fixed interval (every 30s) |

### Examples

```typescript
// Delay (seconds)
await this.schedule(60, "checkStatus", { id: "abc123" });

// Specific date
await this.schedule(new Date("2025-12-25T00:00:00Z"), "sendGreeting", { to: "user" });

// Cron (recurring)
await this.schedule("0 9 * * 1-5", "weekdayReport", {});

// Fixed interval (every 30 seconds, overlap prevention built-in)
await this.scheduleEvery(30, "pollUpdates");
await this.scheduleEvery(300, "syncData", { source: "api" });
```

### Handler

```typescript
async sendGreeting(payload: { to: string }, schedule: Schedule) {
  console.log(`Sending greeting to ${payload.to}`);
  // Cron schedules auto-reschedule; one-time schedules are deleted
}
```

### Manage Schedules

```typescript
const schedules = this.getSchedules();
const crons = this.getSchedules({ type: "cron" });
await this.cancelSchedule(schedule.id);
```

### Retry on Schedules

```typescript
await this.schedule(60, "task", payload, { retry: { maxAttempts: 3 } });
await this.scheduleEvery(30, "poll", undefined, { retry: { maxAttempts: 2 } });
```

## Lifecycle Callbacks

```typescript
export class MyAgent extends Agent<Env, State> {
  async onStart() {
    // Agent started or woke from hibernation
  }

  onConnect(conn: Connection, ctx: ConnectionContext) {
    // WebSocket connected
  }

  onMessage(conn: Connection, message: WSMessage) {
    // WebSocket message (non-RPC)
  }

  onStateUpdate(state: State, source: Connection | "server") {
    // State changed (async, non-blocking)
  }

  onError(error: unknown) {
    // Error handler
    throw error; // Re-throw to propagate
  }
}
```

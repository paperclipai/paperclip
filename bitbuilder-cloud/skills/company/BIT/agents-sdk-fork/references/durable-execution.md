# Durable Execution

Fetch https://developers.cloudflare.com/agents/api-reference/durable-execution/ for complete documentation.

Fibers let agent work survive Durable Object eviction. Progress is checkpointed to SQLite; on recovery, you decide what to do.

## `runFiber`

```typescript
export class MyAgent extends Agent<Env, State> {
  async onRequest(request: Request) {
    await this.runFiber("process-data", async (ctx) => {
      const step1 = await fetchData();
      ctx.stash({ step: 1, data: step1 });

      const step2 = await transform(step1);
      ctx.stash({ step: 2, result: step2 });

      this.setState({ result: step2 });
    });
    return new Response("Started");
  }

  async onFiberRecovered(ctx) {
    const checkpoint = ctx.stash;
    if (checkpoint.step === 1) {
      const step2 = await transform(checkpoint.data);
      this.setState({ result: step2 });
    }
  }
}
```

## Key APIs

| API | Purpose |
|-----|---------|
| `this.runFiber(name, fn)` | Start a named fiber |
| `ctx.stash` / `this.stash` | Read latest checkpoint |
| `ctx.stash = data` | Write checkpoint (JSON-serializable) |
| `onFiberRecovered(ctx)` | Called on DO restart if fiber was in-flight |
| `keepAlive()` | Prevent hibernation while fiber runs |
| `keepAliveWhile(fn)` | Keep alive for duration of async function |

## Important

- `stash` replaces the entire checkpoint — not a merge
- The lambda is NOT restored on recovery — only the stash data is. You must re-derive what to do in `onFiberRecovered`
- No auto-retry on throw — handle errors yourself
- For long-running pipelines with automatic retries, use Workflows instead
- Filter concurrent fibers by `ctx.name` in `onFiberRecovered`

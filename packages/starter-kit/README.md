# @chimeric/starter-kit

The reusable solutions starter kit for Chimeric Intelligence client engagements.
Every new client builds from this — so the second client is faster than the first.

It ships, out of the box, the three pillars of a production AI solution:

1. **LLM orchestration** — provider-agnostic client with retry + timeout, plus:
   - `FakeChatModel` — deterministic, **offline, no credentials** (dev/CI).
   - `OpenAIChatModel` — production adapter (key from the CEO's secret store).
2. **RAG / agent skeleton** — `FakeEmbedder`, `InMemoryVectorStore`,
   `Retriever`, and a grounded `RagAgent`.
3. **Eval harness** — scorers, a `runSuite` runner, and a `withinThreshold`
   quality gate so quality is **measurable before handoff**.

## Why "the second client is faster"

The interfaces are fixed; only the adapters change. A new engagement:
- replaces `FakeChatModel` -> `OpenAIChatModel` (or any vendor),
- replaces `FakeEmbedder` -> a real embedding model,
- points the corpus at the client's documents,
and reuses the client, store, retriever, agent, and eval gate unchanged.

## Quick start

```ts
import { buildDemoKit } from "@chimeric/starter-kit";

const { agent } = await buildDemoKit();
const ans = await agent.ask("What is your refund policy?");
console.log(ans.answer, ans.citations);
```

## Scripts

| Command | What it does |
|----------|--------------|
| `pnpm --filter @chimeric/starter-kit typecheck` | Type-check the kit |
| `pnpm --filter @chimeric/starter-kit test` | Run unit + e2e tests (offline) |
| `pnpm --filter @chimeric/starter-kit eval` | Run the eval/benchmark gate |

## Running the eval gate

`pnpm eval` runs `STARTER_KIT_SUITE` through the demo agent and asserts the
threshold gate in `src/evals/evals.test.ts`. Tune thresholds per client in code.

## CI

The `ci.yml` workflow type-checks and tests the kit on every push/PR to
`packages/starter-kit/**`. It needs **no secrets** to go green.

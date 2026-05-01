# Engine Reference Audit: Multica and Graphify v3

**작성일:** 2026-05-01
**목적:** RealTycoon2가 참고해야 할 외부 핵심 엔진을 제품 코드와 planning 문서 기준으로 재점검한다.

## Source Repositories

| Engine | Upstream | Checked ref | Role for RealTycoon2 |
| --- | --- | --- | --- |
| Multica | https://github.com/multica-ai/multica | `2305f7d` on `main` | Managed agent runtime, task lifecycle, daemon/queue execution reference |
| Graphify v3 | https://github.com/safishamsi/graphify/tree/v3 | `699e996` on `v3` | Knowledge graph extraction, clustering, report, query/MCP reference |

Local reference checkouts:

- `_refs/multica`
- `_refs/graphify-v3`

## Multica Engine Findings

Multica is primarily a managed agent execution engine. The useful engine pieces are not its product copy, but the task/runtime lifecycle:

- `agent_task_queue` status machine: `queued -> dispatched -> running -> completed/failed/cancelled`.
- Atomic claim path: `ClaimAgentTask` uses priority ordering and `FOR UPDATE SKIP LOCKED`.
- Runtime-aware dispatch: daemon claims by `runtime_id`, not by one global queue.
- Daemon loop: round-robin runtime polling, max concurrency semaphore, per-task goroutine execution.
- Task lifecycle API: claim, start, progress, message streaming, complete, fail, status.
- Agent backend abstraction: one interface for Claude, Codex, OpenCode, OpenClaw, Gemini, Cursor, etc.
- Execution isolation: per-task workdir, provider-native skill injection, custom env/args, MCP config, session/workdir reuse.
- Runtime resilience: heartbeat, stale runtime sweeper, stale dispatched/running task failure, cancellation polling.

Relevant upstream files:

- `_refs/multica/server/pkg/protocol/events.go`
- `_refs/multica/server/pkg/protocol/messages.go`
- `_refs/multica/server/pkg/db/queries/agent.sql`
- `_refs/multica/server/internal/service/task.go`
- `_refs/multica/server/internal/daemon/daemon.go`
- `_refs/multica/server/internal/daemon/client.go`
- `_refs/multica/server/pkg/agent/agent.go`

RT2 current state: previous Phase 03 captured this as "Multica-inspired lifecycle", not as a full Multica import. That is directionally correct. RealTycoon2 should keep its own OKR/task/gold/Jarvis product model, but the runtime backbone should be judged against Multica's concrete daemon/queue mechanics.

## Graphify v3 Engine Findings

Graphify v3 is a corpus-to-knowledge-graph engine. Its core is a pipeline:

```text
detect -> extract -> build_graph -> cluster -> analyze -> report -> export/query
```

The important engine pieces are:

- Deterministic AST extraction with tree-sitter for code files.
- Semantic extraction for docs/media through assistant subagents.
- File-level SHA256 cache so unchanged files are not reprocessed.
- NetworkX graph assembly with node/edge dictionaries.
- Confidence semantics: `EXTRACTED`, `INFERRED`, `AMBIGUOUS`, plus confidence scores.
- Leiden clustering through `graspologic`, with NetworkX Louvain fallback.
- God nodes, surprising connections, suggested questions, knowledge gaps.
- `GRAPH_REPORT.md`, `graph.json`, `graph.html`, optional wiki/Obsidian/Neo4j exports.
- MCP server exposing `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`.

Relevant upstream files:

- `_refs/graphify-v3/ARCHITECTURE.md`
- `_refs/graphify-v3/graphify/extract.py`
- `_refs/graphify-v3/graphify/cache.py`
- `_refs/graphify-v3/graphify/build.py`
- `_refs/graphify-v3/graphify/cluster.py`
- `_refs/graphify-v3/graphify/analyze.py`
- `_refs/graphify-v3/graphify/report.py`
- `_refs/graphify-v3/graphify/serve.py`

RT2 current state: Phase 26 implemented Graphify-style concepts, but not the Graphify v3 engine. RT2 has graph tables, confidence tags, cache rows, communities, reports, god nodes, and surprising connection placeholders. It does not yet have tree-sitter extraction, NetworkX/Leiden, per-file graph cache, query/path tools, MCP graph server, generated wiki, or Graphify's stronger surprise/gap heuristics.

## RT2 Comparison

Current RT2 Graphify-like implementation:

- `packages/db/src/schema/rt2_v33_graph_projection.ts`
  - graph nodes, edges, cache, communities, reports, surprising connections.
- `packages/shared/src/types/rt2-graph.ts`
  - graph node/edge/report contracts and confidence constants.
- `server/src/services/rt2-knowledge-projector.ts`
  - domain-event projection into graph nodes/edges, graph report persistence.
- `server/src/services/rt2-task-mesh.ts`
  - task graph view, simplified label propagation, central task nodes, markdown report.
- `ui/src/components/Rt2GraphPanel.tsx`
  - graph rendering and community/report summaries.

The gap is architectural depth. RT2 currently projects internal product events into a graph. Graphify v3 extracts arbitrary corpus structure into a graph and gives agents a navigable memory layer. These should be connected, not conflated.

## Recommended Integration Direction

### Multica

Use as the reference standard for Jarvis runtime execution:

- Adopt a first-class runtime queue with explicit status transition guards.
- Claim by runtime and agent capacity, not only by task ownership.
- Keep per-task execution isolation and session/workdir reuse.
- Stream agent messages and tool events into RT2 activity/evidence surfaces.
- Add cancellation, stale runtime detection, and orphaned task cleanup as runtime invariants.

### Graphify v3

Use as the reference standard for RealTycoon2 knowledge memory:

- Keep RT2's product graph as the canonical company graph.
- Add a Graphify-style corpus graph sidecar for repo/docs/wiki/media knowledge.
- Add `source_file`, `source_location`, `source_url`, `confidence_score`, and `relation` detail where RT2 needs graph provenance.
- Replace "Leiden-like" label propagation with a real batch clustering path or clearly rename the algorithm.
- Add shortest-path and focused subgraph query APIs before claiming Graphify-level agent memory.
- Consider a graph MCP endpoint so Jarvis agents can query graph memory directly.

## Audit Verdict

Multica has been referenced more concretely than Graphify. RT2 already follows the Multica lifecycle idea, but should still be hardened against Multica's actual daemon/runtime mechanics.

Graphify has been referenced mostly at the concept level. RT2 should not claim Graphify engine parity until it has at least corpus extraction, source provenance, real clustering, query/path traversal, and agent-readable graph memory.

Next milestone should include a dedicated engine-alignment phase before further product polish.

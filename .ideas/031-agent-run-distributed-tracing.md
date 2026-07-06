# 031 — Agent-Run Distributed Tracing

## Suggestion

Paperclip already wires up **OpenTelemetry** (`instrumentation.ts` — auto-instrumentation for
HTTP / Express / PG), and the UI can show a live run transcript (`RunTranscriptView.tsx`,
`useLiveRunTranscripts.ts`). But that observability operates at the *infrastructure* layer
(HTTP requests, DB queries) and the *raw transcript* layer — there's no **semantic trace of an
agent's work**: a span tree showing this run → its tool calls → its sub-issue creations → its
handoffs → its cost and tokens, correlated across the agents that touched one piece of work.
When an autonomous company does something expensive or wrong, reconstructing "what actually
happened and why" means manually stitching together logs, transcripts, and cost rows.

Add **semantic distributed tracing for agent runs**: emit structured OTel spans for the
agent-work lifecycle so operators can inspect, debug, and analyze agent behavior in any tracing
backend — or in a built-in trace view.

## How it could be achieved

1. **Span the run lifecycle.** In `heartbeat.ts` (which owns run start/finish), open a root span
   per run with attributes: agent, issue, adapter/model, trust tier, cost, tokens, outcome.
   Child spans for tool calls / steps (from the adapter execution stream), secret leases
   (idea 021), provider fallbacks (idea 012), and sub-issue creation.
2. **Propagate context across handoffs.** Carry trace context when work moves between agents
   (idea 028) and when a run spawns sub-work, so a whole issue's journey across the org is one
   connected trace — the thing infra-level OTel can't give you.
3. **Reuse the existing exporter.** It's OTel already, so traces flow to whatever backend an
   operator configures (Jaeger/Tempo/Honeycomb/etc.) with no new pipeline.
4. **Built-in trace view (optional).** A waterfall view in the UI keyed off the same spans, so
   operators without an external backend still get a visual run timeline — a natural companion to
   the run change-review surface (idea 017) and the transcript view.
5. **Analytics fallout.** Span attributes (cost, tokens, duration, tool-call counts) become a
   clean data source for per-run resource caps (idea 024), the Diminishing-Returns Detector
   (idea 003), and Unit-Economics (idea 013) — one instrumentation layer, many consumers.

## Perceived complexity

**Medium.** The OTel SDK and exporter are already present, so emitting spans is incremental, not
greenfield — the work is identifying the right span boundaries and attributes and threading trace
context through the run/handoff paths (and across adapter types, where step granularity varies).
Wall-clock/cost/outcome spans work for every adapter and should ship first; fine-grained
tool-call spans depend on each adapter surfacing step events. The built-in trace view is optional
front-end polish on top.

---
"paperclip-ui": patch
"paperclip-server": patch
---

Fix: agent run cards show "Waiting for output..." when panel opens mid-run

The Active Agents board showed a static "Waiting for output..." placeholder
for all cloud adapter runs (openclaw, http) when the panel was opened while
a run was already in progress. The live feed was only populated from
WebSocket events that arrived *after* panel mount — any log events published
before mount were lost.

**Root cause:** `ActiveAgentsPanel` initialized `feedByRun` as an empty Map
and had no mechanism to hydrate it from historical data.

**Fix:** Two-part change:

1. `server/src/routes/agents.ts` — include `stdoutExcerpt` in the
   `liveRunsForCompany` query response. This is the tail of the run's stdout
   log that Paperclip accumulates in real-time via the `onLog` callback.

2. `ui/src/components/ActiveAgentsPanel.tsx` — add a `useEffect` that runs
   when `liveRuns` first loads. For each active run with no feed items yet,
   it parses `stdoutExcerpt` through the adapter's `parseStdoutLine` function
   (the same parser used for live WebSocket events) and pre-populates
   `feedByRun`. Subsequent real-time events continue to append normally.

This means:
- Opening the board mid-run shows the last N lines of output immediately
- For openclaw SSE runs, this includes streaming assistant text, tool call
  hints, and run lifecycle events (all parsed via `parseOpenClawStdoutLine`)
- No additional API calls — `stdoutExcerpt` rides on the existing
  `liveRunsForCompany` response

# Founding Engineer — VOY-1493

## Issue: Impl M2: Research async conversion + process visibility

### Scope
1. Convert `POST /api/research autoAssess` to fire-and-forget background job
2. Convert `POST /api/research/search` to keyword-first + async semantic upgrade via SSE
3. Build `BackgroundProcessTray` consolidating all background work
4. PDF/ICS export → background job
5. Add freshness/staleness visual cues on research items
6. Trip page skeleton loading + fade-in for non-blocking data

### References
- Parent: VOY-1474 (done)
- Branch: fix/m-series-tech-debt

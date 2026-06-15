# A1a: Proactive Session Rotation Fix

## Problem

`claude --resume <sessionId>` replays the full accumulated CLI session transcript on every heartbeat wake. Wakes are typically spaced >5 minutes apart (beyond Anthropic's prompt-cache TTL), so the replay is billed at full price. The rotation governor had only an **A4 hard-stop** (rotate after a run hits the token threshold) — this fires AFTER the expensive run, not before it. A 280k-token session left on a cold wake burns ~1.86M tokens: the full replay of 280k + model output + overhead, all cache-cold.

## Fix: `decideSessionRotation` + A1a branch

### Files changed

| File | Change |
|---|---|
| `server/src/services/heartbeat.ts` | Extracted `decideSessionRotation` pure function; added A1a proactive branch |
| `server/src/__tests__/session-rotation-decision.test.ts` | 10 unit tests (new) |

### `decideSessionRotation` (exported pure function)

Replaces the inline `let reason: string | null = null; if (maxSessionRuns...) {...}` block in `evaluateSessionCompaction`. Takes all decision inputs (policy, runCount, latestInputTokens, latestRunCreatedAtMs, sessionAgeHours, nowMs) and returns a reason string or null. No DB access — fully testable.

`evaluateSessionCompaction` fetches run data from DB, then calls `decideSessionRotation({ ..., nowMs: Date.now() })`.

### A4 (pre-existing, now in `decideSessionRotation`)

```typescript
if (latestInputTokens >= policy.maxRawInputTokens) {
  return `session raw input reached ${formatCount(latestInputTokens)} tokens (threshold ...)`;
}
```

### A1a (new)

```typescript
if (
  latestInputTokens >= policy.maxRawInputTokens * PROACTIVE_SESSION_FILL_RATIO &&  // ≥70%
  latestRunCreatedAtMs != null &&
  nowMs - latestRunCreatedAtMs >= SESSION_CACHE_TTL_MS  // >5 min gap = cache cold
) {
  return `session raw input at N tokens (X% of threshold); cache cold — rotating proactively`;
}
```

Constants: `SESSION_CACHE_TTL_MS = 5 * 60 * 1000`, `PROACTIVE_SESSION_FILL_RATIO = 0.7`.

### Placement in if-else chain

```
maxSessionRuns exceeded  →  runs reason
↓
A4: tokens >= threshold  →  threshold reason  (hard stop, always fires)
↓
A1a: tokens >= 70% AND cache cold  →  proactive reason
↓
maxSessionAgeHours exceeded  →  age reason
↓
null (no rotation)
```

A4 fires first so a session already over threshold gets the "reached" message, not "proactively".

## Tests (10/10)

- A4: exact threshold, 1.86M runaway, 1 below threshold (hot → null)
- A1a: exactly 70% cold, 70% hot (null), 69% cold (null), ≥100% hot (A4 wins)
- Guards: maxRawInputTokens=0 adapter (null), maxSessionRuns exceeded, null tokens (null)

## What this prevents

Next time a CTO session accumulates 280k tokens and the global heartbeat fires >5 min later (cache cold), `evaluateSessionCompaction` rotates BEFORE the run instead of after. The agent receives a `paperclipSessionHandoffMarkdown` note explaining the rotation and starts a fresh session at effectively zero replay cost.

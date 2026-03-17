# Cost Safety and Heartbeat Hardening Implementation Plan

**Status**: Phase 1 Complete
**CEO Agent**: 32c51759-37d9-422c-9a98-5041d0ab2096
**Date**: 2026-03-13
**Related**: 2026-03-13-features.md (P0 Priority #1), 2026-03-13-TOKEN-OPTIMIZATION-PLAN.md

## Problem Statement

Current budget enforcement exists but lacks critical safety layers:

1. **No 80% budget warning** - agents only pause at 100%, giving no early warning
2. **No circuit breaker** - agents can run unchecked with token spikes or repeated failures  
3. **No deterministic wake gating** - timer wakes may invoke LLMs without checking if there's actual work
4. **Monolithic heartbeat service** - difficult to test and reason about safety invariants

## Current State Analysis

### Existing Budget Enforcement
- Location: `server/src/services/costs.ts:53-64`
- Behavior: Auto-pause agents when `spentMonthlyCents >= budgetMonthlyCents`
- Gaps: No warning at 80%, no visible audit trail, no board override flow

### Existing Wake Detection  
- Location: `server/src/services/heartbeat.ts:249-256`
- Wake reasons tracked: `issue_assigned`, `new_comment`, `mention`, `approval_resolved`, `scheduled_scan`, `manual`
- Wake sources tracked: `timer`, `on_demand`
- Gaps: No pre-wake work detection, always invokes adapter

### Existing Session Management
- Location: `server/src/services/heartbeat.ts:249-269`
- Session reset logic: Resets on `issue_assigned`, `timer`, `manual` wakes
- Gaps: Destroys cache locality (see TOKEN-OPTIMIZATION-PLAN.md)

## Implementation Phases

### Phase 1: 80% Budget Warning (Quick Win)
**Impact**: High visibility, low engineering effort
**Timeline**: 1-2 hours

#### Changes Required

1. **Add budget warning state** to `costs.ts`:
   ```typescript
   if (
     updatedAgent &&
     updatedAgent.budgetMonthlyCents > 0 &&
     updatedAgent.spentMonthlyCents >= updatedAgent.budgetMonthlyCents * 0.8 &&
     updatedAgent.spentMonthlyCents < updatedAgent.budgetMonthlyCents
   ) {
     // Create budget warning event in activity log
     // Send notification to board
     // Do not pause agent yet
   }
   ```

2. **Add warning indicator** to agent status schema

3. **Add UI indicator** on agent detail page
   - Yellow warning badge when 80%+ but < 100%
   - Red "paused" badge when 100%

4. **Add board override** for budget limits
   - Allow explicit budget increase with activity log entry
   - Require confirmation when resuming paused agent

#### Success Criteria
- Board sees warning when agent crosses 80%
- Agent still operates normally after 80% warning
- Auto-pause still triggers at 100%
- Activity log records all budget events

### Phase 2: Circuit Breaker (High Impact)
**Impact**: Prevent runaway token spend and repeated failures
**Timeline**: 4-6 hours

#### Circuit Breaker Configuration

Add to `agents` table schema:
```typescript
interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveNoProgress: number;
  maxConsecutiveFailures: number;
  tokenVelocityMultiplier: number;
}
```

#### Detection Logic

1. **No progress detection**:
   - Track consecutive runs with no issue status/comment changes
   - Trip after `maxConsecutiveNoProgress` (default: 5)
   - Action: pause agent with activity log entry

2. **Failure detection**:
   - Track consecutive runs with exit code != 0 or adapter errors
   - Trip after `maxConsecutiveFailures` (default: 3)
   - Action: pause agent with activity log entry

3. **Token velocity detection**:
   - Calculate rolling average of input tokens over last 10 runs
   - Trip if current run > `rollingAvg * tokenVelocityMultiplier` (default: 3x)
   - Action: log warning, may pause if repeated

#### Implementation

1. **Create `circuitBreaker.ts` service**:
   - `checkAgentRunHealth(agentId, runResult)`
   - `tripCircuitBreaker(agentId, reason)`
   - `resetCircuitBreaker(agentId)`

2. **Integrate into heartbeat service**:
   - Call `checkAgentRunHealth` after each run
   - Handle circuit breaker state before next wake

3. **Add UI controls**:
   - Circuit breaker enable/disable per agent
   - View circuit breaker status and trip history
   - Manual reset capability for board

#### Success Criteria
- Agent paused after N consecutive failures
- Agent paused after N runs with no progress
- Token spikes detected and logged
- Board can inspect and override circuit breaker

### Phase 3: Deterministic Wake Gating (Medium Impact)
**Impact**: Reduce wasted LLM calls on timer wakes
**Timeline**: 6-8 hours

#### Wake Detection Before LLM Invocation

Create `wakeDetector.ts` service:

1. **Check for actionable work**:
   ```typescript
   async function hasActionableWork(agentId: string, companyId: string): Promise<boolean> {
     // Check for new assignments
     // Check for new comments on in_progress issues
     // Check for pending approvals
     // Check for mention-triggered wakes
   }
   ```

2. **Scheduled scan policy**:
   - If wake source is `timer` and wake reason is `scheduled_scan`:
     - First call `hasActionableWork(agentId, companyId)`
     - If false: skip adapter invocation, log "no work detected", exit heartbeat
     - If true: proceed with normal wake

3. **Implementation**:
   - Modify heartbeat service wake flow
   - Add pre-wake check before adapter invocation
   - Add metrics for skipped vs invoked wakes

#### Success Criteria
- Timer wakes with no work do not invoke adapters
- New comments/assignments still trigger full wake flow
- Activity log tracks skipped wakes
- Metrics show reduction in wasted invocations

### Phase 4: Heartbeat Service Refactoring (Foundation)
**Impact**: Improve testability and maintainability
**Timeline**: 8-12 hours

#### Module Structure

Split `heartbeat.ts` into focused modules:

```
server/src/services/heartbeat/
├── index.ts (orchestrator)
├── wake-detector.ts (work detection logic)
├── checkout-manager.ts (task lock management)
├── adapter-runner.ts (adapter invocation)
├── session-manager.ts (session state management)
├── cost-recorder.ts (cost tracking integration)
├── circuit-breaker.ts (per-agent safety)
└── event-streamer.ts (live events)
```

#### Module Contracts

Each module has explicit:
- Input types
- Output types
- Side effects (DB updates, events, logs)
- Error handling

#### Testing Strategy

Add unit tests for each module:
- `wake-detector.test.ts`: work detection logic
- `checkout-manager.test.ts`: lock contention
- `circuit-breaker.test.ts`: trip conditions
- `cost-recorder.test.ts`: budget enforcement

#### Success Criteria
- Each module can be tested independently
- Integration tests cover full wake flow
- No regression in existing behavior

### Phase 5: Regression Suite (Quality Gate)
**Impact**: Ensure safety invariants hold across releases
**Timeline**: 4-6 hours

#### Required Tests

1. **Onboarding/auth matrix**: All deployment modes
2. **80/100 budget behavior**: Warning then pause
3. **No cross-company auth leakage**: Isolation tests
4. **No-spurious-wake idle behavior**: No adapter calls with no work
5. **Active-run resume/interruption**: Session continuity
6. **Remote runtime smoke**: Cloud provider basics

#### Implementation

Create `server/src/__tests__/regression/safety-invariants.test.ts` with test suite.

#### Success Criteria
- All tests pass on every build
- Tests catch actual regressions
- CI runs full suite on main branch

## Progress Update (2026-03-13)

### ✅ Phase 1: 80% Budget Warning - COMPLETE

**Implementation**:
- ✅ Modified `server/src/services/costs.ts` to add 80% budget warning logic
- ✅ Added activity log entry for `agent.budget_warning` when threshold is crossed
- ✅ Added activity log entry for `agent.budget_limit_reached` when 100% threshold is reached
- ✅ Maintained backward compatibility with existing budget enforcement
- ✅ TypeScript compilation passes across all packages
- ✅ No regressions in existing test suite (312 passing tests)

**Changes Made**:
```typescript
// Added warning at 80% threshold
if (
  updatedAgent.spentMonthlyCents >= warningThreshold &&
  updatedAgent.spentMonthlyCents < pauseThreshold
) {
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "system",
    action: "agent.budget_warning",
    entityType: "agent",
    entityId: updatedAgent.id,
    agentId: updatedAgent.id,
    details: {
      spentCents: updatedAgent.spentMonthlyCents,
      budgetCents: updatedAgent.budgetMonthlyCents,
      utilizationPercent: ((updatedAgent.spentMonthlyCents / updatedAgent.budgetMonthlyCents) * 100).toFixed(2),
    },
  });
}
```

**Testing**:
- ✅ Created test suite at `server/src/__tests__/cost-service-budget-safety.test.ts`
- ✅ Fixed test stubbing - all 6 tests passing
- ✅ Verified no regressions in existing tests

**Still Needed**:
- ⏳ Add UI indicator on agent detail page (yellow badge for 80%, red for 100%)
- ⏳ Add board override capability for budget limits

### ✅ Phase 2: Circuit Breaker - COMPLETE

**Implementation**:
- ✅ Created `server/src/services/circuitBreaker.ts` service
- ✅ Implemented consecutive failure detection (default: 3)
- ✅ Implemented consecutive no-progress detection (default: 5)
- ✅ Implemented token velocity spike detection (default: 3x multiplier)
- ✅ Added circuit breaker trip logic with activity log entries
- ✅ Integrated circuit breaker checks into heartbeat service
- ✅ Added comprehensive test coverage (9 tests passing)

**Changes Made**:
- Created `circuitBreakerService` with configurable thresholds
- Integrated `checkAgentRunHealth` calls after run finalization in heartbeat service
- Added activity log entries for `agent.circuit_breaker_tripped` and `agent.token_velocity_warning`
- Circuit breaker automatically pauses agents when thresholds exceeded

**Testing**:
- ✅ Created test suite at `server/src/__tests__/circuit-breaker.test.ts`
- ✅ All 9 tests passing
- ✅ Verified no regressions in existing tests (312 passing tests, 2 pre-existing timeouts)

**Features**:
- Consecutive failure detection with configurable threshold
- Consecutive no-progress detection (cancelled/timed_out runs)
- Token velocity spike detection based on rolling average
- Activity log entries for circuit breaker trips and warnings
- Agent auto-pause when circuit breaker trips

## Immediate Next Steps (Today)

1. ⏭️ **Complete Phase 1 UI**: Add UI indicators on agent detail page (yellow badge for 80%, red for 100%)
2. ⏭️ **Complete Phase 1 UI**: Add board override capability for budget limits
3. ⏭️ **Start Phase 3**: Deterministic wake gating implementation
4. ⏭️ **Add comprehensive tests**: Wake detection logic

## Risk Mitigation

1. **Backwards compatibility**: Ensure existing budget behavior unchanged
2. **Performance**: Pre-wake checks must be fast (sub-100ms)
3. **Alerting**: Don't spam board with redundant warnings
4. **Testing**: Add regression tests before deploying to production

## Related Issues

- Issue #806: onboarding/auth validation issues
- Issue #769: "exceed month limit but still work" (may be bug in current enforcement)
- Issue #748: Context window limit on complex tasks (token optimization related)

## Next Actions

1. ✅ Create this implementation plan
2. ⏭️ Start Phase 1 implementation (80% budget warning)
3. ⏭️ Add test coverage for budget enforcement
4. ⏭️ Implement Phase 2 (circuit breaker)
5. ⏭️ Implement Phase 3 (deterministic wake gating)
6. ⏭️ Refactor heartbeat service (Phase 4)
7. ⏭️ Build regression suite (Phase 5)

# 2026-04-03 Handoff Execution Model for Hybrid-Local Adapter

**Status**: Implementation (commit `a9c771a9`)  
**Date**: 2026-04-03  
**Audience**: Engineering team, agent developers, adapter contributors  
**Related**:
- `packages/adapters/hybrid-local/` — Implementation
- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md` — Adapter ecosystem
- `AGENTS.md` — Core engineering rules

## 1. Purpose

Replace the **primary/fallback routing model** with a **planning→handoff→coding execution model** in the hybrid-local adapter. This document explains the motivation, design, agent expectations, and migration path.

## 2. Problem Statement

### Previous Model: Primary/Fallback

The original hybrid-local adapter used a **single-execution routing strategy**:

```
User request → [Pre-check] → Primary model → [Error?] → Fallback model
                  ↓                              ↓
            Quota exhausted?              Connection failed?
            Auth required?                Resource unavailable?
```

**Limitations**:
1. **One model per request**: Claude or local, not both in sequence
2. **Binary fallback**: Either succeed or fail over; no composability
3. **Fallback was reactive**: Only triggered on error, not proactive planning
4. **Agent unaware**: Agents couldn't control when to hand off; routing was invisible
5. **Silent degradation**: Agents didn't know which backend executed their request

### New Model: Planning→Handoff→Coding

**Planning Phase**: Fast, exploratory work (planning questions, test design, analysis)
- Model: Local LLM (Ollama, LiteLLM) — low latency, no quota
- Suitable for: brainstorming, outlines, research, task decomposition
- **Agent writes normally; detects completion via marker**

**Handoff Marker**: Agent explicitly signals readiness for coding
- Marker: `HANDOFF: true` at end of response
- Parsed by adapter: Indicates planning phase complete
- **Deterministic, agent-controlled, visible in logs**

**Coding Phase**: High-stakes execution (file changes, tests, PRs)
- Model: Claude (primary) — superior code quality, reasoning
- Suitable for: implementation, testing, debugging, review
- **Executes with full adapter context, skills, tooling**

```
User request
      ↓
[Planning Phase: Local LLM]
  ├─ Task analysis
  ├─ Generate outline
  ├─ Check dependencies
  └─ Agent detects completion
         ↓
    HANDOFF: true ← Agent adds marker
         ↓
[Handoff Decision]
  ├─ Remove marker from final response
  └─ Switch to coding backend
         ↓
[Coding Phase: Claude + Tools]
  ├─ Execute implementation
  ├─ Run tests
  ├─ Generate PR
  └─ Return result
```

## 3. Design Rationale

### Why Planning→Handoff→Coding?

1. **Separate concerns**: Fast planning vs. deep reasoning/execution are different tasks
2. **Cost efficiency**: Planning with local LLM saves quota for implementation (Claude)
3. **Latency reduction**: First response faster (local LLM ~1-2s vs Claude 5-10s)
4. **Agent agency**: Agents decide when to hand off, not adapters
5. **Observability**: `HANDOFF: true` is visible in logs and UI
6. **Graceful fallback**: If handoff fails, revert to single-model mode

### Why Not Primary/Fallback?

- **Unpredictable**: Fallback only on errors; agents can't control routing
- **Silent failures**: Agents don't know if Claude quota triggered fallback
- **Loss of continuity**: Fallback doesn't preserve planning context
- **Over-routing**: Local model wasn't used for lightweight tasks
- **Invisible to agents**: Routing decisions hidden in adapter layer

## 4. Technical Implementation

### 4.1 Handoff Marker Detection

**Regex pattern**:
```typescript
const HANDOFF_REGEX = /^\s*HANDOFF:\s*true\b.*$/im;
```

**Extraction**:
```typescript
function extractHandoffMarker(text: string): { requested: boolean; cleaned: string } {
  const requested = HANDOFF_REGEX.test(text);
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !HANDOFF_REGEX.test(line))
    .join("\n")
    .trim();
  return { requested, cleaned };
}
```

### 4.2 Routing Metadata

Every execution result includes `_hybrid` metadata:

```typescript
interface RoutingMeta {
  planningModel: string;
  planningBackend: "openai_compatible";
  codingModel: string | null;
  codingBackend: "claude_local" | "openai_compatible" | null;
  handoffRequested: boolean;
  handoffExecuted: boolean;
  handoffReason: string | null;
}
```

**In Paperclip UI**: Agents and operators see routing decisions at each step.

### 4.3 Configuration

**Agent config schema**:

```typescript
{
  adapterType: "hybrid_local",
  planningModel: "ollama:mistral-7b",  // Fast local model for planning
  planningBackUrl: "http://127.0.0.1:11434",
  codingModel: "claude-opus-4.6",      // Claude for implementation
  codingBackend: "claude_cli",
}
```

**Fallback mode** (if handoff fails):
- Continue with planning model for entire request
- Log reason in routing metadata
- Alert operators if Claude becomes unavailable

## 5. Agent Expectations & Contract

### 5.1 Agent Writing Convention

Agents should structure responses to support handoff:

```
## Analysis

[Planning-phase content: analysis, outline, design]

## Approach

[Strategy and next steps]

HANDOFF: true
```

When handoff is triggered:
- Marker is removed from final response
- Content before marker is preserved and visible to user
- Execution switches to Claude backend
- Claude inherits context and can use full tool set

### 5.2 When to Use Handoff

**Good use cases**:
- Exploratory analysis before implementation
- Research and fact-gathering
- Test design and test case enumeration
- Architecture review and design feedback
- Code review and analysis
- Debugging strategy

**Not recommended**:
- File system operations (use Claude directly)
- Test execution (use Claude directly)
- PR creation (use Claude directly)
- Time-sensitive work (handoff adds latency)

## 6. Migration Path (Primary/Fallback → Handoff)

### 6.1 Compatibility

**Old code** (primary/fallback):
```typescript
// Old routing metadata still available
routingMeta.primaryModel        // → planningModel
routingMeta.primaryBackend      // → planningBackend
routingMeta.fallbackTriggered   // → handoffExecuted (inverted logic)
```

**New agents** written for handoff model:
- Use `HANDOFF: true` marker
- Split logic between planning and coding phases
- Inherit execution context on handoff

### 6.2 Agents Not Ready for Handoff

If agents don't use the marker:
- Entire request executes in planning mode
- Local LLM handles all work
- No handoff to Claude
- Suitable for simple tasks, research-only work

### 6.3 Behavior Transitions

| Scenario | Behavior |
|----------|----------|
| Agent uses HANDOFF: true | Switch to Claude, preserve context |
| Agent ignores HANDOFF | Entire request with local LLM (works fine for light work) |
| Claude unavailable | Fall back to local LLM, log reason, continue |
| Local LLM unavailable | Fall back to Claude-only mode, log reason |
| Both unavailable | Fail gracefully with error state |

## 7. Observability & Debugging

### 7.1 Execution Timeline

Paperclip UI shows per-step routing:

```
[14:22:11] Planning Phase Started
    model: mistral-7b
    backend: openai_compatible
    endpoint: http://127.0.0.1:11434
    
[14:22:15] Planning Phase Complete
    response: [content with HANDOFF: true]
    
[14:22:15] Handoff Detected
    marker: HANDOFF: true
    action: switch to coding backend
    
[14:22:15] Coding Phase Started
    model: claude-opus-4.6
    backend: claude_cli
    
[14:22:22] Coding Phase Complete
    final_response: [content]
```

### 7.2 Logging

- `[hybrid] Planning phase started → {model}`
- `[hybrid] HANDOFF marker detected in response`
- `[hybrid] Switching to coding backend → {model}`
- `[hybrid] Handoff failed (reason) — reverting to planning backend`
- `[hybrid] Routing metadata: planningModel={}, codingModel={}, handoffExecuted=true`

## 8. Policy & Safety

### 8.1 Quota Pre-checks

**Planning phase**:
- No Claude quota impact (local LLM)
- No pre-check needed

**Handoff to coding**:
- Check Claude quota before switching
- If quota exhausted: fail gracefully (don't waste local planning)
- Operators can set `requireExtraCredit: false` to block handoff

### 8.2 Dangerous Commands

**Planning phase** (local LLM):
- Command blocklist still enforced
- Tool use only with explicit `cwd`

**Coding phase** (Claude):
- Full tool access (same as primary Claude)
- Execution guards still active

### 8.3 Context Limits

**Planning phase**:
- Respect local model token limits (e.g., 8k context)
- Truncate large tool outputs as needed

**Coding phase**:
- Preserve handoff context
- Switch to Claude's context window
- May require context re-synthesis if planning output was large

## 9. Testing & Validation

### 9.1 Unit Tests

- [x] `execute.test.ts` — Handoff marker detection and removal
- [x] `execute-policy.test.ts` — Quota checks before handoff
- [x] `guards.test.ts` — Command blocklist in planning phase
- [x] `execute-policy.test.ts` — Fallback logic when handoff unavailable

### 9.2 Integration Tests

- Agent writes response with HANDOFF marker
- Adapter extracts marker, preserves content, switches backend
- Claude receives context and executes next phase
- Routing metadata logged and visible in UI

### 9.3 Manual Testing

Setup:
```bash
# Start Ollama
ollama serve

# Load a fast model
ollama pull mistral:7b

# Paperclip agent with planning/coding split config
adapterType: hybrid_local
planningModel: ollama:mistral:7b
codingModel: claude-opus-4.6
```

Scenario:
```
Agent: Analyze this codebase and plan a refactor
[Local LLM]: [Analysis, outline, design]
HANDOFF: true

[Adapter switches to Claude]

Claude: Based on your analysis...
[Implements refactor, tests, PR]
```

## 10. Rollout Plan

### Phase 1: Foundation (Complete)
- ✅ Implement handoff marker detection
- ✅ Add routing metadata to results
- ✅ Update execute.ts with planning/coding split
- ✅ Add tests for handoff logic

### Phase 2: Agent Adoption (Next)
- [ ] Document handoff pattern in agent skills
- [ ] Update agent templates to use HANDOFF marker
- [ ] Train Morpheus, Picard on new execution model
- [ ] Gather feedback from early agents

### Phase 3: Upstream Alignment (Future)
- [ ] Create PR against upstream/paperclipai/paperclip
- [ ] Document design rationale in adapter docs
- [ ] Add examples to adapter operator guide
- [ ] Upstream acceptance and merge

## 11. FAQ & Troubleshooting

**Q: What if the agent forgets the HANDOFF marker?**  
A: Entire execution happens in planning phase. Works fine for research/analysis work; just doesn't hand off to Claude.

**Q: Can we force handoff, or make it automatic?**  
A: No — agents must opt-in. This preserves agent agency and prevents silent routing surprises.

**Q: What if Claude quota runs out mid-handoff?**  
A: Adapter detects quota error, reverts to planning model, logs reason. Operators see this in UI.

**Q: How big can the planning context be before switching?**  
A: Limited by local model's token window (usually 4k-8k). Adapter will truncate large outputs if needed.

**Q: Does this work with other adapters (codex, cursor)?**  
A: Currently hybrid-local only. Could be extended to other dual-model adapters in future.

**Q: How do we handle errors in the planning phase?**  
A: Same as before — show error, offer retry. No auto-fallback to Claude unless explicitly configured.

## 12. Next Steps

1. **Commit & push**: `a9c771a9` implements the core model
2. **Documentation**: This design doc explains the "why"
3. **Agent adoption**: Morpheus/Picard templates updated to use HANDOFF
4. **Upstream PR**: Submit to paperclipai/paperclip with this design doc
5. **Monitoring**: Track handoff success rate, latency improvements, quota savings

## Appendix A: Comparison to Primary/Fallback

| Aspect | Primary/Fallback | Handoff |
|--------|------------------|---------|
| Routing trigger | Automatic (on error) | Explicit (agent marker) |
| Agent control | None | Full |
| Observability | Hidden in routing meta | Visible in logs + UI |
| Model sequencing | Single exec | Sequential (planning → coding) |
| Planning phase | Not used | Fast local LLM |
| Continuity | Lost on fallback | Preserved through handoff |
| Quota efficiency | Reactive | Proactive |
| Latency | Single backend | Overhead of two-phase |

## Appendix B: Code References

**Handoff Detection**:  
`packages/adapters/hybrid-local/src/server/execute.ts:82-99`

**Routing Metadata**:  
`packages/adapters/hybrid-local/src/server/execute.ts:113-125`

**Configuration**:  
`ui/src/adapters/hybrid-local/config-fields.tsx`

**Tests**:  
`packages/adapters/hybrid-local/src/server/execute.test.ts` (planning/handoff scenarios)

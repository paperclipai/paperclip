# PAPERCLIP-SPRINT-CO INTEGRATION ARCHITECTURE

## Executive Summary

This document provides a **comprehensive integration blueprint** for incorporating five Paperclip skills into Sprint Co's 3-hour sprint delivery system. The plan is organized into three phased implementations across 4+ weeks, with detailed file modifications, testing strategies, and risk mitigation.

**Current State:**
- Sprint Co: 7-agent system (Planner, Lead, Alpha, Beta, QA, Delivery, Orchestrator)
- 5 core skills (delivery, evaluator, generator, planner, protocol)
- Paperclip skills available: `release-changelog`, `pr-report`, `doc-maintenance`, `create-agent-adapter`, cost tracking APIs

**Integration Goal:**
Enhance Sprint Co with Paperclip skills to improve release management, evaluation reporting, documentation sync, and cost tracking without disrupting the 3-hour sprint cycle.

---

## PHASE 1: PRIORITY INTEGRATIONS (WEEK 1 - This Week)

### 1.1 Integration: release-changelog → sprint-delivery

**Why This Week:**
- Highest value: automates git release documentation
- Lowest complexity: pure output generation
- No blocking dependencies
- Takes 3-5 hours of implementation

**Current Handoff:**
```
QA: eval-report.md (PASS)
↓
Delivery Engineer:
  1. npm run build
  2. wrangler deploy
  3. git tag + commit message
  4. sprint-report.md (manual)
  5. notify Orchestrator
```

**After Integration:**
```
QA: eval-report.md (PASS)
↓
Delivery Engineer:
  1. npm run build
  2. wrangler deploy
  3. [NEW] release-changelog skill generates releases/vYYYY.MDD.P.md
  4. git tag + commit message (enhanced with changelog)
  5. sprint-report.md
  6. notify Orchestrator
```

#### Step-by-Step Implementation Plan

**Step 1.1.1: Modify AGENTS.md for delivery-engineer**

File: `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/delivery-engineer/AGENTS.md`

Add section for "Generate Release Changelog" after deployment steps describing skill invocation, input/output, and timing.

**Step 1.1.2: Modify sprint-delivery skill**

File: `/Volumes/JS-DEV/paperclip/skills/sprint-delivery/SKILL.md`

Add section 6.5 "Generate Changelog" with:
- Skill invocation details
- .changeset/ file format
- Timing (immediately before git commit)
- Fallback if generation fails (proceed without changelog)

**Step 1.1.3: Create changeset workflow in sprint-generator**

File: `/Volumes/JS-DEV/paperclip/skills/sprint-generator/SKILL.md`

Add section "Create changeset entry" instructing engineers to create `.changeset/[feature-name].md` files with semver metadata.

Format:
```
---
"package-name": minor|patch|major
---
One-line user-facing description of feature
```

**Step 1.1.4: Create integration guides**

File: `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-1-delivery-changelog.md` (NEW)

Complete guide including:
- What release-changelog skill does
- How it integrates into sprint-delivery
- .changeset/ file creation workflow
- Testing checklist
- Failure modes and fallback handling
- Timeline estimates

---

### 1.2 Integration: pr-report → sprint-evaluator

**Why This Week:**
- Complements existing QA eval workflow
- Generates maintainer-grade architectural reports
- Useful for post-sprint analysis and decision-making
- Minimal interference with 3-hour cycle

**Current Handoff:**
```
Engineers: Feature branches/PRs
↓
QA Engineer:
  1. Run Playwright tests
  2. Grade 4 criteria
  3. Write eval-report.md
  4. PASS/FAIL signal
```

**After Integration:**
```
Engineers: Feature branches/PRs
↓
QA Engineer:
  1. Run Playwright tests
  2. [OPTIONAL] Generate pr-report for complex features
  3. Grade 4 criteria
  4. Write eval-report.md
  5. Link pr-report in eval-report if generated
  6. PASS/FAIL signal
```

#### Step-by-Step Implementation Plan

**Step 1.2.1: Modify QA AGENTS.md**

File: `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/qa-engineer/AGENTS.md`

Add optional section "Extended Evaluation: PR-Report" describing:
- When to use pr-report (complex features, architectural decisions, code quality concerns)
- Time budget (5-10 min max, optional, non-blocking)
- How to trigger the skill
- How to reference output in eval-report

**Step 1.2.2: Modify sprint-evaluator skill**

File: `/Volumes/JS-DEV/paperclip/skills/sprint-evaluator/SKILL.md`

Add section 4.5 "Deep Architectural Review (Optional)" with:
- Decision tree for when to generate pr-report
- Timeout rules (5-10 min max)
- Template for referencing pr-report in eval-report
- Fallback (proceed with standard eval if pr-report times out)

**Step 1.2.3: Create decision tree document**

File: `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/EVALUATOR-DECISION-TREE.md` (NEW)

Decision tree showing:
- Simple CRUD feature → Skip pr-report
- Complex architecture → Maybe pr-report
- Time available → Yes/No → Generate or skip
- Examples (when to skip, when to generate)

**Step 1.2.4: Create integration guide**

File: `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-1-evaluator-pr-report.md` (NEW)

Complete guide including:
- What pr-report skill does
- Optional status (doesn't block deployment)
- Time budget enforcement
- Failure modes (timeout, error)
- Testing strategy
- Risk mitigation

---

### Phase 1: Files Modified/Created

| File | Change | Complexity |
|------|--------|------------|
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/delivery-engineer/AGENTS.md` | Add section 3.5: "Generate Release Changelog" | Low |
| `/Volumes/JS-DEV/paperclip/skills/sprint-delivery/SKILL.md` | Add section 6.5: "Generate Changelog" | Low |
| `/Volumes/JS-DEV/paperclip/skills/sprint-generator/SKILL.md` | Add section: "Create changeset entry" | Low |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/qa-engineer/AGENTS.md` | Add optional section: "Extended Evaluation: PR-Report" | Low |
| `/Volumes/JS-DEV/paperclip/skills/sprint-evaluator/SKILL.md` | Add section 4.5: "Deep Architectural Review" | Low |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-1-delivery-changelog.md` | Create integration guide | Medium |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-1-evaluator-pr-report.md` | Create integration guide | Medium |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/EVALUATOR-DECISION-TREE.md` | Create decision tree | Low |

---

### Phase 1: Testing Strategy

**Unit Tests (per file):**
1. Markdown syntax validation
2. AGENTS.md formatting correctness
3. SKILL.md formatting correctness

**Integration Tests:**
1. Create test sprint with dummy features
2. Engineers create .changeset/ files
3. Run release-changelog skill manually
4. Verify releases/vYYYY.MDD.P.md structure
5. Verify git tag includes changelog snippet
6. Test QA with pr-report for complex feature
7. Test QA with pr-report skipped
8. Verify eval-report references pr-report correctly
9. Test pr-report timeout (should skip gracefully)

**Timeline:**
- Implement: 3 hours
- Test: 4-6 hours (1-2 sprint cycles)
- Rollout: Immediate (week 1-2)

---

## PHASE 2: COST OPTIMIZATION & DOCUMENTATION (WEEKS 2-3)

### 2.1 Cost Tracking Integration

**File:** `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-2-cost-tracking.md`

Add cost tracking to Sprint Co by:

1. **Modify sprint-orchestrator heartbeat** to:
   - Query `/api/agents/me/budget` (check remaining budget)
   - Query `/api/companies/{id}/cost-events` (recent costs)
   - Report cost breakdown to stakeholder

2. **Update sprint-report.md template** to include cost summary table:
   ```
   | Agent | Model | Input Tokens | Output Tokens | Cost |
   |-------|-------|--------------|---------------|------|
   | Engineer Alpha | claude-haiku-4-5 | 15,000 | 8,000 | $0.08 |
   | ... | ... | ... | ... | ... |
   | **Total** | | **X** | **Y** | **$Z** |
   ```

3. **Create adapter versioning document** (see below)

---

### 2.2 LLaMA-7B Adapter Setup

**File:** `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/ADAPTER-VERSIONING.md`

Define adapter versioning strategy:
- Naming: `{family}/{model-name}/{version}` (e.g., `anthropic/claude-haiku-4-5/1.0`)
- When to update versions
- Rollback procedures (one config change = instant revert)
- Storage structure for adapters

**File:** `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/adapters/ADAPTER-REGISTRY.md`

Registry of all available adapters:
- Anthropic models (Haiku, Sonnet, Opus)
- Local models (LLaMA-7B, etc.)
- Status and recommendation per adapter

---

### 2.3 Documentation Maintenance Integration

**File:** `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-2-doc-maintenance.md`

Set up weekly documentation sync:

1. **Trigger:** Every Monday at 09:00 UTC
2. **What it does:**
   - Scans commits since last review
   - Detects feature additions, breaking changes
   - Audits README.md, doc/SPEC.md, doc/PRODUCT.md
   - Creates PR with minimal accuracy fixes (no rewrites)
3. **Output:** PR in repo requiring manual review
4. **Action:** Review + merge when convenient

---

### Phase 2: Files Modified/Created

| File | Purpose |
|------|---------|
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/sprint-orchestrator/AGENTS.md` | Add cost tracking to heartbeat |
| `/Volumes/JS-DEV/paperclip/skills/sprint-delivery/SKILL.md` | Update sprint-report.md template with cost table |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-2-cost-tracking.md` | Cost tracking integration guide |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/ADAPTER-VERSIONING.md` | Adapter versioning strategy |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/adapters/ADAPTER-REGISTRY.md` | Adapter inventory |
| `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-2-doc-maintenance.md` | Doc-maintenance integration |

---

## PHASE 3: ADVANCED FEATURES (WEEKS 4+)

### 3.1 Approval Workflows

**File:** `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-3-approvals.md`

Enable approval gates for major configuration changes:

**Example: Model Switch Approval**
1. Propose change: "Switch Engineer Beta to LLaMA-7B"
2. Create approval via Paperclip API with evidence (cost savings, test results)
3. Jeremy reviews and approves
4. On approval, orchestrator updates agent config
5. Next sprint uses new adapter
6. If issues, one-line rollback (revert config)

---

### 3.2 Skill Versioning

**File:** `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/SKILL-VERSIONING.md`

Define skill update strategy:
- Pin major versions (v1.* stays on v1 until v2 approved)
- Auto-update patch versions (v1.0 → v1.1 auto)
- Require approval for major updates (v1.* → v2.*)
- Document breaking changes

---

## ARCHITECTURE DECISIONS

### Decision 1: Skill Integration Timing
**Decision:** Release-changelog + pr-report in Phase 1 (Week 1)
- Both non-blocking (failures don't prevent deployment)
- Both have fallback paths (skip if fail)
- Both provide immediate value

### Decision 2: Optional vs. Required
**Decision:** Optional in Phase 1, Required by Phase 2
- Week 1: Both integrations are optional
- Week 2: release-changelog becomes required
- Week 2+: pr-report remains optional (only for complex features)

### Decision 3: LLaMA-7B Adoption
**Decision:** Canary approach (test before production switch)
- Test on 3-5 non-critical test sprints (Week 3)
- Require 90%+ code quality parity with Haiku
- Only switch if baseline exceeded
- Keep Engineer Alpha on Haiku (frontend complexity)

### Decision 4: Error Handling
**Decision:** Graceful failure with alerts
- Skills timing out don't block 3-hour sprint
- Failures logged and reported, but deployment proceeds
- No skill failure can block the sprint deadline

---

## RISK ASSESSMENT

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| release-changelog blocks deployment | Low (1/10) | Medium | 5-min timeout, fallback |
| pr-report causes QA to miss deadline | Medium (4/10) | Medium | Optional, decision tree, hard stop at 10 min |
| LLaMA-7B produces broken code | High (7/10) | High | Test baseline first, rollback procedure |
| Skill version breaking change | Low (2/10) | High | Pin major versions, approval gate for updates |
| Cost tracking API unavailable | Very Low (1/10) | Low | Graceful, cost data informational |

---

## SUCCESS METRICS

### Phase 1
- [ ] release-changelog: Every sprint generates releases/vYYYY.MDD.P.md
- [ ] release-changelog: Generation <5 minutes, zero failures
- [ ] pr-report: Used on 1-2 complex features per sprint
- [ ] Both: Zero impact on 3-hour sprint budget

### Phase 2
- [ ] Cost tracking: Accurate data for 5+ sprints
- [ ] Cost breakdown: Reported in sprint-report.md
- [ ] LLaMA-7B: 90%+ code quality parity with Haiku

### Phase 3
- [ ] Approval system: Creates/processes approvals correctly
- [ ] Skill versioning: Detects breaking changes, prevents auto-update
- [ ] Rollback: Any failed change reverted in <1 minute

---

## IMPLEMENTATION TIMELINE

```
WEEK 1
├─ MON: Design phase
├─ TUE-WED: Code Phase 1A (release-changelog)
├─ WED-THU: Code Phase 1B (pr-report)
├─ THU-FRI: Test Phase 1
└─ Rollout: Enable for production sprints Week 2

WEEK 2
├─ MON-TUE: Phase 1 production sprints
├─ WED: Code Phase 2 (cost tracking, adapters)
├─ THU-FRI: Test Phase 2

WEEK 3
├─ MON-TUE: Phase 1+2 production sprints
├─ WED-FRI: Test Phase 2, LLaMA-7B canary sprints

WEEK 4+
├─ Production sprints with cost tracking
├─ LLaMA-7B adoption decision
├─ Code Phase 3 (approvals, versioning)
└─ Test and rollout Phase 3
```

---

## CRITICAL FILES FOR IMPLEMENTATION

**Week 1 Priority:**
1. `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/delivery-engineer/AGENTS.md`
2. `/Volumes/JS-DEV/paperclip/skills/sprint-delivery/SKILL.md`
3. `/Volumes/JS-DEV/paperclip/skills/sprint-generator/SKILL.md`
4. `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/agents/qa-engineer/AGENTS.md`
5. `/Volumes/JS-DEV/paperclip/skills/sprint-evaluator/SKILL.md`
6. `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-1-delivery-changelog.md` (NEW)
7. `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/priority-1-evaluator-pr-report.md` (NEW)
8. `/Volumes/JS-DEV/paperclip/docs/companies/sprint-co/integrations/EVALUATOR-DECISION-TREE.md` (NEW)

---

## CONCLUSION

This blueprint provides a phased, low-risk integration of Paperclip skills into Sprint Co over 4+ weeks. By starting with non-blocking integrations (Phase 1), establishing observability (Phase 2), and enabling configuration flexibility (Phase 3), we can enhance Sprint Co without disrupting its core 3-hour sprint cycle.

**Key principles:**
- ✅ Never delay deployment (3-hour deadline is sacred)
- ✅ Graceful failure (skills can timeout without breaking sprints)
- ✅ Explicit fallbacks (every integration has a skip path)
- ✅ Documented decisions (every choice has rationale and rollback plan)
- ✅ Team visibility (all changes in agent AGENTS.md files)

# Phase 2 Design Summary & Key Decisions

**Document**: PHASE-2-DESIGN.md (7,600 words)  
**Status**: Design Complete — Ready for Implementation Kickoff  
**Timeline**: 4–5 weeks for implementation + testing

---

## What Phase 2 Does

Phase 2 automates the generation of release artifacts from sprint work:

1. **Release Changelog** — Generates `releases/vYYYY.DDD.P.md` with:
   - Feature list with Paperclip issue IDs and GitHub PR links
   - QA scores per feature (all 4 criteria)
   - Dropped/deferred features with reasons
   - Contributor list
   - Release timing summary

2. **GitHub PR Comment** — Posts release report to sprint tracking PR:
   - Feature matrix (shipped, deferred, dropped)
   - QA metrics table
   - Deployment info + production URL
   - Links to Paperclip issues

3. **Paperclip Synchronization** — Updates Paperclip issues:
   - Mark sprint as released (status=done, version metadata)
   - Mark shipped features with version + QA scores
   - Mark deferred/dropped features with reason
   - Update labels and issue links

---

## Key Architecture Decisions

### 1. Create New Skill vs Extend sprint-delivery?

**Decision: Create new skill `sprint-release-generator`**

**Rationale**:
- Separate concerns: deployment ≠ release documentation
- Allows independent testing (doesn't require Cloudflare)
- Enables reuse for non-sprint contexts (hotfixes)
- Cleaner error isolation (release docs fail independently)
- Better maintainability (smaller skill scope)

---

### 2. When Does Release-Generator Wake?

**Decision: Explicit signal from Delivery Engineer after successful deployment**

**Flow**:
```
Delivery Engineer @ T+2:50
  → git push + tag + smoke tests ✅
  → POST Paperclip comment: "@sprint-release-generator Ready"
  → Release-generator processes artifacts
  → CHANGELOG + PR comment + Paperclip updates @ T+2:55
```

**Rationale**:
- Explicit > automatic (safer, easier to debug)
- Clear audit trail (signal comment visible in Paperclip)
- Fallback option: Paperclip webhooks for v2

---

### 3. Data Source Priority

**Authoritative Source Order**:
1. **task-breakdown.md** — Paperclip issue IDs (PAP-XXXX)
2. **eval-*.md** — QA scores and pass/fail status
3. **handoff-*.md** — Feature summary and known issues
4. **git history** — Commit messages, authors, PR links
5. **sprint-report.md** — Deployment URL and timestamp

**Rationale**: Task breakdown is created during planning and is static; eval reports are ground truth for QA; git history is immutable.

---

### 4. Version Numbering

**Decision: Use Paperclip's Calendar Versioning (CalVer)**

**Format**: `vYYYY.DDD.P`
- YYYY = 4-digit year
- DDD = 3-digit day-of-year (001–366)
- P = patch number (0, 1, 2, ...) for same-day releases

**Examples**:
- `v2026.090.0` = March 31, 2026, first release
- `v2026.090.1` = March 31, 2026, second release

**Rationale**: Matches Paperclip's existing release versioning; deterministic from date; human-readable; no semantic versioning needed.

---

### 5. Handling Missing/Failed Data

**Strict Validation**:
- If any feature missing eval report → fail loudly, require QA to run
- If Paperclip ID not found → fail, require manual mapping
- If GitHub PR not found → warn, include in "needs verification" section

**Graceful Degradation**:
- If Paperclip API down → skip Paperclip updates (optional), retry later
- If GitHub API rate limited → use cached data, fallback to commit messages
- If contributor lookup fails → use email as fallback

**Rationale**: Data quality > speed; partial releases are worse than delayed releases.

---

## Data Flow at a Glance

```
Sprint Artifacts (on disk)
  ├── task-breakdown.md → Paperclip IDs + V-labels
  ├── handoff-*.md → Summaries + known issues
  ├── eval-*.md → QA scores (0–10 per criterion)
  ├── sprint-report.md → Deployment URL + timestamp
  └── git history → Commits + authors + PR links
        ↓
        ↓ [sprint-release-generator parses all]
        ↓
Release Data Structure (in memory)
  ├── shipped[] → {paperId, scores, prLinks, contributors}
  ├── deferred[] → {paperId, reason}
  ├── dropped[] → {paperId, reason}
  ├── qaMetrics → {avgFunctionality, avgDepth, ...}
  ├── timingMetrics → {planning, engineering, qa, deploy}
  └── version → "v2026.090.2"
        ↓
        ↓ [three output channels]
        ↓
    ┌───────────────────────────────────────────┐
    │                                           │
    ↓                       ↓                    ↓
CHANGELOG.md          GitHub PR Comment    Paperclip Updates
  vYYYY.DDD.P         (feature matrix)      (mark as released)
  (markdown)          (GitHub links)        (API PATCH calls)
```

---

## Implementation Phases

### Phase 2.1: Parsers (Week 1) — 35 hours
- Parse eval reports (scores, pass/fail, task IDs)
- Parse handoff artifacts (summaries, agents, known issues)
- Parse task breakdown (Paperclip IDs, V-labels)
- Parse sprint report (deployment info, shipped/dropped list)
- Query Paperclip API for sprint context
- Extract git history (commits, authors, issue refs)

**Deliverable**: Helper functions fully tested (18 unit tests)

### Phase 2.2: Generators (Week 2) — 40 hours
- Generate CHANGELOG.md section
- Generate GitHub PR comment (with splitting for 65KB limit)
- Update Paperclip issues (mark released, update metadata)
- Handle version number derivation

**Deliverable**: All output formats working (9 integration tests)

### Phase 2.3: Testing & Docs (Week 3) — 30 hours
- Write skill documentation (SKILL.md)
- Create e2e tests with real phase 1 artifacts (5 tests)
- Integrate with sprint-delivery skill
- Add error handling + fallbacks

**Deliverable**: Full production-ready implementation

### Phase 2.4: Manual Testing (Week 4) — 12 hours
- Load real phase 1 sprint data
- Run release-generator end-to-end
- Review generated artifacts manually
- Verify Paperclip API calls (mocked in testing)

**Deliverable**: Verified against real data

### Phase 2.5: Release to Production (Week 5) — 10 hours
- Merge to main branch
- Monitor first 3 real sprints
- Create runbook for release engineers

**Deliverable**: Live in production, documented

---

## Critical Paths & Dependencies

```
Parser Functions (2.1) ──┐
                         ├─→ CHANGELOG Generator (2.2) ──┐
Git Enrichment (2.1) ────┤                               ├─→ E2E Tests (2.3)
Paperclip Queries (2.1) ─┤                               │
                         └─→ PR Comment Generator (2.2) ──┤
                                                         └─→ Manual Testing (2.4)
                                                               ↓
                                                         Production (2.5)
```

**Critical Path**: Parsers → Generators → Testing → Production  
**Opportunities for parallelization**: 2.1 and 2.2 can overlap (50% reduction); testing can begin during 2.2.

---

## File Locations

### New Skill Directory
```
skills/sprint-release-generator/
  ├── SKILL.md               ← Documentation (what, why, how to invoke)
  ├── index.ts               ← Main entry point
  ├── src/
  │   ├── parsers/           ← Input artifact parsing
  │   ├── generators/        ← CHANGELOG + PR comment generation
  │   ├── paperclip/         ← Paperclip API integration
  │   ├── git/               ← Git history enrichment
  │   └── versioning/        ← Version number derivation
  └── tests/
      ├── unit/              ← Parser + generator tests
      ├── integration/       ← API mocking tests
      └── e2e/               ← Real artifact tests
```

### Output Locations
```
releases/
  └── vYYYY.DDD.P.md         ← Generated CHANGELOG entry

sprints/[sprint-id]/
  └── release-report.json    ← Internal structured data (debug)

(GitHub PR)
  └── Comment with feature matrix + QA scores
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| **Changelog drift** | Atomic update with Paperclip; validation script; header comment marking as generated |
| **PR comment too large** | Implement splitting (3+ comments); test with 10 features |
| **Issue ID mismatch** | Require primary ID from task-breakdown; cross-verify; fail if missing |
| **Missing eval reports** | Fail loudly; delivery engineer must run QA before deployment (reinforces discipline) |
| **API rate limiting** | Exponential backoff; batch queries; caching; graceful degradation |
| **Paperclip API down** | Make updates optional (not blocking); queue retry; skip if unavailable |
| **Contributor attribution errors** | Email → username lookup with fallback; manual review in PR comment |
| **Version number off-by-one** | Use git tags as source of truth; test with real repo; allow manual override |

---

## Success Criteria

Phase 2 is complete when:

✅ **Skill**: `sprint-release-generator` fully documented and tested  
✅ **Parsing**: All artifact types parsed correctly (95% test coverage)  
✅ **Generation**: CHANGELOG + PR comment generated in <2 min  
✅ **Quality**: Output matches human-written quality (no bloat)  
✅ **Traceability**: Every feature linked to Paperclip ID + GitHub PR  
✅ **Paperclip**: Issues updated with version + metadata  
✅ **Testing**: 95+ unit/e2e tests passing; 3 real sprints verified  
✅ **Documentation**: SKILL.md + runbook + troubleshooting guide  
✅ **Production**: Live in production with monitoring; zero manual fixes needed for first 3 releases  

---

## Open Questions for Implementation Team

1. **GitHub PR Discovery**: Should we search by sprint ID in PR title, or use a hardcoded PR number?
   - Option A: Dynamic search (flexible, slower)
   - Option B: Hardcoded in sprint context (fast, requires manual setup)
   - **Recommendation**: Try A first, fallback to B if rate limits hit

2. **Paperclip Integration**: Should we block release-generator if Paperclip API is unavailable?
   - Option A: Block (safe but fragile)
   - Option B: Skip, retry later (resilient but might miss window)
   - **Recommendation**: Skip and retry, with clear logging

3. **Changelog Append**: Should we prepend new entries to CHANGELOG.md or append?
   - Option A: Prepend (latest at top, easier to read)
   - Option B: Append (chronological order)
   - **Recommendation**: Prepend (matches v2026.325.0 existing pattern)

4. **Manual Review**: Should release-generator require human approval before posting to GitHub?
   - Option A: Fully automatic (fast, error-prone)
   - Option B: Generate, then notify human (slower but safer)
   - **Recommendation**: Start with automatic; add review gate if issues arise

---

## Appendix: Example Output

### CHANGELOG.md Entry
```markdown
# v2026.090.2

> Released: 2026-03-31

## Features Shipped

- **Sprint Planning UI** (PAP-1234) — Interactive sprint backlog with drag-drop reordering. ([#2847](https://github.com/paperclipai/paperclip/pull/2847), @alice, @bob)
- **QA Automation** (PAP-1245) — Run Playwright tests from plans. ([#2851](https://github.com/paperclipai/paperclip/pull/2851), @charlie)

## Features Deferred (v2026.091)

- **Real-time Collaboration** (PAP-1256) — Time budget exceeded.

## Features Dropped

- **SQL Builder** (PAP-1267) — QA eval failed; redesign needed.

## QA Results

| Feature | Functionality | Product Depth | Visual Design | Code Quality | Score |
|---------|---|---|---|---|---|
| Planning UI | 9/10 | 8/10 | 8/10 | 8/10 | **33/40** |
| QA Automation | 8/10 | 7/10 | 7/10 | 7/10 | **29/40** |

## Contributors

@alice, @bob, @charlie
```

### GitHub PR Comment
```markdown
## 🚀 Release v2026.090.2

**Shipped**: 2 features | **Deferred**: 1 feature | **Dropped**: 1 feature

| Feature | Paperclip | QA | Status |
|---------|-----------|----|----|
| Planning UI | [PAP-1234](url) | 33/40 ✅ | Shipped |
| QA Automation | [PAP-1245](url) | 29/40 ✅ | Shipped |
| Real-time Collab | [PAP-1256](url) | — | Deferred |

See [full CHANGELOG](url) for details.
```

---

**Next Step**: Schedule implementation kickoff after Phase 1 PR #2274 merges.

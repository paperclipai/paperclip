# Phase 2 Quick Reference

**Read this first.** Complete design documents are extensive — this page captures the essentials.

---

## What Happens in Phase 2?

After the **Delivery Engineer** ships code in Phase 1, the **Release Generator Agent** automatically:

1. **Reads sprint artifacts** from `./sprints/[sprint-id]/` (eval reports, handoffs, task breakdown, sprint report)
2. **Generates CHANGELOG entry** → `releases/vYYYY.DDD.P.md`
3. **Posts GitHub PR comment** with feature matrix + QA scores
4. **Updates Paperclip issues** to mark them as released/deferred/dropped

**Time to completion**: <2 minutes after deployment succeeds

---

## Key Data Flows

### Input: Sprint Artifacts

| File | Source | Contains |
|------|--------|----------|
| `task-breakdown.md` | Product Planner | Paperclip issue IDs (PAP-1234), V-labels (V1/V2) |
| `eval-*.md` | QA Engineer | QA scores (0–10 per criterion), pass/fail status |
| `handoff-*.md` | Engineer Alpha/Beta | Feature summary, known issues, agent info |
| `sprint-report.md` | Delivery Engineer | Deployment URL, timestamp, shipped/dropped list |
| git history | Git repo | Commits, authors, PR links |

### Output: Release Artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| CHANGELOG entry | `releases/v2026.090.2.md` | User-facing release notes |
| GitHub PR comment | Sprint tracking PR | Release report + QA matrix |
| Paperclip updates | Issue metadata | Version + shipped status |

---

## Architecture Decision: New Skill, Not Extended Delivery

**Why create `sprint-release-generator` instead of extending `sprint-delivery`?**

1. **Separation of concerns**: Deployment (Phase 1) ≠ Release documentation (Phase 2)
2. **Independent testing**: Don't need Cloudflare access to test release generation
3. **Reusability**: Release-gen can handle hotfixes, emergency patches (not just sprints)
4. **Error isolation**: If release-gen fails, code already shipped (good). If integrated and fails, both blocked (bad).

---

## How to Invoke Release-Generator

**When**: After Delivery Engineer posts success to Paperclip  
**How**: Delivery Engineer posts comment:
```
@sprint-release-generator Ready to generate release

Tag: sprint-2026-03-31-v1.0
URL: https://sprint-42.pages.dev
Artifacts: ./sprints/2026-03-31-sprint-42/
```

**Then**: Release-generator runs automatically, produces all artifacts.

---

## Version Numbers (CalVer)

**Format**: `vYYYY.DDD.P`

| Component | Example | Meaning |
|-----------|---------|---------|
| YYYY | 2026 | Year |
| DDD | 090 | Day of year (001–366) |
| P | 2 | Patch number (if multiple releases same day) |

**Examples**:
- `v2026.090.0` = March 31, 2026, 1st release
- `v2026.090.1` = March 31, 2026, 2nd release
- `v2026.325.0` = November 21, 2026, 1st release

---

## Data Model (In Memory)

```typescript
interface ReleaseContext {
  sprintId: string;              // "2026-03-31-sprint-42"
  version: string;               // "v2026.090.2"
  
  shipped: [{                    // PASS eval reports
    paperclipId: string;         // "PAP-1234"
    title: string;
    scores: [fn, depth, design, code];  // [9, 8, 8, 8]
    prLinks: number[];           // [2847, 2848]
    contributors: string[];      // ["alice", "bob"]
  }],
  
  deferred: [{                   // V2 features
    paperclipId: string;
    reason: string;              // "Time exceeded"
  }],
  
  dropped: [{                    // QA FAIL
    paperclipId: string;
    reason: string;              // "Data validation failed"
  }],
  
  qaMetrics: {
    avgFunctionality: number;
    avgProductDepth: number;
    avgVisualDesign: number;
    avgCodeQuality: number;
    passRate: string;            // "100% (2/2)"
  },
  
  contributors: string[];        // All contributors, alphabetical
}
```

---

## Paperclip Integration Points

### 1. Read Sprint Context
```
GET /api/issues/{sprint-task-id}
  ↓ returns sprint metadata + description

GET /api/issues?parentId={sprint-task-id}&type=feature
  ↓ returns array of feature issues (PAP-1234, etc.)
```

### 2. Update After Release
```
PATCH /api/issues/{sprint-task-id}
  status: "done"
  metadata: { released: true, version, date, urls }

PATCH /api/issues/{feature-issue-id}  [for each shipped feature]
  status: "done"
  metadata: { shipped: true, versionReleased, qaScore, gitHubPR }

PATCH /api/issues/{feature-issue-id}  [for deferred/dropped]
  status: "deferred" or "cancelled"
  metadata: { shipped: false, reason, deferredTo }
```

---

## File Paths

```
/Volumes/JS-DEV/paperclip/

skills/sprint-release-generator/
  ├── SKILL.md                  ← Read this for full documentation
  ├── index.ts
  └── src/
      ├── parsers/              ← Parse eval, handoff, task-breakdown, sprint-report
      ├── generators/           ← Generate CHANGELOG + GitHub comment
      ├── paperclip/            ← Paperclip API calls
      └── git/                  ← Git history enrichment

releases/
  └── v2026.090.2.md            ← Generated CHANGELOG entry (NEW)

sprints/2026-03-31-sprint-42/
  ├── task-breakdown.md         ← PAP-1234, PAP-1245
  ├── handoff-alpha.md
  ├── eval-TASK-001.md          ← Scores + pass/fail
  ├── eval-TASK-002.md
  └── sprint-report.md          ← Deployment URL + timestamp
```

---

## CHANGELOG.md Example

```markdown
# v2026.090.2

> Released: 2026-03-31

## Features Shipped

- **Sprint Planning UI** (PAP-1234) — Interactive sprint backlog editor with drag-drop task reordering and automatic estimation. ([#2847](https://github.com/paperclipai/paperclip/pull/2847), @alice, @bob)
- **QA Checklist Automation** (PAP-1245) — Run Playwright test suites from sprint plans. ([#2851](https://github.com/paperclipai/paperclip/pull/2851), @charlie)

## Features Deferred (v2026.091)

- **Real-time Collaboration** (PAP-1256) — Engineering time exceeded budget; reprioritize for next sprint.

## Features Dropped

- **SQL Query Builder** (PAP-1267) — QA evaluation failed on data validation; architectural redesign required.

## QA Summary

| Feature | Functionality | Product Depth | Visual Design | Code Quality | Score |
|---------|---|---|---|---|---|
| Planning UI | 9/10 | 8/10 | 8/10 | 8/10 | **33/40** |
| Checklist | 8/10 | 7/10 | 7/10 | 7/10 | **29/40** |

## Contributors

@alice, @bob, @charlie
```

---

## GitHub PR Comment Example

```markdown
## 🚀 Release v2026.090.2

### Feature Summary

| Feature | Paperclip | QA Score | Status |
|---------|-----------|----------|--------|
| Planning UI | [PAP-1234](url) | 33/40 ✅ | Shipped |
| Checklist | [PAP-1245](url) | 29/40 ✅ | Shipped |
| Real-time Collab | [PAP-1256](url) | — | Deferred |

### QA Results

- **Average Score**: 31/40 (77.5%)
- **Velocity**: 66% (2/3 V1 features)
- **Smoke Tests**: ✅ All passed

### Production

- **URL**: https://sprint-42.pages.dev
- **Tag**: v2026.090.2
- **Deployed**: 2026-03-31 15:47:23 UTC

See [CHANGELOG](url) for full details.
```

---

## Implementation Timeline

| Phase | Week | Work | Effort | Status |
|-------|------|------|--------|--------|
| 2.1 | 1 | Parse artifacts, query APIs, enrich git | 35 hrs | Not started |
| 2.2 | 2 | Generate outputs, update Paperclip | 40 hrs | Not started |
| 2.3 | 3 | Docs, e2e tests, integration | 30 hrs | Not started |
| 2.4 | 4 | Manual testing with real data | 12 hrs | Not started |
| 2.5 | 5 | Production release, runbook | 10 hrs | Not started |
| | | **TOTAL** | **127 hrs** | |

**With 2 developers working in parallel**: 2.5 weeks to ship (50% parallelization in phases 2.1/2.2)

---

## Critical Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Changelog drift** | Validate each entry against Paperclip issue; add "GENERATED BY SPRINT CO" header |
| **GitHub comment too large** | Split into 3+ comments if >60KB; test with 10 features |
| **Missing eval reports** | Fail loudly; require QA to run before allowing deployment |
| **Issue ID mapping wrong** | Require PAP-XXXX from task-breakdown (authoritative); cross-verify with GitHub |
| **Paperclip API down** | Make updates optional (not blocking); queue retry; skip if unavailable |
| **Contributor attribution errors** | Email→username lookup with fallback; manual review in PR comment |

---

## Success Criteria

✅ Skill documented  
✅ All artifacts parsed correctly  
✅ CHANGELOG + PR comment generated <2 min  
✅ Output quality matches human-written notes  
✅ 95+ tests passing (unit + e2e)  
✅ 3 real sprints verified end-to-end  
✅ Zero manual fixes needed for production  

---

## Read Next

For full details, see:
1. **[PHASE-2-DESIGN.md](./PHASE-2-DESIGN.md)** — Complete 7,600-word architecture document
2. **[PHASE-2-SUMMARY.md](./PHASE-2-SUMMARY.md)** — Key decisions and implementation phases

---

**Last Updated**: 2026-03-31  
**Status**: Design Complete — Ready for Implementation Kickoff

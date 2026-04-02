---
schema: agentcompanies/v1
kind: skill
name: sprint-release-generator
description: >
  Skill for Release Automation. Parses completed sprint artifacts (eval reports, 
  handoff documents, sprint plans, task breakdowns) and generates changelog entries 
  and GitHub PR comments for release documentation and issue traceability.
---

# Sprint Release Generator Skill

## Overview

The Release Generator agent reads artifacts from a completed sprint (after Delivery Engineer has shipped code) and produces two outputs:

1. **CHANGELOG.md Entry** — Calver-versioned section with shipped features, dropped items, QA results, and contributor attribution
2. **GitHub PR Comment** — Rich markdown comment on the tracking PR with feature matrix, timeline, and recommendations

This skill automates the conversion of internal sprint artifacts into public-facing release documentation while preserving the link from shipped features back to Paperclip task IDs.

### When It Triggers

- After successful production deployment (Delivery Engineer reports `sprint-report.md` with status SHIPPED)
- Triggered by Delivery Engineer or Sprint Orchestrator via explicit request
- Optional: Auto-trigger when all eval reports are PASS and sprint-report shows deployed URL

### Success Criteria

- ✅ All shipped features (QA score ≥24) appear in CHANGELOG with Paperclip ID and PR link
- ✅ Dropped features appear with reason and QA score if applicable
- ✅ QA summary table includes all 4 criteria (Functionality, Product Depth, Visual Design, Code Quality)
- ✅ GitHub PR comment posts successfully and remains under 5000 characters
- ✅ Changelog entry preserves chronological order (newest first)
- ✅ All Paperclip issue IDs remain valid and formatted as `PAP-XXXX`

---

## 1. Input Requirements

### Artifact Locations

All artifacts are expected in `/Volumes/JS-DEV/paperclip/sprints/[SPRINT-ID]/` directory:

```
sprints/
└── sprint-ABC123/
    ├── sprint-plan.md              (from Sprint Planner)
    ├── task-breakdown.md           (from Task Breakdown phase)
    ├── handoff-alpha.md            (from Alpha engineer)
    ├── handoff-beta.md             (from Beta engineer)
    ├── handoff-gamma.md            (optional, from Gamma engineer if exists)
    ├── eval-TASK-ID-001.md        (from QA Engineer, one per task)
    ├── eval-TASK-ID-002.md
    ├── sprint-report.md            (from Delivery Engineer)
    └── release/
        ├── CHANGELOG.md            (existing, will append to)
        └── release-metadata.json   (generated, for internal tracking)
```

### Required Context

Before running the skill, verify:

```
[ ] Delivery Engineer report shows "Status: SHIPPED ✅"
[ ] Production URL is recorded in sprint-report.md
[ ] At least 1 eval-*.md file exists (task completed and evaluated)
[ ] CHANGELOG.md exists in repo root (create if missing)
[ ] Paperclip context available (for issue lookups)
[ ] GitHub token set in environment (GITHUB_TOKEN)
```

### Paperclip Context

The skill uses Paperclip API to:
- Fetch task titles and descriptions from Paperclip IDs in artifacts
- Update task status to "Released" when changelog entry is created
- Query contributors from commit history tied to task IDs

Required fields from Paperclip:
- Task ID (e.g., PAP-1234)
- Task title
- Task description
- Assignee names
- Due date (for sprint timeline calculation)

### GitHub Token

Required for:
- Posting PR comment on tracking PR (format: `releases/sprint-[ID]`)
- Querying commit history and PR links
- Updating PR labels (e.g., "released", "changelog-generated")

Set in environment:
```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
export GITHUB_OWNER="paperclipai"
export GITHUB_REPO="paperclip"
```

---

## 2. Parsing Phase

The skill parses each artifact type in sequence, extracting key fields and validating structure.

### 2.1 Parse sprint-plan.md

**Purpose**: Extract sprint ID, start date, goals, and task list

**Expected Structure**:
```markdown
# Sprint Plan — Sprint [ID]
**Sprint ID**: [ID]
**Date**: [YYYY-MM-DD]
**Duration**: [N hours]

## Goal
[Brief statement of sprint goal]

## Tasks
1. PAP-1234 — [Task Title]
2. PAP-1245 — [Task Title]
```

**Parsed Fields**:
- `sprintId` → Extract from "Sprint [ID]" or filename
- `startDate` → Parse from **Date** field
- `duration` → Parse from **Duration** field
- `tasks` → Extract all PAP-XXXX identifiers

**Validation**:
- Sprint ID must be non-empty string
- Date must be valid ISO 8601 (YYYY-MM-DD)
- At least 1 task must be listed

**Failure Mode**: If missing, warn but continue (not critical for changelog)

### 2.2 Parse task-breakdown.md

**Purpose**: Extract estimated time, V-labels, and task priority

**Expected Structure**:
```markdown
# Task Breakdown

## PAP-1234: [Task Title]
**Effort**: [X hours]
**V-Label**: [V1 | V2 | V3]
**Priority**: [P0 | P1 | P2]
[Description and subtasks]

## PAP-1245: [Task Title]
...
```

**Parsed Fields**:
- `tasks[].papId` → PAP-XXXX identifier
- `tasks[].effort` → Estimated hours as number
- `tasks[].vLabel` → Version label (V1, V2, V3)
- `tasks[].priority` → Priority level

**Validation**:
- Effort must be positive number
- V-Label must be V1, V2, or V3
- Priority must be P0, P1, or P2

**Failure Mode**: If parse fails for a task, skip it and warn

### 2.3 Parse handoff-*.md Files

**Purpose**: Extract feature summary and contributor attribution

**Expected Structure**:
```markdown
# Handoff Report — [Engineer Name/Role]

**Paperclip Task ID**: PAP-1234
**Task Title**: [Title]
**Status**: [COMPLETE | PARTIAL | BLOCKED]
**Features Delivered**:
- [Feature 1 description]
- [Feature 2 description]

**Technical Approach**:
[Brief description of implementation]

**Known Issues**:
- [Issue 1]

**Recommendations for V2**:
- [Suggestion]
```

**Parsed Fields**:
- `engineer` → Name/role from filename (handoff-[NAME].md)
- `papId` → From "Paperclip Task ID" field
- `status` → From "Status" field
- `features` → Bullet list under "Features Delivered"
- `knownIssues` → Bullet list under "Known Issues"

**Validation**:
- Status must be COMPLETE, PARTIAL, or BLOCKED
- Features list must not be empty if COMPLETE

**Failure Mode**: If no handoff files exist, warn and use eval reports as primary source

### 2.4 Parse eval-*.md Files

**Purpose**: Extract QA scores and pass/fail determination

**Expected Structure**:
```markdown
# QA Evaluation Report — PAP-XXXX

**Task ID**: PAP-XXXX
**Task Title**: [Task Title]
**Evaluator**: [Name]
**Date**: YYYY-MM-DD

## Criteria Scores

| Criterion | Score | Notes |
|-----------|-------|-------|
| Functionality | [0-10] | [Notes] |
| Product Depth | [0-10] | [Notes] |
| Visual Design | [0-10] | [Notes] |
| Code Quality | [0-10] | [Notes] |

**Overall Score**: [total]/40

**Status**: PASS or FAIL

**Recommendation**: [Shipped / Deferred to V2 / Requires rework]
```

**Parsed Fields**:
- `papId` → From "Task ID" field
- `evaluator` → Name from "Evaluator" field
- `evalDate` → From "Date" field
- `scores` → Object with Functionality, ProductDepth, VisualDesign, CodeQuality (each 0-10)
- `overallScore` → Total out of 40
- `status` → PASS (≥24) or FAIL (<24)
- `recommendation` → String from "Recommendation" field

**Validation**:
- Each criterion must be integer 0-10
- Overall score must equal sum of 4 criteria
- Status must be PASS or FAIL (derived from score if not explicit)

**Failure Mode**: If eval file is missing, task cannot be shipped; mark as "No evaluation" and drop from changelog

### 2.5 Parse sprint-report.md

**Purpose**: Extract deployment details, timeline, and overall status

**Expected Structure**:
```markdown
# Sprint Report — Sprint [ID]
**Date**: YYYY-MM-DD
**Status**: SHIPPED ✅ / PARTIAL ⚠️ / FAILED ❌

## Production
**URL**: https://[production-url]
**Type**: [Pages | Workers | Full-Stack]
**Deploy Time**: HH:MM:SS

## Features Shipped
| Feature | QA Score | Notes |
|---------|----------|-------|
| [PAP-XXXX] [Title] | [X/40] | [Notes] |

## Sprint Timeline
| Milestone | Time | Delta |
|-----------|------|-------|
| Brief received | 0:00 | — |
| sprint-plan.md | 0:18 | +18 min |
...
```

**Parsed Fields**:
- `reportDate` → From **Date** field
- `deployStatus` → From **Status** field (extract emoji)
- `productionUrl` → From Production URL field
- `deployTime` → Duration as string (HH:MM:SS)
- `totalTime` → Calculated from Sprint Timeline total
- `timeline` → Array of milestone objects

**Validation**:
- Status must indicate SHIPPED (✅) to proceed
- Production URL must be valid HTTPS
- Deploy time must be parseable duration

**Failure Mode**: If Status is not SHIPPED, generate warning and ask before proceeding

---

## 3. Generation Phase

After parsing all artifacts, generate the changelog and PR comment using extracted data.

### 3.1 Generate CHANGELOG Entry

#### Structure

```markdown
# v[CALVER]

> Released: [DATE]

## Features Shipped

[Feature list with links and attribution]

## Features Dropped (v[NEXT-CALVER])

[Dropped feature list with reasons]

## QA Results Summary

[Table of scores]

## Contributors

[List of @mentions]
```

#### CalVer Calculation

Paperclip uses calendar versioning: `v[YYYY].[DAY-OF-YEAR].[PATCH]`

**Algorithm**:
1. Get release date from sprint-report.md or current date
2. Calculate day-of-year: `dayOfYear = date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000`
3. Zero-pad to 3 digits: `String(dayOfYear).padStart(3, '0')`
4. For patch: Check existing CHANGELOG entries
   - If this is first release of the day: patch = 1
   - If entries exist for same [YYYY].[DAY]: increment patch number
   - Example: v2026.090.1, v2026.090.2, then v2026.091.1 next day

**Example**:
- Release on 2026-03-31 (day 90): v2026.090.1
- Second release same day: v2026.090.2
- Release on 2026-04-01 (day 91): v2026.091.1

#### Feature List Generation

For each task with eval status PASS (score ≥24):

```markdown
- **[Task Title]** (PAP-XXXX) — [feature description]. ([#PR_NUMBER](https://github.com/paperclipai/paperclip/pull/PR_NUMBER), @contributor1, @contributor2)
```

**Data Sources** (priority order):
1. `handoff-*.md` → "Features Delivered" section (primary)
2. `task-breakdown.md` → Task description (fallback)
3. Paperclip API → Task description (fallback)

**PR Number Lookup**:
- Query GitHub API: `GET /repos/paperclipai/paperclip/pulls?state=closed&labels=PAP-XXXX`
- Use most recent PR merged during sprint window (start date to deployment date)
- Format link: `[#2847](https://github.com/paperclipai/paperclip/pull/2847)`

**Contributors**:
- Extract from handoff files (Evaluator field)
- Query git: `git log --format=%an [date-range]`
- Deduplicate and format as `@username`

#### Dropped Features Section

For each task NOT shipped (status FAIL or V2+ label):

```markdown
- **[Task Title]** (PAP-XXXX) — [reason]. ([Score if FAIL]: XX/40)
```

**Reason Generation**:
- If QA FAIL (score <24): "QA evaluation did not meet acceptance threshold (XX/40)"
- If V-Label is V2+: "Deferred to [V-Label]"
- If Status is BLOCKED: "Engineering blocked on [issue]; deferred to next sprint"
- If Status is PARTIAL: "Incomplete; deferred for refinement"

#### QA Summary Table

Create markdown table with one row per shipped feature:

```markdown
| Feature | Functionality | Product Depth | Visual Design | Code Quality | Overall |
|---------|---------------|---------------|---------------|--------------|---------|
| [Task Title] | 9/10 | 8/10 | 8/10 | 8/10 | **33/40 PASS** |
| [Task Title] | 8/10 | 7/10 | 7/10 | 7/10 | **29/40 PASS** |
```

Include only PASS entries (≥24). Format: `**[SCORE]/40 PASS**` for easy scanning.

#### Contributors Section

List all unique contributors from handoffs + git history:

```markdown
## Contributors

@alice, @bob, @charlie
```

Format as comma-separated GitHub mentions.

### 3.2 Generate GitHub PR Comment

**When to Post**:
- After CHANGELOG entry is generated
- On the sprint's tracking PR (typically named `releases/sprint-[ID]`)
- Only if dry-run mode is false

**Structure**:

```markdown
## 🚀 Release Report: v[CALVER]

### Feature Matrix

[Table with all tasks: shipped, deferred, dropped]

### Timeline

[Milestone summary from sprint-report]

### QA Metrics

[Summary statistics]

### Recommendations

[From sprint report and handoffs]

---

Generated by sprint-release-generator | [Timestamp]
```

**Feature Matrix Table**:

```markdown
| Feature | Status | Paperclip ID | QA Score | Notes |
|---------|--------|--------------|----------|-------|
| [Title] | ✅ Shipped | PAP-1234 | 33/40 | [notes from eval] |
| [Title] | ⏳ Deferred | PAP-1245 | — | [reason] |
| [Title] | ❌ Dropped | PAP-1267 | 18/40 FAIL | [reason] |
```

Status indicators:
- `✅ Shipped` — QA PASS
- `⏳ Deferred` — V2+ label
- `❌ Dropped` — QA FAIL

**Timeline Summary**:

Extract key milestones from sprint-report.md timeline:

```markdown
- **Planning**: [Duration]
- **Engineering**: [Duration]
- **QA**: [Duration]
- **Total**: [Duration]
```

**Recommendations**:

Extract from:
1. handoff-*.md "Recommendations for V2" section
2. eval-*.md notes about rework needed
3. sprint-report.md "Recommendations for Jeremy"

Format as bullet list, limited to 3-5 most important items.

**Character Limit**:
- GitHub comments must be <5000 characters
- If exceeding: Truncate recommendations, collapse tables, and add note "See CHANGELOG.md for full details"
- Test with: `comment.length < 5000`

---

## 4. Integration Phase

### 4.1 Update Paperclip Issues

For each shipped feature (PAP-XXXX with PASS eval):

```
PUT /api/tasks/[PAP-ID]
{
  "status": "released",
  "releaseVersion": "v2026.090.1",
  "releasedAt": "2026-03-31T14:30:00Z"
}
```

**Retry Logic**:
- Retry up to 3 times on 5xx or timeout
- Exponential backoff: 1s, 2s, 4s
- On permanent 4xx: Log error and continue (don't block changelog)

**Validation**:
- Verify response includes updated task with release metadata
- Update local artifact with response

### 4.2 Update CHANGELOG.md

**Algorithm**:

1. Read existing CHANGELOG.md (or create if missing)
2. Parse existing versions to determine next calver
3. Find insertion point: after `# v[LATEST]` line, before next section
4. Insert new entry:
   ```
   # v[NEW-CALVER]
   
   > Released: [DATE]
   
   [Content]
   
   ---
   
   [Existing content]
   ```
5. Verify ordering: newest version first
6. Write updated CHANGELOG.md
7. Verify no data loss: count feature entries before/after

**Validation**:
- ✅ New version greater than previous (calver ordering)
- ✅ All shipped features from artifacts present in changelog
- ✅ No duplicate entries (check PAP-XXXX IDs)
- ✅ Markdown is well-formed (balanced headers, tables, links)

### 4.3 Post GitHub PR Comment

**Target PR**:

1. Check environment for PR number: `GITHUB_PR_NUMBER`
2. If not set, query GitHub API: `GET /repos/paperclipai/paperclip/pulls?head=releases/sprint-[ID]`
3. Use most recent open PR with that branch, or specified PR number

**API Call**:

```bash
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/paperclipai/paperclip/pulls/[PR_NUMBER]/comments \
  -d '{"body": "[comment content]"}'
```

**Response Handling**:
- Status 201: Comment posted successfully
- Status 422: PR comment limit or comment already exists → Log warning and continue
- Status 401: Invalid token → Fail with clear error
- Status 404: PR not found → Fail with clear error, list available PRs
- Status 5xx: Retry up to 3 times with exponential backoff

**Update PR Labels**:

After comment posted, add labels:

```bash
curl -X POST \
  https://api.github.com/repos/paperclipai/paperclip/issues/[PR_NUMBER]/labels \
  -d '{"labels": ["released", "changelog-generated"]}'
```

### 4.4 Dry-Run Mode

If `--dry-run` flag is set:

1. Generate CHANGELOG and PR comment (full execution)
2. DO NOT modify files
3. DO NOT call Paperclip API
4. DO NOT post to GitHub
5. Print to stdout:
   ```
   [DRY RUN] CHANGELOG entry to be appended:
   ===== BEGIN =====
   [content]
   ===== END =====

   [DRY RUN] GitHub PR comment to be posted on PR #[N]:
   ===== BEGIN =====
   [content]
   ===== END =====

   [DRY RUN] Would update Paperclip tasks: [PAP-1234, PAP-1245]
   ```

---

## 5. File Path Conventions

### Input Paths (Read-Only)

All relative to `/Volumes/JS-DEV/paperclip/`:

```
sprints/[SPRINT-ID]/
├── sprint-plan.md
├── task-breakdown.md
├── handoff-*.md
├── eval-*.md
└── sprint-report.md
```

### Output Paths (Write)

#### Primary Outputs

```
/ (repo root)
└── CHANGELOG.md                    # Appended with new entry

releases/[SPRINT-ID]/
├── release-metadata.json           # Internal tracking
└── pr-comment.md                   # Backup of posted comment
```

#### Backup Paths (Optional)

```
sprints/[SPRINT-ID]/release/
├── changelog-entry.md              # Copy of generated entry
└── pr-comment.md                   # Copy before posting
```

### File Naming Conventions

- **CHANGELOG.md**: Single file in repo root, versioned sections within
- **release-metadata.json**: Per-sprint metadata, matches sprint ID
- **Backup files**: Timestamped if multiple runs: `pr-comment-2026-03-31T143000Z.md`

---

## 6. Error Handling & Recovery

### 6.1 Parsing Errors

| Scenario | Handling |
|----------|----------|
| Missing eval-*.md for a task | Skip task from changelog, warn user |
| Malformed markdown table | Parse as plaintext, extract key values |
| Missing Paperclip task title | Use PAP-XXXX as title, mark with ⚠️ |
| Invalid score (>10 per criterion) | Use as-is, flag in report |
| Missing sprint-report.md | Use task-breakdown dates, warn |

**Recovery Strategy**:
1. Log error with artifact path
2. Continue processing other artifacts
3. Generate report with `[WARNING]` prefix
4. If critical data missing: Prompt user before proceeding
5. Never fail silently—always report what was missing

### 6.2 Integration Errors

| Error | Retry | Action |
|-------|-------|--------|
| Paperclip API 5xx | Yes (3x) | Exponential backoff, continue |
| Paperclip API 401 | No | Fail, show token help |
| GitHub API 401 | No | Fail, show token help |
| GitHub PR not found | No | Fail, list available PRs |
| CHANGELOG.md write fails | No | Fail, restore backup if exists |

**Retry Configuration**:

```javascript
const retryConfig = {
  maxRetries: 3,
  backoffMs: [1000, 2000, 4000],
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
};
```

### 6.3 Rollback Procedure

If any integration step fails after changelog is written:

1. **Paperclip Update Failed**:
   - Changelog is already written to disk
   - Manual fix: Retry Paperclip API call with task IDs
   - Or: Mark task as "pending release notification" in Paperclip

2. **GitHub Post Failed**:
   - Changelog is written, Paperclip updated
   - Manual fix: Copy `pr-comment.md` from `/releases/[ID]/` and post manually to GitHub
   - Or: Retry with `--retry-github` flag

3. **CHANGELOG Write Failed**:
   - Check disk space and permissions
   - Restore from backup: `git checkout CHANGELOG.md` or use `.backup` file
   - Retry after fixing permissions

**Backup Strategy**:
- Before writing CHANGELOG: `cp CHANGELOG.md CHANGELOG.md.backup`
- Keep backup for 24 hours (delete in next sprint)
- On failure: Report backup location to user

---

## 7. Complete Examples

### Example 1: Single Feature, Perfect QA

**Input Artifacts**:

- sprint-plan.md: `PAP-1234 — Dashboard redesign`
- task-breakdown.md: `PAP-1234, Effort: 4h, V1, P0`
- handoff-alpha.md:
  ```
  **Paperclip Task ID**: PAP-1234
  **Status**: COMPLETE
  **Features Delivered**:
  - Interactive dashboard with real-time metrics
  - Dark mode toggle
  ```
- eval-PAP-1234.md: All criteria 9/10, Overall: 36/40, Status: PASS
- sprint-report.md: Status: SHIPPED ✅, URL: https://app.pages.dev

**Generated CHANGELOG Entry**:

```markdown
# v2026.090.1

> Released: 2026-03-31

## Features Shipped

- **Dashboard Redesign** (PAP-1234) — Interactive dashboard with real-time metrics and dark mode toggle. ([#2847](https://github.com/paperclipai/paperclip/pull/2847), @alice)

## QA Results Summary

| Feature | Functionality | Product Depth | Visual Design | Code Quality | Overall |
|---------|---------------|---------------|---------------|--------------|---------|
| Dashboard Redesign | 9/10 | 9/10 | 9/10 | 9/10 | **36/40 PASS** |

## Contributors

@alice
```

**GitHub PR Comment**:

```markdown
## 🚀 Release Report: v2026.090.1

### Feature Matrix

| Feature | Status | Paperclip ID | QA Score | Notes |
|---------|--------|--------------|----------|-------|
| Dashboard Redesign | ✅ Shipped | PAP-1234 | 36/40 | Excellent execution |

### Timeline

- **Planning**: 0:18
- **Engineering**: 1:52
- **QA**: 0:25
- **Total**: 2:35

---

Generated by sprint-release-generator | 2026-03-31T14:30:00Z
```

### Example 2: Mixed Results (Pass, Fail, Deferred)

**Input Artifacts**:

- 3 tasks: PAP-1234 (PASS), PAP-1245 (FAIL), PAP-1256 (V2)
- PAP-1234: 28/40 PASS
- PAP-1245: 18/40 FAIL (insufficient code quality)
- PAP-1256: V2 label in task-breakdown.md

**Generated CHANGELOG Entry**:

```markdown
# v2026.090.1

> Released: 2026-03-31

## Features Shipped

- **Feature A** (PAP-1234) — Description. ([#2847](https://github.com/paperclipai/paperclip/pull/2847), @alice)

## Features Dropped (v2026.091)

- **Feature B** (PAP-1245) — QA evaluation did not meet acceptance threshold (18/40). Requires rework on code quality and architecture review.
- **Feature C** (PAP-1256) — Deferred to V2 due to engineering time constraints.

## QA Results Summary

| Feature | Functionality | Product Depth | Visual Design | Code Quality | Overall |
|---------|---------------|---------------|---------------|--------------|---------|
| Feature A | 7/10 | 7/10 | 7/10 | 7/10 | **28/40 PASS** |

## Contributors

@alice, @bob
```

---

## 8. Handoff Artifact Format

When the Release Generator successfully generates and posts release artifacts, it produces a **handoff artifact** for signaling downstream agents (e.g., Release Communication Agent, Metrics Dashboard).

**Format**: `/releases/[SPRINT-ID]/release-handoff.md`

```markdown
# Release Handoff — Sprint [ID]

**Release Generator**: Completed at [ISO timestamp]

## Release Summary

**Version**: v[CALVER]
**Released**: [DATE]
**Production URL**: [URL]
**Status**: SUCCESS ✅ / PARTIAL ⚠️ / FAILED ❌

## Artifacts Generated

- **CHANGELOG.md**: Appended with v[CALVER] entry
- **GitHub PR Comment**: Posted on [PR #NUMBER](https://github.com/paperclipai/paperclip/pull/NUMBER)
- **Paperclip Updates**: [N] tasks updated to status "released"

## Features Shipped

| Task | Title | Score | Link |
|------|-------|-------|------|
| PAP-1234 | [Title] | 33/40 | [GitHub PR](#) |
| PAP-1245 | [Title] | 29/40 | [GitHub PR](#) |

## Features Dropped

| Task | Title | Reason |
|------|-------|--------|
| PAP-1256 | [Title] | Time budget exceeded |
| PAP-1267 | [Title] | QA failed on data validation |

## Handoff Data

```json
{
  "sprintId": "ABC123",
  "version": "v2026.090.1",
  "releaseDate": "2026-03-31",
  "productionUrl": "https://app.pages.dev",
  "shipped": [
    {
      "papId": "PAP-1234",
      "title": "Feature A",
      "qaScore": 33,
      "prNumber": 2847,
      "contributors": ["alice", "bob"]
    }
  ],
  "dropped": [
    {
      "papId": "PAP-1256",
      "title": "Feature B",
      "reason": "Time budget exceeded",
      "vLabel": "V2"
    }
  ],
  "metrics": {
    "totalShipped": 2,
    "totalDropped": 2,
    "totalTime": 155,
    "qaPassRate": 1.0
  }
}
```

**Format Notes**:
- JSON must be valid and parseable
- Metrics useful for dashboard visualization
- Shipped/dropped arrays include all details for downstream agents
- Format stable across releases (no breaking changes without major version bump)

---

## 9. Testing Checklist

Before declaring a release generated successfully:

### Artifact Validation

- [ ] All eval-*.md files found and parsed
- [ ] All Paperclip IDs (PAP-XXXX) are valid format
- [ ] At least 1 feature has PASS status (≥24)
- [ ] No duplicate entries in shipped + dropped
- [ ] All mentioned contributors exist in git history

### CHANGELOG Validation

- [ ] File exists at repo root
- [ ] New entry has correct CalVer format (v[YYYY].[DDD].[PATCH])
- [ ] Version greater than previous entry
- [ ] Features list non-empty
- [ ] QA table includes all shipped tasks
- [ ] All Paperclip links are valid `[PAP-XXXX](...)` format
- [ ] All GitHub PR links are valid `[#XXXX](...)` format
- [ ] Markdown renders without errors
- [ ] No syntax errors in tables

### GitHub Integration Validation

- [ ] PR comment < 5000 characters
- [ ] Comment includes release version
- [ ] Feature matrix matches changelog
- [ ] All tables render correctly
- [ ] Links point to correct issues and PRs
- [ ] Comment posted to correct PR number

### Paperclip Integration Validation

- [ ] At least 1 task updated to status "released"
- [ ] Updated tasks match shipped feature list
- [ ] Release version recorded correctly
- [ ] Timestamp is valid ISO format

### End-to-End Flow

- [ ] Input: sprint-report.md shows SHIPPED ✅
- [ ] Processing: No critical errors logged
- [ ] Output: CHANGELOG.md updated and committed
- [ ] Output: GitHub PR has comment
- [ ] Output: Paperclip tasks reflect released status
- [ ] Handoff: release-handoff.md created with correct format

---

## 10. Debugging Guide

### Common Issues

**Issue**: "No eval-*.md files found"
- Check: Directory `/sprints/[SPRINT-ID]/` exists
- Check: QA Engineer completed all evaluations
- Check: Files named exactly `eval-[TASK-ID].md` (case-sensitive)
- Action: Ask user to verify evaluations are complete

**Issue**: "Paperclip API 401 Unauthorized"
- Check: `GITHUB_TOKEN` is set and valid
- Action: Verify token has repo scope (`repo` permission)
- Action: Regenerate token if expired (< 90 days old)

**Issue**: "GitHub PR not found"
- Check: Correct sprint ID provided
- Action: List available PRs: `git branch -r | grep release`
- Action: Manually specify PR with `--pr-number` flag

**Issue**: "CHANGELOG.md write permission denied"
- Check: File is not read-only: `ls -la CHANGELOG.md`
- Check: Directory is writable: `touch CHANGELOG.md.test && rm $_`
- Action: Fix permissions or request write access

**Issue**: "Feature count mismatch"
- Generate report: Count shipped in eval vs. changelog
- Check: Are all PASS tasks included?
- Check: No duplicate entries?
- Action: Manual review of output files

### Debug Flags

Run with debugging enabled:

```bash
export DEBUG=sprint-release-generator:*
sprint-release-generator --sprint-id ABC123 --debug
```

Output includes:
- Parsing progress for each artifact
- Extracted fields from each file
- API request/response pairs
- Generated content before writing
- File write operations

### Manual Verification

1. **Review CHANGELOG before commit**:
   ```bash
   git diff CHANGELOG.md
   ```

2. **Test PR comment locally**:
   ```bash
   cat releases/ABC123/pr-comment.md
   ```

3. **Check Paperclip updates**:
   ```bash
   # Query Paperclip API
   curl -H "Authorization: Bearer $PAPERCLIP_TOKEN" \
     https://api.paperclip.ai/tasks/PAP-1234
   ```

4. **Verify git history**:
   ```bash
   git log --oneline --since="[sprint start]" --until="[sprint end]"
   ```

---

**Last Updated**: 2026-03-31  
**Maintained By**: Release Automation Team  
**Questions?** Check `/docs/companies/sprint-co/integrations/release-changelog-integration.md`

# Release Changelog Integration Guide

**Document Type**: Integration Guide  
**Version**: 1.0  
**Last Updated**: 2026-03-31  
**Status**: Production Ready  
**Audience**: Sprint Engineers, Release Automation Team, DevOps

---

## Quick Start

After your sprint code is deployed to production:

```bash
# 1. Verify deployment succeeded
git log --oneline | head -5

# 2. Run release generator
./scripts/release-generator.sh \
  --sprint-id ABC123 \
  --github-token $GITHUB_TOKEN

# 3. Verify outputs
cat CHANGELOG.md | head -50
git diff CHANGELOG.md
```

Output: CHANGELOG.md updated + GitHub PR comment posted.

---

## 1. Architecture Overview

The Release Changelog Integration consists of three layers:

### 1.1 Input Layer: Artifact Parsing

Reads completed sprint artifacts from the standard Phase 1 workflow:

```
Input Files (from Phase 1)
├── sprint-plan.md         ← Sprint goals and task list
├── task-breakdown.md      ← Task effort and versioning
├── handoff-*.md           ← Feature descriptions from engineers
├── eval-*.md              ← QA scores and pass/fail status
└── sprint-report.md       ← Production deployment info

Parser
├── Validates each artifact format
├── Extracts structured data
├── Links tasks to evaluations
└── Builds unified artifact context
```

### 1.2 Generation Layer: Release Artifact Creation

Transforms parsed data into release outputs:

```
Artifact Context
├── Extract shipped features (QA score ≥24)
├── Calculate calver version (v[YYYY].[DDD].[PATCH])
├── Generate markdown changelog entry
├── Create GitHub PR comment
├── Build handoff artifact
└── Format Paperclip update requests

Outputs
├── CHANGELOG.md (appended)
├── pr-comment.md (backup)
└── release-handoff.md (for downstream agents)
```

### 1.3 Integration Layer: External System Updates

Persists outputs to external systems:

```
Output Targets
├── Git/GitHub
│   ├── CHANGELOG.md in repo
│   ├── PR comment on tracking branch
│   └── Labels and status updates
├── Paperclip API
│   ├── Task status → "released"
│   ├── Release version field
│   └── Timestamp recording
└── Artifacts Storage
    ├── /releases/[SPRINT-ID]/ folder
    └── Timestamped backups
```

### 1.4 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     SPRINT DELIVERY                         │
│  Engineer ships code to production (Phase 1 complete)       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                 ARTIFACT PARSING PHASE                      │
│                                                              │
│  Parse 5 artifact types:                                    │
│  • sprint-plan.md → Sprint context                          │
│  • task-breakdown.md → Task metadata                        │
│  • handoff-*.md → Feature descriptions                      │
│  • eval-*.md → QA scores & pass/fail                        │
│  • sprint-report.md → Deployment info                       │
│                                                              │
│  Output: Unified Artifact Context                           │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
         ↓             ↓             ↓
    ┌────────┐  ┌──────────┐  ┌──────────────┐
    │ Filter │  │ Calculate│  │ Extract      │
    │Shipped │  │  CalVer  │  │Contributors │
    │(≥24)   │  │Version   │  │ from Git     │
    └────────┘  └──────────┘  └──────────────┘
         │             │             │
         └─────────────┼─────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│               GENERATION PHASE                              │
│                                                              │
│  Generate 3 outputs:                                        │
│  • CHANGELOG.md entry (markdown)                            │
│  • GitHub PR comment (markdown)                             │
│  • release-handoff.md (for downstream agents)               │
│                                                              │
│  Features included:                                         │
│  • Shipped features with PR links                           │
│  • Dropped features with reasons                            │
│  • QA results summary table                                 │
│  • Contributor attribution                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼──────────────┐
         │             │              │
         ↓             ↓              ↓
    ┌────────┐  ┌──────────┐  ┌──────────────┐
    │CHANGELOG│ │GitHub PR │  │release-     │
    │ .md     │  │Comment   │  │handoff.md   │
    └────────┘  └──────────┘  └──────────────┘
         │             │              │
         └─────────────┼──────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│            INTEGRATION PHASE                                │
│                                                              │
│  Persist outputs to external systems:                       │
│  • Write CHANGELOG.md to repo                               │
│  • Post PR comment to GitHub                                │
│  • Update Paperclip task statuses                           │
│  • Create release handoff artifact                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼──────────────────┐
         │             │                  │
         ↓             ↓                  ↓
    ┌────────────┐ ┌─────────┐  ┌──────────────┐
    │Git Commit  │ │Paperclip│  │Artifact      │
    │CHANGELOG.md│ │API call │  │Storage       │
    └────────────┘ └─────────┘  └──────────────┘
                       │
         ┌─────────────┼──────────────────┐
         │             │                  │
         ↓             ↓                  ↓
    ┌────────────┐ ┌─────────┐  ┌──────────────┐
    │GitHub PR   │ │Task     │  │release-     │
    │Labels +    │ │Status   │  │metadata.json│
    │Status      │ │Updated  │  │Created      │
    └────────────┘ └─────────┘  └──────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                HANDOFF TO NEXT PHASE                        │
│                                                              │
│  release-handoff.md signals completion to:                  │
│  • Release Communication Agent                              │
│  • Metrics Dashboard                                        │
│  • Customer Notification System                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow: Artifacts → Changelog → GitHub

### 2.1 Artifact Input Sources

All artifacts must follow the Phase 1 format and be stored in:

```
/Volumes/JS-DEV/paperclip/sprints/[SPRINT-ID]/
```

**Required Files**:

| File | Source | Format | Required |
|------|--------|--------|----------|
| sprint-plan.md | Sprint Planner | Markdown | Yes |
| task-breakdown.md | Task Breakdown phase | Markdown | Yes |
| handoff-*.md | Each engineer | Markdown | Yes (≥1) |
| eval-*.md | QA Engineer | Markdown | Yes (≥1 per shipped task) |
| sprint-report.md | Delivery Engineer | Markdown | Yes |

### 2.2 Parsing Process

For each artifact type, the parser:

1. **Validates file exists** and is readable
2. **Parses markdown** into structured data
3. **Extracts required fields** (see SKILL.md Section 2 for details)
4. **Links tasks** across artifacts (by PAP-ID)
5. **Validates data** (scores in range, dates format, etc.)

**Example: Parsing eval-PAP-1234.md**

```
Input: eval-PAP-1234.md file
  ↓
1. Read file → markdown content
  ↓
2. Extract "Task ID" field → "PAP-1234"
  ↓
3. Extract criteria table:
   - Functionality: 9/10
   - Product Depth: 8/10
   - Visual Design: 9/10
   - Code Quality: 8/10
  ↓
4. Calculate overall: 9+8+9+8 = 34/40
  ↓
5. Determine status: 34 ≥ 24 → PASS
  ↓
Output: Evaluation object {
  papId: "PAP-1234",
  scores: { functionality: 9, ... },
  overallScore: 34,
  status: "PASS"
}
```

### 2.3 Changelog Generation

The changelog entry combines data from all artifacts:

**Data Sources by Section**:

```
## Features Shipped
├── Source: eval files (PASS only)
├── Description: handoff-*.md "Features Delivered"
├── Links: GitHub API (commit/PR lookup)
└── Contributors: Git history + handoff "Evaluator"

## Features Dropped
├── Source: eval files (FAIL) + task-breakdown.md (V2+)
├── Reason: "QA failed (XX/40)" or "V2 deferred"
└── Notes: Evaluation feedback or task description

## QA Results Summary
├── Source: All eval files
├── Table rows: One per PASS evaluation
├── Columns: Functionality, Product Depth, Visual Design, Code Quality, Overall
└── Format: X/10, highlighted PASS (≥24)

## Contributors
├── Source: Git log (handoff completion dates)
└── Format: GitHub mentions @username
```

**Example Transformation**:

```
INPUT (eval-PAP-1234.md)
─────────────────────────
Task ID: PAP-1234
Task Title: Dashboard Redesign
Status: PASS
Overall Score: 34/40

INPUT (handoff-alpha.md)
────────────────────────
Paperclip Task ID: PAP-1234
Features Delivered:
- Interactive dashboard with real-time metrics
- Dark mode toggle

INPUT (git log)
───────────────
Author: alice
Commit: abc123def456
PR: #2847

OUTPUT (CHANGELOG entry)
────────────────────────
- **Dashboard Redesign** (PAP-1234) — Interactive dashboard with 
  real-time metrics and dark mode toggle. (#2847, @alice)
```

### 2.4 PR Comment Generation

GitHub PR comment summarizes the release for team visibility:

**Data Flow**:

```
Evaluation data → Feature Matrix table
  ├── Status: ✅ Shipped / ⏳ Deferred / ❌ Dropped
  ├── QA Score: X/40
  └── Notes: From evaluation feedback

Sprint Report timeline → Timeline section
  └── Key milestones and durations

Evaluation notes → Recommendations section
  └── Top 3-5 suggestions for V2
```

### 2.5 GitHub Integration Points

The release generator interacts with GitHub at:

1. **PR Comment Posting**:
   ```
   POST /repos/paperclipai/paperclip/pulls/[PR-NUM]/comments
   Body: [Generated PR comment]
   ```

2. **Label Updates**:
   ```
   POST /repos/paperclipai/paperclip/issues/[PR-NUM]/labels
   Labels: ["released", "changelog-generated"]
   ```

3. **Commit Lookup** (for PR links):
   ```
   GET /repos/paperclipai/paperclip/commits?since=[sprint-start]&until=[sprint-end]
   Filter: Commits matching eval task IDs
   Extract: PR numbers from commit messages
   ```

---

## 3. How to Trigger the Skill

### 3.1 Manual Trigger

```bash
# Set required environment variables
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
export GITHUB_OWNER="paperclipai"
export GITHUB_REPO="paperclip"

# Run the release generator
cd /Volumes/JS-DEV/paperclip

# Generate and apply changes
./scripts/release-generator.sh --sprint-id ABC123

# Or: dry-run to preview
./scripts/release-generator.sh --sprint-id ABC123 --dry-run
```

### 3.2 Auto-Trigger (When Configured)

If auto-trigger is enabled in company config:

```yaml
# In /Volumes/JS-DEV/paperclip/docs/companies/sprint-co/company.yml
release_generator:
  auto_trigger: true
  trigger_conditions:
    - all_evals_complete: true
    - sprint_report_status: SHIPPED
  retry_count: 3
```

**Trigger happens automatically when**:
- Delivery Engineer updates sprint-report.md with status SHIPPED
- All eval-*.md files are present for deployed tasks
- Paperclip issue updated to "deployed" status

### 3.3 Explicit API Trigger

Via Paperclip API (if Sprint Lead decides to trigger):

```bash
curl -X POST \
  https://api.paperclip.ai/v1/skills/sprint-release-generator/execute \
  -H "Authorization: Bearer $PAPERCLIP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sprintId": "ABC123",
    "dryRun": false
  }'
```

---

## 4. Artifact Requirements

### 4.1 Field Requirements by Artifact Type

**sprint-plan.md**:
```markdown
# Sprint Plan — Sprint [ID]
**Sprint ID**: ABC123                          ← Required
**Date**: 2026-03-31                          ← Required (YYYY-MM-DD)
**Duration**: 3 hours                          ← Optional
## Tasks
1. PAP-1234 — Task Title                       ← Required (PAP-XXXX format)
```

**task-breakdown.md**:
```markdown
## PAP-1234: [Title]
**Effort**: 2.5 hours                          ← Required (number)
**V-Label**: V1                                ← Required (V1, V2, or V3)
**Priority**: P0                               ← Optional (P0, P1, P2)
```

**handoff-*.md**:
```markdown
# Handoff Report — [Engineer Name]
**Paperclip Task ID**: PAP-1234                ← Required
**Status**: COMPLETE                           ← Required
## Features Delivered
- [Description]                                ← Required if COMPLETE
```

**eval-*.md**:
```markdown
# QA Evaluation Report — PAP-XXXX
**Task ID**: PAP-1234                          ← Required
| Criterion | Score | Notes |                  ← Required
| Functionality | 9/10 | ... |
| Product Depth | 8/10 | ... |
| Visual Design | 9/10 | ... |
| Code Quality | 8/10 | ... |
**Overall Score**: 34/40                       ← Required (sum of criteria)
**Status**: PASS                               ← Required (PASS or FAIL)
```

**sprint-report.md**:
```markdown
# Sprint Report — Sprint ABC123
**Status**: SHIPPED ✅                         ← Required (SHIPPED status)
## Production
**URL**: https://example.com                   ← Required (valid URL)
```

### 4.2 Validation Rules

**All artifacts must**:
- Be readable markdown files in UTF-8 encoding
- Contain required fields exactly as specified
- Not have corrupted/missing sections

**Data must**:
- Dates: ISO 8601 format (YYYY-MM-DD)
- QA scores: Integers 0-10 (4 criteria, overall = sum)
- Paperclip IDs: Format PAP-XXXX (4 digits)
- URLs: Valid HTTPS with no spaces
- Effort: Positive numbers (hours)
- Statuses: Exact match (PASS, FAIL, COMPLETE, etc.)

### 4.3 What Happens If Requirements Not Met

| Missing | Impact | Handling |
|---------|--------|----------|
| eval-*.md for shipped feature | Can't release feature | Skip feature, warn user |
| sprint-report.md | No deployment info | Use sprint-plan dates, warn |
| handoff-*.md | No feature description | Use task-breakdown description |
| PASS status | Can't determine release | Calculate from score ≥24 |
| Paperclip API down | Can't update tasks | Continue, mark as pending |

**Error Recovery**:
- Generate changelog even if some integrations fail
- Report what succeeded vs. failed in output summary
- Create "incomplete" handoff artifact for manual intervention
- Provide rollback instructions if needed

---

## 5. Output Formats

### 5.1 CHANGELOG.md Format

**Structure**:

```markdown
# v2026.090.1

> Released: 2026-03-31

## Features Shipped

- **[Title]** (PAP-XXXX) — [description]. ([#PR](link), @contributor)

## Features Dropped (v2026.091)

- **[Title]** (PAP-XXXX) — [reason].

## QA Results Summary

| Feature | Functionality | Product Depth | Visual Design | Code Quality | Overall |
|---------|---------------|---------------|---------------|--------------|---------|
| [Title] | 9/10 | 8/10 | 9/10 | 8/10 | **34/40 PASS** |

## Contributors

@alice, @bob, @charlie

---
```

**Rules**:
- Section order: Shipped → Dropped → QA Summary → Contributors
- Each feature: `- **[Title]** (PAP-XXXX) — [description]. ([#PR](url), @author)`
- QA table: Only PASS entries, in order shipped
- Contributors: Comma-separated GitHub mentions
- New releases: Inserted at top (newest first)

### 5.2 GitHub PR Comment Format

**Structure**:

```markdown
## 🚀 Release Report: v2026.090.1

### Feature Matrix

| Feature | Status | Paperclip ID | QA Score | Notes |
|---------|--------|--------------|----------|-------|
| [Title] | ✅ Shipped | PAP-1234 | 33/40 | [notes] |

### Timeline

- **Planning**: 0:35
- **Engineering**: 1:52
- **QA**: 1:20
- **Total**: 3:47

### QA Metrics

- **Shipped**: 2 features
- **Dropped**: 1 feature
- **Pass Rate**: 100% of released features

### Recommendations

1. [Suggestion from sprint]

---

Generated by sprint-release-generator | 2026-03-31T14:30:00Z
```

**Rules**:
- Must be < 5000 characters
- Status symbols: ✅ (shipped), ❌ (dropped), ⏳ (deferred)
- Include all shipped + dropped features
- Timeline from sprint-report
- Metrics calculated from evaluations

### 5.3 release-handoff.md Format

```markdown
# Release Handoff — Sprint ABC123

**Release Generator**: Completed at [ISO timestamp]

## Release Summary

**Version**: v2026.090.1
**Released**: 2026-03-31
**Production URL**: https://...
**Status**: SUCCESS ✅

## Features Shipped

| Task | Title | Score | Link |
|------|-------|-------|------|
| PAP-1234 | [Title] | 33/40 | [GitHub PR](#) |

## Handoff Data

```json
{
  "sprintId": "ABC123",
  "version": "v2026.090.1",
  "shipped": [...],
  "dropped": [...],
  "metrics": {...}
}
```

---

## 6. Error Recovery Procedures

### 6.1 Common Errors

**Error: "GitHub token invalid (401)"**
- Check: `echo $GITHUB_TOKEN | head -c 10`
- Fix: Regenerate token in GitHub settings
- Verify: Token has `repo` scope
- Retry: `./scripts/release-generator.sh --sprint-id ABC123`

**Error: "Paperclip API unavailable (503)"**
- Check: Paperclip service status: `curl https://api.paperclip.ai/health`
- Wait: Automatic retry with exponential backoff (1s, 2s, 4s)
- Manual fix: Retry after service recovers
- Fallback: Generate changelog locally, update Paperclip manually later

**Error: "PR #123 not found"**
- Check: PR exists: `gh pr list | grep releases/sprint-ABC123`
- Fix: Specify correct PR number: `--pr-number 456`
- Or: Create tracking PR and retry

**Error: "CHANGELOG.md write failed (permission denied)"**
- Check: File permissions: `ls -la CHANGELOG.md`
- Fix: `chmod 644 CHANGELOG.md`
- Verify: `touch CHANGELOG.md.test && rm $_`
- Retry: `./scripts/release-generator.sh --sprint-id ABC123`

### 6.2 Recovery Workflow

If integration fails after changelog is generated:

1. **Check what succeeded**:
   ```bash
   git diff CHANGELOG.md          # Is it written?
   curl https://github.com/.../pulls/123/comments  # Is comment posted?
   paperclip-api get-task PAP-1234  # Is status updated?
   ```

2. **Identify failure point**:
   - CHANGELOG written + PR comment posted + Paperclip updated → SUCCESS ✅
   - CHANGELOG written + PR comment failed → Recover 3b
   - CHANGELOG written + Paperclip failed → Recover 3c
   - CHANGELOG write failed → Recover 3d

3. **Recover based on failure**:

   **3a. Complete success** → Nothing to do
   
   **3b. GitHub posting failed**:
   ```bash
   # Manual post
   cat releases/ABC123/pr-comment.md | gh pr comment 123 --body-file -
   # Or retry with flag
   ./scripts/release-generator.sh --sprint-id ABC123 --retry-github
   ```

   **3c. Paperclip update failed**:
   ```bash
   # List tasks to update
   grep "PAP-" CHANGELOG.md | grep "✅\|PASS"
   # Manual update each task to status "released"
   paperclip-api update-task PAP-1234 --status released --version v2026.090.1
   ```

   **3d. CHANGELOG write failed**:
   ```bash
   # Restore from backup
   cp CHANGELOG.md.backup CHANGELOG.md
   # Fix permissions or disk space
   ls -la CHANGELOG.md
   df -h
   # Retry
   ./scripts/release-generator.sh --sprint-id ABC123
   ```

### 6.3 Rollback Procedure

If everything fails and you need to start over:

```bash
# 1. Revert CHANGELOG
git checkout CHANGELOG.md

# 2. Delete failed PR comments (manual via GitHub UI)

# 3. Revert Paperclip updates
paperclip-api update-task PAP-1234 --status deployed  # (not "released")

# 4. Fix issues (token, permissions, etc.)

# 5. Retry the entire flow
./scripts/release-generator.sh --sprint-id ABC123 --force-regenerate
```

---

## 7. Testing the Release Flow

### 7.1 Local Testing (Dry-Run)

```bash
# 1. Navigate to repo
cd /Volumes/JS-DEV/paperclip

# 2. Set test environment
export GITHUB_TOKEN="ghp_test_xxxx"
export GITHUB_OWNER="paperclipai"
export GITHUB_REPO="paperclip"

# 3. Run in dry-run mode (no external changes)
./scripts/release-generator.sh \
  --sprint-id ABC123 \
  --dry-run

# 4. Review output (prints to console, no files written)
# Expected: [DRY RUN] CHANGELOG entry to be appended: ...
# Expected: [DRY RUN] GitHub PR comment to be posted: ...
# Expected: [DRY RUN] Would update Paperclip tasks: PAP-1234, PAP-1245
```

### 7.2 Pre-Release Checklist

Before running against production:

```
ARTIFACTS:
[ ] sprint-plan.md exists and is valid
[ ] task-breakdown.md exists and is valid
[ ] At least 1 handoff-*.md file exists
[ ] At least 1 eval-*.md file exists (for shipped features)
[ ] sprint-report.md shows Status: SHIPPED ✅

ENVIRONMENT:
[ ] GITHUB_TOKEN is set and valid (has repo scope)
[ ] Paperclip API is accessible (curl https://api.paperclip.ai/health)
[ ] Disk space available (df -h shows >100MB free)
[ ] File permissions allow writing to CHANGELOG.md

VERIFICATION:
[ ] Dry-run produces expected output
[ ] CHANGELOG.md structure looks correct
[ ] PR comment < 5000 characters
[ ] All PAP-IDs are valid (PAP-XXXX format)
[ ] All QA scores are valid (0-40 range)
```

### 7.3 Integration Test Fixtures

Test fixtures provided in `/tests/fixtures/release-generator/`:

- `valid-sprint-plan.md` — Example Phase 1 output
- `valid-task-breakdown.md` — Example Phase 1 output
- `valid-handoff-alpha.md` — Example engineer handoff
- `valid-handoff-beta.md` — Example engineer handoff
- `eval-pass.md` — Example PASS evaluation (34/40)
- `eval-fail.md` — Example FAIL evaluation (22/40)
- `valid-sprint-report.md` — Example deployment report
- `expected-changelog.md` — What output should look like
- `expected-pr-comment.txt` — What PR comment should look like

**Running tests**:

```bash
# Unit tests
npm test -- tests/unit/release-generator.test.ts

# Integration tests
npm test -- tests/integration/release-generator.test.ts

# E2E tests
npm test -- tests/e2e/release-flow.test.ts

# All tests
npm test
```

---

## 8. Debugging Guide

### 8.1 Enable Debug Logging

```bash
export DEBUG=sprint-release-generator:*

./scripts/release-generator.sh --sprint-id ABC123 --debug
```

Output includes:
- Parsing progress for each artifact
- Extracted data from each file
- API request/response pairs
- Generated content before writing
- File operations (write, backup, etc.)

### 8.2 Inspect Intermediate Outputs

```bash
# Check parsed artifacts
ls -la sprints/ABC123/

# Check generated changelog entry
cat releases/ABC123/changelog-entry.md

# Check generated PR comment
cat releases/ABC123/pr-comment.md

# Check release metadata
cat releases/ABC123/release-metadata.json | jq

# Check git status
git status
git diff CHANGELOG.md
```

### 8.3 Manual Artifact Inspection

```bash
# Verify sprint-plan structure
cat sprints/ABC123/sprint-plan.md | grep "Sprint ID\|**Date**\|## Tasks"

# Verify eval file structure
cat sprints/ABC123/eval-PAP-1234.md | grep "Task ID\|Overall Score\|Status"

# Count evaluations
ls -1 sprints/ABC123/eval-*.md | wc -l

# Check for missing evaluations
cat sprints/ABC123/task-breakdown.md | grep "^## PAP-" | while read line; do
  task_id=$(echo $line | cut -d: -f1 | xargs)
  [ ! -f "sprints/ABC123/eval-${task_id}.md" ] && echo "Missing: $task_id"
done
```

### 8.4 Verify External Integrations

```bash
# Test GitHub token
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/user

# Check Paperclip API
curl -H "Authorization: Bearer $PAPERCLIP_TOKEN" \
  https://api.paperclip.ai/v1/health

# List available PRs
gh pr list --state all | grep "releases/sprint"

# Check recent git tags
git tag | sort -V | tail -5
```

### 8.5 Performance Analysis

```bash
# Time the full generation
time ./scripts/release-generator.sh --sprint-id ABC123

# Profile parsing
./scripts/release-generator.sh --sprint-id ABC123 --profile-parsing

# Check memory usage
ps aux | grep release-generator

# Monitor file I/O
iotop -o  # (on Linux) or `fs_usage` (on macOS)
```

---

## 9. Configuration Reference

### 9.1 Environment Variables

```bash
# Required for GitHub integration
GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"  # GitHub personal access token
GITHUB_OWNER="paperclipai"               # Repository owner
GITHUB_REPO="paperclip"                  # Repository name

# Required for Paperclip integration
PAPERCLIP_TOKEN="pk_xxxxxxxxxxxxxxxxxxxx"  # Paperclip API key
PAPERCLIP_API="https://api.paperclip.ai"   # API endpoint

# Optional
DEBUG="sprint-release-generator:*"       # Enable debug logging
DRY_RUN="true"                           # Preview mode (no changes)
CHANGELOG_PATH="./CHANGELOG.md"          # Custom changelog location
SPRINT_DATA_DIR="./sprints"              # Custom artifacts directory
```

### 9.2 Configuration File

Optional: `/Volumes/JS-DEV/paperclip/release-generator.config.yml`

```yaml
# Release Generator Configuration

changelog:
  path: ./CHANGELOG.md
  backup_retention_days: 30
  validate_markdown: true

github:
  owner: paperclipai
  repo: paperclip
  pr_label_on_release: ["released", "changelog-generated"]
  auto_update_labels: true

paperclip:
  api_endpoint: https://api.paperclip.ai
  update_on_release: true
  update_fields:
    - status: "released"
    - releaseVersion: auto
    - releasedAt: auto

generation:
  calver_format: "v{year}.{dayofyear}.{patch}"
  include_contributors: true
  include_timeline: true
  pr_comment_char_limit: 5000
  drop_recommendations_limit: 5

artifacts:
  base_directory: ./sprints
  required_files:
    - sprint-plan.md
    - task-breakdown.md
    - sprint-report.md
  optional_files:
    - handoff-*.md
    - eval-*.md

retry:
  max_attempts: 3
  backoff_strategy: exponential
  backoff_delays_ms: [1000, 2000, 4000]
  retryable_status_codes: [408, 429, 500, 502, 503, 504]

validation:
  strict_mode: false
  warn_on_missing: true
  fail_on_error: false
```

---

## 10. FAQ & Troubleshooting

**Q: How long does release generation take?**
A: Typically 10-30 seconds for a sprint with 5-10 features. Includes artifact parsing (2-5s), content generation (1-3s), and API calls (5-20s depending on GitHub/Paperclip latency).

**Q: Can I regenerate a release?**
A: Yes, but the patch version will increment. Run `--force-regenerate` to append a new version number (e.g., v2026.090.1 → v2026.090.2). Previous version remains in CHANGELOG.

**Q: What if a feature's eval is updated after release?**
A: Re-run the generator. It recalculates everything from current artifact state. Create a new changelog entry (next patch version) with corrected information.

**Q: Can I edit the CHANGELOG manually?**
A: Not recommended. If you do, the generator may create duplicates or versioning conflicts. Always regenerate via the tool. Backups are kept in CHANGELOG.md.backup.

**Q: How do I handle V2+ features in the changelog?**
A: Features with V2+ label in task-breakdown.md are automatically listed under "Features Dropped" section with reason "Deferred to V2". They won't appear in "Features Shipped" even if QA passes.

**Q: What if GitHub is down?**
A: Changelog is still written to disk. Release comment won't post, but will be saved in `releases/[SPRINT-ID]/pr-comment.md` for manual posting later. Retry when service recovers.

**Q: Can I post the PR comment to a different PR?**
A: Yes: `--pr-number 456` to override auto-detection. Useful if using non-standard naming for tracking PR.

**Q: How do I revoke a release?**
A: Edit CHANGELOG.md to remove the section, revert Paperclip task status to "deployed", delete the GitHub PR comment, and commit changes to git with message "revert: revoked v2026.090.1 release".

---

## Related Documentation

- **SKILL.md** — Complete technical specification (`/skills/sprint-release-generator/SKILL.md`)
- **Phase 1 Design** — Sprint delivery process (`/docs/companies/sprint-co/PHASE-2-DESIGN.md`)
- **Paperclip API** — Issue tracking integration (`/docs/companies/sprint-co/integrations/paperclip-api-integration.md`)
- **Signaling Protocol** — Agent communication (`/docs/companies/sprint-co/integrations/signaling-protocol.md`)

---

**Last Updated**: 2026-03-31  
**Maintained By**: Release Automation Team  
**Questions?** Open an issue or contact @release-team

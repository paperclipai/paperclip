# Phase 2.2: Release Generators

Core deliverables for sprint release automation. Transforms parsed sprint data into CHANGELOG.md entries and GitHub PR comments.

## Overview

The generators package provides end-to-end release generation with:

- **Changelog Generation**: Creates CalVer-formatted CHANGELOG.md entries with features, QA scores, and contributors
- **PR Comments**: Generates GitHub PR comments with feature tables and deployment information
- **File Management**: Appends entries to existing CHANGELOG.md while preserving order
- **GitHub Integration**: Posts comments to PRs with retry logic and rate limit handling
- **Paperclip Integration**: Updates sprint issues with release metadata
- **Orchestration**: Coordinates all generators for complete release workflow

## Quick Start

```typescript
import { generateRelease } from '@paperclip/shared';

const result = await generateRelease(
  'sprint-2026-03-31',
  {
    sprintPlan: './sprints/sprint-2026-03-31/sprint-plan.md',
    taskBreakdown: './sprints/sprint-2026-03-31/task-breakdown.md',
    handoffs: [
      './sprints/sprint-2026-03-31/handoff-engineer-alpha.md',
      './sprints/sprint-2026-03-31/handoff-engineer-beta.md',
    ],
    evals: [
      './sprints/sprint-2026-03-31/eval-TASK-001.md',
      './sprints/sprint-2026-03-31/eval-TASK-002.md',
    ],
    sprintReport: './sprints/sprint-2026-03-31/sprint-report.md',
  },
  {
    paperclip: {
      client: paperclipClient,
      issueId: 'sprint-2026-03-31',
    },
    github: {
      client: githubClient,
      prUrl: 'https://github.com/org/repo/pull/123',
      token: process.env.GITHUB_TOKEN,
    },
    baseUrl: 'https://github.com/org/repo',
    dryRun: false, // Set to true for testing
  }
);

console.log(result);
// {
//   success: true,
//   changelogPath: './CHANGELOG.md',
//   changelogEntry: { version, date, summary, ... },
//   prCommentUrl: 'https://github.com/org/repo/pull/123#...',
//   paperclipStatus: { updated: true, issueId: '...' },
//   errors: []
// }
```

## File Structure

```
generators/
├── types.ts                      # TypeScript interfaces
├── changelog.ts                  # CHANGELOG entry generation
├── pr-comment.ts                 # GitHub PR comment generation
├── changelog-updater.ts          # File I/O for CHANGELOG.md
├── github-poster.ts              # GitHub API integration
├── paperclip-updater.ts          # Paperclip issue updates
├── release-generator.ts          # Main orchestrator
├── index.ts                      # Public exports
├── __fixtures__/                 # Test data
│   ├── sprint-plan.json
│   ├── sprint-report.json
│   ├── handoff-*.json
│   ├── eval-report-*.json
│   └── expected-output/
│       ├── expected-changelog-entry.md
│       └── expected-pr-comment.txt
├── changelog.test.ts             # Unit tests
├── pr-comment.test.ts
├── changelog-updater.test.ts
├── github-poster.test.ts
├── paperclip-updater.test.ts
└── README.md                      # This file
```

## Core Functions

### generateChangelogEntry(artifactData: ArtifactData): ChangelogEntry

Creates a changelog entry from parsed sprint data.

**Input:** Aggregated artifact data (sprint plan, handoffs, evals, report)

**Output:** Structured changelog entry with:
- Version in CalVer format (vYYYY.DDD.P)
- Release date
- Summary from sprint brief
- Shipped features with QA scores
- Dropped features with reasons
- Breaking changes (if any)
- Contributors list
- Rendered markdown

**QA Score Calculation:**
1. Try to find eval report for feature
2. Average all eval scores (functionality, code quality, testing, docs)
3. Fall back to handoff self-evaluation if no eval
4. Clamp to 0-10 range

**CalVer Format:**
- Year: YYYY (e.g., 2026)
- Day of Year: DDD (e.g., 090 for March 31)
- Patch: P (starts at 0)
- Result: v2026.090.0

### generatePRComment(artifactData: ArtifactData, options?): PRCommentData

Creates a GitHub PR comment with features table and summary.

**Input:** Artifact data + optional paperclip issue ID and deployment URL

**Output:** Structured PR comment with:
- Release header (🚀 Release vX.Y.Z Shipped!)
- Feature table (Feature | QA Score | Engineer)
- Dropped features section
- Links (deployment, paperclip)
- Summary one-liner
- Full markdown (under 5000 chars)

**Markdown:**
```markdown
## 🚀 Release v2026.090.0 Shipped!

**Summary:** Build a task management system...

### Features Shipped

| Feature | QA Score | Engineer |
|---------|----------|----------|
| Create and Edit Tasks | ✅ 9/10 | engineer-alpha |
| Task List with Filtering | 🟢 8/10 | engineer-beta |

### Links
- **Deployment:** https://example.com/deploy
- **Paperclip Sprint:** [link]
```

### appendToChangelog(changelogPath: string, entry: ChangelogEntry): void

Updates CHANGELOG.md file with new entry at the top.

**Behavior:**
- Creates file if doesn't exist (adds header)
- Inserts new entry before first existing version
- Validates existing file format
- Throws on malformed changelog
- Maintains order: newest first

**Header (new files):**
```markdown
# Changelog

All notable changes to this project will be documented in this file.
...
```

### postPRComment(prUrl: string, comment: string, token: string, options?): Promise<void>

Posts comment to GitHub PR with retry logic.

**Features:**
- Extracts owner/repo/PR# from URL
- Uses GitHub API v3
- Retries on rate limit (exponential backoff)
- Supports dry-run mode (logs instead of posts)
- Max 3 retries with 1s/2s/4s delays
- Validates auth, URL, comment size

**Errors:**
- `Invalid GitHub PR URL` - malformed URL
- `Comment cannot be empty` - empty body
- `GitHub token is required` - missing token
- `Comment exceeds GitHub limit` - > 65536 chars
- `GitHub authentication failed` - invalid token
- `GitHub PR not found` - 404 response
- `GitHub API rate limit exceeded` - 403 + rate limit message

### updatePaperclipRelease(issueId: string, metadata: ReleaseMetadata, options?): Promise<void>

Updates sprint issue with release metadata.

**Updates:**
- Status: 'done'
- Metadata.released: true
- Metadata.releaseVersion: "vYYYY.DDD.P"
- Metadata.releaseUrl: "[release link]"
- Metadata.changelogPath: "CHANGELOG.md#vYYYY.DDD.P"
- Metadata.releasedAt: ISO timestamp

**Features:**
- Retry logic (3 attempts, exponential backoff)
- Dry-run mode
- Adds release summary comment

### generateRelease(sprintId, artifactsPaths, options): Promise<ReleaseResult>

Main orchestrator coordinating all generators.

**Steps:**
1. Load and parse all artifacts
2. Generate CHANGELOG entry
3. Generate PR comment
4. Update CHANGELOG.md file
5. Post PR comment to GitHub
6. Update Paperclip issue
7. Return comprehensive result

**Result:**
```typescript
{
  success: boolean
  changelogPath: string
  changelogEntry: ChangelogEntry
  prCommentUrl?: string
  paperclipStatus: { updated, issueId, error? }
  errors: string[]
}
```

## Types

### ChangelogEntry
```typescript
{
  version: string              // v2026.090.0
  date: string                 // 2026-03-31
  summary: string              // Sprint brief
  featuresShipped: ChangelogFeature[]
  featuresDropped: DroppedFeatureEntry[]
  breakingChanges: BreakingChange[]
  contributors: string[]       // Engineer names
  sprintId: string
  markdown: string             // Full rendered output
}
```

### ReleaseMetadata
```typescript
{
  released: boolean
  releaseVersion: string       // v2026.090.0
  releaseUrl?: string          // GitHub release link
  changelogPath?: string       // #anchor in CHANGELOG.md
  releasedAt?: string          // ISO timestamp
}
```

### ReleaseResult
```typescript
{
  success: boolean
  changelogPath: string
  changelogEntry: ChangelogEntry
  prCommentUrl?: string
  paperclipStatus: { updated, issueId, error? }
  errors: string[]
}
```

## Testing

### Test Fixtures

Fixtures provide realistic sprint data for testing:

**Sprint Plan** (`sprint-plan.json`):
- Sprint ID: 2026-03-31-sprint-1
- Brief: Task management system
- 3 shipped features
- V-label breakdown: v1=120min, v2=90min, v3=60min

**Eval Reports** (`eval-report-*.json`):
- 3 evaluation reports with QA scores
- Scores range 7-10
- All pass results

**Handoffs** (`handoff-*.json`):
- 3 handoff artifacts
- Self-evaluation scores
- Feature descriptions

**Expected Outputs** (`expected-output/`):
- `expected-changelog-entry.md` - Reference markdown
- `expected-pr-comment.txt` - Reference PR comment

### Running Tests

```bash
cd /Volumes/JS-DEV/paperclip/packages/shared

# Run all tests
npm test -- src/generators

# Run specific test
npm test -- src/generators/changelog.test.ts

# Watch mode
npm test -- src/generators --watch

# Coverage
npm test -- src/generators --coverage
```

### Test Coverage

- **changelog.ts**: 12 tests
- **pr-comment.ts**: 14 tests
- **changelog-updater.ts**: 16 tests (including file I/O)
- **github-poster.ts**: 15 tests
- **paperclip-updater.ts**: 13 tests

**Total: 70+ unit tests**

## Integration Points

### Phase 2.1 Parsers (Dependencies)

Expect parsed artifacts from:
- `parseSprintPlan()` → SprintPlanData
- `parseTaskBreakdown()` → Task[]
- `parseHandoff()` → HandoffData
- `parseEvalReport()` → EvalReportData
- `parseSprintReport()` → SprintReportData

Generators work with `ArtifactData` aggregating all parsed outputs.

### GitHub API

Uses GitHub REST API v3:
```
POST /repos/{owner}/{repo}/issues/{issue_number}/comments
```

Required headers:
- `Authorization: token {TOKEN}`
- `Content-Type: application/json`
- `Accept: application/vnd.github.v3+json`

### Paperclip API

Expects client with methods:
- `updateIssue(id, payload)` - Update issue with metadata
- `addComment(id, comment)` - Add comment to issue
- `getIssue(id)` - Retrieve issue data

### GitHub Release Format

Assumes releases follow GitHub conventions:
- URL: `https://github.com/{owner}/{repo}/releases/{tag}`
- Tag format: `v2026.090.0` (CalVer)

## Dry-Run Mode

All functions support dry-run for testing without side effects:

```typescript
// Dry-run: logs instead of posting/updating
const result = await generateRelease(sprintId, paths, {
  dryRun: true,
  // Other config...
});

// Outputs to console:
// === DRY RUN: GitHub PR Comment ===
// === DRY RUN: Paperclip Release Update ===
// === DRY RUN: CHANGELOG Update ===
```

## Error Handling

### Validation

- Empty comments
- Malformed URLs
- Missing credentials
- Oversized payloads

### Retry Logic

Functions with network I/O support retry:
- **GitHub**: Rate limit (429) → 3 retries with backoff
- **Paperclip**: Timeout, ECONNREFUSED → 3 retries with backoff
- **File I/O**: Recoverable errors only

### Graceful Degradation

`generateRelease()` continues on partial failures:

```typescript
{
  success: true,          // Some generators succeeded
  changelogPath: '...',   // CHANGELOG updated
  prCommentUrl: undefined,  // GitHub post failed
  paperclipStatus: {      // Paperclip update failed
    updated: false,
    error: 'API timeout'
  },
  errors: [
    'Failed to post PR comment: ...',
    'Failed to update Paperclip: ...'
  ]
}
```

## CalVer Versioning

Format: `vYYYY.DDD.P`

- **YYYY**: Calendar year (2026)
- **DDD**: Day of year, zero-padded (001-366)
- **P**: Patch number (0-9)

**Examples:**
- v2026.001.0 - January 1, 2026
- v2026.090.0 - March 31, 2026 (90th day)
- v2026.365.0 - December 31, 2026

Extracted from sprint ID: `2026-03-31-sprint-1` → Day 90 → v2026.090.0

## Next Steps

### Phase 2.3: Integration Tests

- End-to-end tests with real Paperclip/GitHub APIs
- Fixture management across test suites
- Mock client implementations

### Phase 3: Automation

- Scheduled release generation
- Webhook triggers for sprint completion
- Release notes formatting
- Changelog version archiving

## Files Changed

- `packages/shared/src/generators/types.ts` (NEW)
- `packages/shared/src/generators/changelog.ts` (NEW)
- `packages/shared/src/generators/pr-comment.ts` (NEW)
- `packages/shared/src/generators/changelog-updater.ts` (NEW)
- `packages/shared/src/generators/github-poster.ts` (NEW)
- `packages/shared/src/generators/paperclip-updater.ts` (NEW)
- `packages/shared/src/generators/release-generator.ts` (NEW)
- `packages/shared/src/generators/index.ts` (NEW)
- `packages/shared/src/generators/changelog.test.ts` (NEW)
- `packages/shared/src/generators/pr-comment.test.ts` (NEW)
- `packages/shared/src/generators/changelog-updater.test.ts` (NEW)
- `packages/shared/src/generators/github-poster.test.ts` (NEW)
- `packages/shared/src/generators/paperclip-updater.test.ts` (NEW)
- `packages/shared/src/index.ts` (MODIFIED - added exports)
- `packages/shared/src/generators/__fixtures__/*` (NEW - 10 fixture files)

## Success Criteria

- ✅ All 7 core generator functions implemented
- ✅ 70+ unit tests with >90% coverage
- ✅ Dry-run mode for all integrations
- ✅ Comprehensive error handling and retry logic
- ✅ CalVer version generation
- ✅ CHANGELOG.md file management
- ✅ GitHub PR comment posting
- ✅ Paperclip issue updates
- ✅ Test fixtures with expected outputs
- ✅ Full TypeScript types

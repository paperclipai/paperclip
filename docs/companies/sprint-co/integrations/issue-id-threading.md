# Issue ID Threading & Context Recovery — Sprint Co

**Document Type**: System Architecture  
**Version**: 1.0  
**Last Updated**: 2026-03-31  
**Status**: ACTIVE  
**Target Audience**: Sprint Co agents and developers troubleshooting context loss

---

## Overview

Issue ID threading is the mechanism by which Sprint Co agents maintain execution context across sessions, agent transitions, and phase boundaries. When an agent crashes, loses state, or hands off to another agent, the issue ID acts as a "breadcrumb trail" to recover full execution context from Paperclip.

This document explains:
1. How issue IDs flow through sprint artifacts
2. How to reconstruct context from the issue tree
3. How context survives agent restarts and transitions
4. How to debug context loss and recover gracefully

---

## Part 1: Issue ID Topology

### Sprint Issue Tree

A complete sprint creates a hierarchy of Paperclip issues:

```
[Orchestrator] Creates: sprint-planning-[ID]
                   ↓
                   └─→ metadata.sprintId = "sprint-2026-03-31-001"
                   └─→ metadata.brief = "[brief text]"
                   └─→ assignedTo = "planner"

[Planner] Updates: sprint-planning-[ID] → status:done
          Creates: ./sprints/[sprintId]/sprint-plan.md
                   └─→ Header: Paperclip Sprint Issue: sprint-planning-[ID]
                   └─→ This links the artifact back to the issue

[Orchestrator] Creates: sprint-architecture-[ID]
                   ↓
                   └─→ parentIssueId = sprint-planning-[ID]
                   └─→ metadata.sprintId = "sprint-2026-03-31-001"
                   └─→ assignedTo = "lead"

[Lead] Updates: sprint-architecture-[ID] → status:done
       Creates: ./sprints/[sprintId]/task-breakdown.md
                └─→ Header: Paperclip Sprint Issue: sprint-architecture-[ID]

[Lead] Creates: feature-TASK-001-[ID], feature-TASK-002-[ID], ...
            └─→ parentIssueId = sprint-architecture-[ID]
            └─→ metadata.sprintId = "sprint-2026-03-31-001"
            └─→ metadata.taskId = "TASK-001" | "TASK-002" | ...
            └─→ assignedTo = "alpha" | "beta"

[Alpha] Creates: ./sprints/[sprintId]/handoff-alpha.md
            └─→ Header: Paperclip Sprint Issue: feature-TASK-001-[ID]
            └─→ Links to the feature issue

[QA] Creates: ./sprints/[sprintId]/eval-TASK-001.md
          └─→ Header: Paperclip Sprint Issue: feature-TASK-001-[ID]
          └─→ Same issue as the feature implementation

[Delivery] Reads all eval-*.md files and creates sprint-report.md
       └─→ Header: Paperclip Sprint Issue: sprint-planning-[ID]
       └─→ Links back to root issue for context
```

### Key Points About the Tree

1. **Root issue**: sprint-planning-[ID] is the root. All artifacts and decisions trace back to it.
2. **Parent linking**: Child issues have `parentIssueId` pointing to their parent.
3. **Task linking**: Feature issues have `metadata.taskId` for cross-referencing with task-breakdown.md.
4. **Phase progression**: Issue status changes (todo → blocked → done) mark phase boundaries.
5. **Agent handoff**: Reassigning an issue transfers ownership and wakes the next agent.

---

## Part 2: How Issue IDs Flow Through Artifacts

### Sprint Plan (Root Issue Reference)

```markdown
# Sprint Plan — sprint-2026-03-31-001

**Paperclip Sprint Issue**: issue-abc123

[rest of plan...]
```

The `Paperclip Sprint Issue` field stores the root issue ID. This allows all downstream agents to find the original brief and sprint metadata.

### Handoff Artifacts

When an engineer hands off their work to QA, the handoff artifact includes:

```markdown
# Handoff — TASK-001: User Authentication

**Paperclip Feature Issue**: issue-def456
**Paperclip Sprint Issue**: issue-abc123

[rest of handoff...]
```

Two issue IDs:
- `Paperclip Feature Issue`: The specific task issue (feature-TASK-001-[ID])
- `Paperclip Sprint Issue`: The root sprint issue for context recovery

### Eval Reports

```markdown
# Eval Report — TASK-001: User Authentication

**Paperclip Feature Issue**: issue-def456
**Paperclip Sprint Issue**: issue-abc123

[evaluation results...]
```

Same pattern: both feature issue and sprint issue for context.

### Sprint Report

```markdown
# Sprint Report — sprint-2026-03-31-001

**Paperclip Sprint Issue**: issue-abc123

[deployment results...]
```

Links back to the root issue to complete the circle.

---

## Part 3: Context Recovery Patterns

### Pattern 1: Agent Restarts (Missing Issue ID)

**Scenario**: Alpha engineer's machine crashes. They restart and need to know which task they were working on.

**Recovery Path**:

```typescript
// agents/engineer-alpha/recover.ts
async function recoverFromCrash(
  paperclip: PaperclipClient,
  agentSlug: string,
  sprintId: string
) {
  // 1. Find all unfinished issues assigned to this agent in this sprint
  const todoIssues = await paperclip.listIssues({
    assignedTo: agentSlug,
    status: 'todo',
  })
  
  const blockedIssues = await paperclip.listIssues({
    assignedTo: agentSlug,
    status: 'blocked',
  })
  
  const issues = [...todoIssues, ...blockedIssues]

  // 2. Filter by sprint
  const sprintIssues = issues.filter(
    (issue) => issue.metadata.sprintId === sprintId
  )

  if (sprintIssues.length === 0) {
    console.log('No active tasks. Sprint may be over or you have no tasks.')
    return null
  }

  if (sprintIssues.length > 1) {
    console.warn(
      `Multiple active tasks (${sprintIssues.length}). Picking first.`
    )
  }

  const issue = sprintIssues[0]
  console.log(`Recovered task: ${issue.id} (${issue.title})`)

  // 3. Reconstruct context from issue metadata
  return {
    featureIssueId: issue.id,
    taskId: issue.metadata.taskId,
    sprintId: issue.metadata.sprintId,
    status: issue.status, // 'todo' or 'blocked'
    failCount: issue.metadata.failCount || 0,
  }
}
```

**Result**: Agent recovers the task without manual intervention.

### Pattern 2: Agent Transition (Feature Ready for QA)

**Scenario**: Alpha hands off to QA. QA needs to find the handoff artifact and feature issue.

**Recovery Path**:

```typescript
// agents/qa/receive-handoff.ts
async function receiveHandoff(
  paperclip: PaperclipClient,
  featureIssueId: string
) {
  // 1. Get the feature issue
  const issue = await paperclip.getIssue(featureIssueId)

  // 2. Extract metadata
  const {
    sprintId,
    taskId,
    handoffPath,
  } = issue.metadata

  // 3. Verify assignment
  if (issue.assignedTo !== 'qa') {
    throw new Error(`Issue not assigned to QA (assigned to: ${issue.assignedTo})`)
  }

  // 4. Get handoff artifact from filesystem
  const handoffContent = await fs.promises.readFile(handoffPath, 'utf-8')

  // 5. Parse handoff to get acceptance criteria and test steps
  const testSteps = parseHandoff(handoffContent)

  console.log(`Received handoff for ${taskId}. Ready to test.`)
  return { issue, handoffContent, testSteps }
}
```

**Result**: QA automatically finds the handoff artifact and has all context needed to test.

### Pattern 3: Orchestrator Needs Overview (Mid-Sprint Status)

**Scenario**: Orchestrator wants to check which tasks are in progress, which are blocked, which passed QA.

**Recovery Path**:

```typescript
// agents/orchestrator/status-check.ts
async function getSprintStatus(
  paperclip: PaperclipClient,
  sprintId: string
) {
  // 1. Get root issue
  const rootIssue = await paperclip.getIssue(sprintId)

  // 2. Find all child issues
  const allIssues = await paperclip.listIssues({
    metadata: { sprintId },
  })

  // 3. Group by phase and status
  const status = {
    planning: allIssues.find((i) => i.metadata.phase === 'planning'),
    architecture: allIssues.find((i) => i.metadata.phase === 'architecture'),
    implementation: allIssues
      .filter((i) => i.metadata.phase === 'implementation')
      .map((i) => ({
        taskId: i.metadata.taskId,
        engineer: i.assignedTo,
        status: i.status, // 'todo', 'blocked', 'done'
        failCount: i.metadata.failCount || 0,
      })),
    qa: allIssues
      .filter((i) => i.metadata.phase === 'qa')
      .map((i) => ({
        taskId: i.metadata.taskId,
        result: i.metadata.result, // 'PASS' or 'FAIL'
        status: i.status,
      })),
    deployment: allIssues.find((i) => i.metadata.phase === 'deployment'),
  }

  return status
}
```

**Result**: Orchestrator gets complete sprint snapshot without querying each agent individually.

### Pattern 4: Context Loss Recovery (Missing File References)

**Scenario**: Delivery engineer deploys features but some handoff-*.md files are missing or at wrong paths.

**Recovery Path**:

```typescript
// agents/delivery/recover-missing-handoffs.ts
async function recoverMissingHandoffs(
  paperclip: PaperclipClient,
  sprintId: string
) {
  // 1. Find all features that passed QA
  const passingFeatures = await paperclip.listIssues({
    metadata: { phase: 'qa', result: 'PASS', sprintId },
  })

  // 2. For each feature, check if handoff file exists
  const recovered: Record<string, string> = {}

  for (const feature of passingFeatures) {
    const taskId = feature.metadata.taskId
    const expectedPath = `./sprints/${sprintId}/handoff-${feature.metadata.engineer}.md`

    // 3a. Check expected path
    if (fileExists(expectedPath)) {
      recovered[taskId] = expectedPath
      continue
    }

    // 3b. Check handoff path from issue metadata
    if (feature.metadata.handoffPath) {
      if (fileExists(feature.metadata.handoffPath)) {
        recovered[taskId] = feature.metadata.handoffPath
        continue
      }
    }

    // 3c. If not found, ask Paperclip API for it
    const comments = await paperclip.getComments(feature.id)
    const handoffComment = comments.find((c) =>
      c.content.includes('handoff')
    )

    if (handoffComment) {
      const path = extractPathFromComment(handoffComment.content)
      if (path && fileExists(path)) {
        recovered[taskId] = path
        console.log(`Recovered handoff for ${taskId}: ${path}`)
        continue
      }
    }

    // 3d. Last resort: error
    console.error(
      `Cannot find handoff for ${taskId}. Cannot deploy.`
    )
  }

  return recovered
}
```

**Result**: Delivery can reconstruct the sprint state even if file paths were incorrectly recorded.

---

## Part 4: Issue State Machine

### States and Transitions

```
        ┌──────────────────────────────────────┐
        │                                      │
        ▼                                      │
    [TODO]  ─────→  [BLOCKED]  ─────→  [DONE]
      │                 │                  ▲
      │                 │                  │
      └─────────────────┴──────────────────┘
         (fast path: direct to done)
```

**State meanings**:

- **TODO**: Issue created, awaiting agent action
- **BLOCKED**: Agent is waiting for dependency or feedback
- **DONE**: Agent completed the work and handed off

### Allowed Transitions

```typescript
const allowedTransitions: Record<IssueStatus, IssueStatus[]> = {
  'todo': ['blocked', 'done'],
  'blocked': ['todo', 'done'],
  'done': [], // final state
}
```

### Why State Matters

State drives **who can act**:

- **TODO** issue with `assignedTo: 'alpha'` → Alpha should be working
- **BLOCKED** issue → Someone has put a hold; Alpha should not proceed
- **DONE** issue → Handoff complete; next agent owns it now

---

## Part 5: Metadata Structure

### Root Issue Metadata

```typescript
interface RootIssueMetadata {
  phase: 'planning' // root always stays in planning phase
  sprintId: string // e.g., 'sprint-2026-03-31-001'
  brief: string // original brief text
  planIssueId?: string // link to sprint-plan.md
  architectureIssueId?: string // link to task-breakdown.md
  status: 'in-progress' | 'complete' | 'failed'
}
```

### Architecture Phase Metadata

```typescript
interface ArchitectureMetadata {
  phase: 'architecture'
  sprintId: string
  planIssueId: string // parent link
  breakdownPath?: string // path to task-breakdown.md
  taskCount?: number // how many V1 tasks
  estimatedTime?: number // total minutes
}
```

### Implementation Phase Metadata (Feature Issue)

```typescript
interface ImplementationMetadata {
  phase: 'implementation'
  sprintId: string
  taskId: string // e.g., 'TASK-001'
  engineer: 'alpha' | 'beta'
  architectureIssueId: string // parent link
  handoffPath?: string // path to handoff-[engineer].md
  version?: number // v1, v2, etc. (for refinement cycles)
  failCount?: number // how many times failed QA (0, 1, 2)
}
```

### QA Phase Metadata

```typescript
interface QAMetadata {
  phase: 'qa'
  sprintId: string
  taskId: string
  implementationIssueId: string // parent link
  evalPath?: string // path to eval-[taskId].md
  result?: 'PASS' | 'FAIL'
  scores?: {
    functionality: number
    productDepth: number
    visualDesign: number
    codeQuality: number
  }
  testDate?: string // ISO timestamp
}
```

### Deployment Phase Metadata

```typescript
interface DeploymentMetadata {
  phase: 'deployment'
  sprintId: string
  featureIds: string[] // all passing feature IDs
  deploymentUrl: string
  reportPath?: string // path to sprint-report.md
  deployTime?: string // ISO timestamp
  smokeTestsPassed?: boolean
}
```

---

## Part 6: Reconstructing Full Context

### Scenario: Orchestrator Needs to Know Sprint History

```typescript
async function reconstructSprintHistory(
  paperclip: PaperclipClient,
  sprintId: string
) {
  // Step 1: Get root issue
  const rootIssue = await paperclip.getIssue(sprintId)

  // Step 2: Get all child issues
  const allIssues = await paperclip.listIssues({
    metadata: { sprintId },
  })

  // Step 3: Build timeline
  const timeline = {
    created: rootIssue.createdAt,
    brief: rootIssue.metadata.brief,
    phases: {
      planning: {
        status: rootIssue.metadata.planIssueId ? 'started' : 'pending',
        completedAt: null,
      },
      architecture: {
        status: rootIssue.metadata.architectureIssueId ? 'started' : 'pending',
        completedAt: null,
      },
      implementation: {
        tasks: [],
        completedAt: null,
      },
      qa: {
        passed: [],
        failed: [],
        completedAt: null,
      },
      deployment: {
        status: 'pending',
        deployedAt: null,
      },
    },
  }

  // Step 4: Fill in details from child issues
  for (const issue of allIssues) {
    if (issue.metadata.phase === 'planning') {
      timeline.phases.planning.completedAt = issue.updatedAt
    }

    if (issue.metadata.phase === 'architecture') {
      timeline.phases.architecture.completedAt = issue.updatedAt
    }

    if (issue.metadata.phase === 'implementation') {
      timeline.phases.implementation.tasks.push({
        taskId: issue.metadata.taskId,
        engineer: issue.metadata.engineer,
        failCount: issue.metadata.failCount || 0,
      })
    }

    if (issue.metadata.phase === 'qa') {
      if (issue.metadata.result === 'PASS') {
        timeline.phases.qa.passed.push(issue.metadata.taskId)
      } else {
        timeline.phases.qa.failed.push(issue.metadata.taskId)
      }
    }

    if (issue.metadata.phase === 'deployment') {
      timeline.phases.deployment.deployedAt = issue.updatedAt
    }
  }

  return timeline
}
```

**Result**: Orchestrator can see the entire sprint history without manually querying multiple agents.

---

## Part 7: Debugging Context Loss

### Symptom 1: "Issue Not Found"

**Cause**: Issue ID is wrong or the issue was deleted.

**Diagnosis**:
```bash
# Check if issue exists
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# Should return 200 OK. If 404, the issue doesn't exist.
```

**Recovery**:
```typescript
// Reconstruct issue ID from sprint-plan.md
const planPath = `./sprints/${sprintId}/sprint-plan.md`
const planContent = await fs.promises.readFile(planPath, 'utf-8')
const issueIdMatch = planContent.match(/Paperclip Sprint Issue:\s+(\S+)/)
const issueId = issueIdMatch?.[1]

if (!issueId) {
  console.error('Cannot find issue ID in sprint-plan.md')
  console.error('You will need to manually recover or restart the sprint.')
  process.exit(1)
}
```

### Symptom 2: "Not Assigned to Me"

**Cause**: The issue was reassigned to someone else, or the agent slug doesn't match.

**Diagnosis**:
```bash
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | jq '.assignedTo'

# Should output: "qa" (not "qa-engineer", not "QA_Engineer")
```

**Recovery**:
```typescript
// Check AGENT_SLUG env var
if (issue.assignedTo !== process.env.AGENT_SLUG) {
  console.error(
    `Issue assigned to ${issue.assignedTo}, ` +
    `but AGENT_SLUG=${process.env.AGENT_SLUG}`
  )
  console.error('Check that AGENT_SLUG is set correctly in .env')
  process.exit(1)
}
```

### Symptom 3: "Wrong Issue Status"

**Cause**: Issue is in an unexpected state (e.g., 'done' when agent expected 'todo').

**Diagnosis**:
```bash
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | jq '.status'

# Should be 'todo', 'blocked', or 'done'
```

**Recovery**:
```typescript
// Check if issue is already done
if (issue.status === 'done') {
  console.log(
    'Issue is already marked done. ' +
    'This agent may have already completed the work.'
  )
  console.log('Check the issue history or comments for details.')

  const comments = await paperclip.getComments(issue.id)
  for (const comment of comments) {
    console.log(`[${comment.createdAt}] ${comment.author}: ${comment.content}`)
  }
}
```

### Symptom 4: "Missing Metadata"

**Cause**: Issue was created without proper metadata, or it wasn't updated.

**Diagnosis**:
```bash
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | jq '.metadata'

# Should contain sprintId, phase, and other required fields
```

**Recovery**:
```typescript
// Manually update issue with missing metadata
await paperclip.updateIssueStatus(issueId, issue.status, {
  phase: 'implementation',
  sprintId: sprintId,
  taskId: taskId,
  engineer: agentSlug,
  // ... other required fields
})

console.log('Updated issue metadata. Resuming work.')
```

### Symptom 5: "Issue Tree Broken"

**Cause**: Parent issue deleted, or parentIssueId is wrong.

**Diagnosis**:
```bash
# Get issue and check parentIssueId
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | jq '.parentIssueId'

# Try to get the parent
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[PARENT_ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# If 404, the parent is deleted
```

**Recovery**:
```typescript
// Find the root issue by traversing up the tree
async function findRootIssue(
  paperclip: PaperclipClient,
  startingIssueId: string
): Promise<string> {
  let currentId = startingIssueId
  const visited = new Set<string>()

  while (visited.size < 100) {
    // safety check: prevent infinite loops
    visited.add(currentId)

    const issue = await paperclip.getIssue(currentId)

    if (!issue.parentIssueId) {
      // Found root (no parent)
      return currentId
    }

    currentId = issue.parentIssueId
  }

  throw new Error('Cannot find root issue. Issue tree may be corrupted.')
}

const rootId = await findRootIssue(paperclip, issueId)
console.log(`Found root issue: ${rootId}`)
```

---

## Part 8: Thread-Safety & Concurrency

### Issue 1: Race Condition in Parallel Features

**Scenario**: Both Alpha and Beta update their respective feature issues at the same time.

**Problem**: If both use the same metadata structure, their updates could overwrite each other.

**Solution**: Use scoped metadata keys

```typescript
// Instead of:
await paperclip.updateIssueStatus(alphaFeatureId, 'done', {
  handoffPath: '/path/to/alpha/handoff.md', // ❌ Could be overwritten by beta
})

// Use:
await paperclip.updateIssueStatus(alphaFeatureId, 'done', {
  'engineer.alpha.handoffPath': '/path/to/alpha/handoff.md', // ✅ Scoped to alpha
})
```

### Issue 2: Issue Reassignment During Update

**Scenario**: QA finishes evaluation and tries to reassign to 'delivery', but Lead is simultaneously reassigning to 'alpha' for refinement.

**Problem**: Last write wins, and context can be lost.

**Solution**: Use optimistic concurrency with ETag

```typescript
async function reassignWithConcurrency(
  paperclip: PaperclipClient,
  issueId: string,
  newAssignee: string,
  expectedETag: string
) {
  try {
    return await paperclip.updateIssueStatus(
      issueId,
      'todo',
      { assignedTo: newAssignee },
      { ifMatch: expectedETag } // Conditional update
    )
  } catch (error) {
    if (error instanceof PaperclipError && error.statusCode === 412) {
      // Conflict: someone else updated the issue
      console.error(
        'Issue was updated by another agent. Fetching latest and retrying...'
      )

      const latest = await paperclip.getIssue(issueId)
      // Decide: should we still reassign? Or abort?
      // This requires business logic decision
    }
  }
}
```

---

## Part 9: Issue ID Best Practices

### DO

✅ **Always include issue ID in artifacts**
```markdown
# Handoff — TASK-001
**Paperclip Feature Issue**: issue-abc123
**Paperclip Sprint Issue**: issue-def456
```

✅ **Always recover from Paperclip if file path is wrong**
```typescript
const issue = await paperclip.getIssue(issueId)
const actualHandoffPath = issue.metadata.handoffPath
const handoffContent = await fs.promises.readFile(actualHandoffPath, 'utf-8')
```

✅ **Always verify assignment before acting**
```typescript
if (issue.assignedTo !== 'qa') {
  throw new Error(`Not assigned to me`)
}
```

✅ **Always update status when handing off**
```typescript
await paperclip.updateIssueStatus(issueId, 'done', {
  phase: 'implementation',
  handoffPath,
})
```

### DON'T

❌ **Don't hardcode issue IDs**
```typescript
// Bad
const issueId = 'issue-12345' // This changes per sprint!

// Good
const issueId = process.env.PAPERCLIP_TASK_ID || await findIssueBySprintId(...)
```

❌ **Don't assume file paths exist**
```typescript
// Bad
const content = fs.readFileSync('./sprints/sprint-001/handoff.md')

// Good
const issue = await paperclip.getIssue(issueId)
const actualPath = issue.metadata.handoffPath
const content = await fs.promises.readFile(actualPath, 'utf-8')
```

❌ **Don't create duplicate issues**
```typescript
// Bad
for (let i = 0; i < features.length; i++) {
  await paperclip.createIssue({ ... }) // Creates N issues every time!
}

// Good
const existing = await paperclip.listIssues({ metadata: { sprintId } })
if (existing.length === 0) {
  // Create fresh issues
}
```

❌ **Don't silently ignore assignment mismatches**
```typescript
// Bad
if (issue.assignedTo !== expectedAgent) {
  console.warn('Assignment mismatch') // Continues anyway
}

// Good
if (issue.assignedTo !== expectedAgent) {
  throw new Error(`Assignment mismatch: expected ${expectedAgent}, got ${issue.assignedTo}`)
}
```

---

## Part 10: Context Recovery Checklist

When context is lost or unclear, use this checklist:

```markdown
## Context Recovery Checklist

### 1. Locate the Root Issue
- [ ] Check sprint-plan.md for `Paperclip Sprint Issue`
- [ ] If not found, check Paperclip dashboard for sprint issues
- [ ] If still not found, ask Orchestrator for sprint ID

### 2. Verify Issue Assignment
- [ ] Get issue via API: `GET /issues/{id}`
- [ ] Check `assignedTo` field matches current agent slug
- [ ] If mismatch, either reassign or abort

### 3. Reconstruct Metadata
- [ ] Check `issue.metadata.phase` (should be expected phase)
- [ ] Check `issue.metadata.sprintId` (should match sprint)
- [ ] Check `issue.metadata.failCount` (if QA, how many times failed)
- [ ] If missing, update with `PATCH /issues/{id}`

### 4. Find Handoff Artifacts
- [ ] Check `issue.metadata.handoffPath`
- [ ] If path missing, check issue comments for artifact references
- [ ] If still missing, attempt to locate by convention: `./sprints/[sprintId]/handoff-[engineer].md`
- [ ] If file not found, ask the previous agent

### 5. Verify Child Issues
- [ ] Use `GET /issues?parentIssueId={id}` to find children
- [ ] Check that each child has proper metadata
- [ ] Look for stuck or orphaned issues

### 6. Review Issue History
- [ ] Use `GET /issues/{id}/comments` to see what happened
- [ ] Look for error messages, refinement notes, eval feedback
- [ ] Understand why issue is in current state

### 7. Decide on Recovery Action
- [ ] If issue is 'done': Check if work is actually complete, confirm with downstream agent
- [ ] If issue is 'blocked': Find out why it's blocked, decide if you can unblock
- [ ] If issue is 'todo': Proceed with normal work
```

---

## Summary

Issue ID threading ensures that Sprint Co agents can:

1. **Recover from crashes**: Find their task without manual intervention
2. **Hand off work**: Pass full context to the next agent
3. **Track progress**: Orchestrator can see status across all phases
4. **Debug failures**: Reconstruct what went wrong and who to ask
5. **Survive session breaks**: Context lives in Paperclip, not just in-memory

The key insight: **Issue IDs are breadcrumbs**. If you follow them, you can always find your way back to the original context.

Every artifact (sprint-plan.md, handoff-*.md, eval-*.md, sprint-report.md) includes the issue ID it came from. This makes it possible to reconstruct the entire sprint history from a single artifact if needed.

For technical details on using the Paperclip API with issue IDs, see `paperclip-api-integration.md`.

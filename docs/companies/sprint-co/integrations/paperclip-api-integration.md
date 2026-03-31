# Paperclip API Integration Guide — Sprint Co

**Document Type**: Integration Architecture  
**Version**: 1.0  
**Last Updated**: 2026-03-31  
**Status**: ACTIVE  
**Target Audience**: Engineers implementing Sprint Co skills and agents

---

## Overview

This document provides phase-by-phase Paperclip API integration patterns for Sprint Co. It complements `signaling-protocol.md` by providing concrete implementation details, code patterns, error handling, and troubleshooting guidance.

The guide assumes:
- Paperclip API v1 (REST, JWT auth)
- Node.js environment with native fetch
- Sprint artifacts stored in both filesystem and Paperclip issues
- All agents use standardized handoff artifact format with Paperclip metadata

---

## Part 1: Authentication & Setup

### Environment Variables Required

```bash
# .env (agent's environment)
PAPERCLIP_API_KEY=pk_live_[token]
PAPERCLIP_API_URL=https://api.paperclip.dev/v1
PAPERCLIP_RUN_ID=[UUID generated at sprint start]
SPRINT_ID=[sprint-YYYY-MM-DD-ID]
AGENT_SLUG=[orchestrator|planner|lead|alpha|beta|qa|delivery]
```

### Client Initialization

```typescript
// lib/paperclip.ts
interface PaperclipConfig {
  apiKey: string
  apiUrl: string
  runId: string
  agentSlug: string
}

class PaperclipClient {
  private config: PaperclipConfig
  private baseUrl: string

  constructor(config: PaperclipConfig) {
    this.config = config
    this.baseUrl = `${config.apiUrl}/companies/sprint-co`
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      'X-Paperclip-Run-Id': this.config.runId,
      'X-Agent-Slug': this.config.agentSlug,
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const error = await response.json()
      throw new PaperclipError(
        error.message || `HTTP ${response.status}`,
        response.status,
        error.code,
        error.details
      )
    }

    return response.json()
  }

  async getIssue(issueId: string): Promise<Issue> {
    return this.request('GET', `/issues/${issueId}`)
  }

  async updateIssueStatus(
    issueId: string,
    status: IssueStatus,
    metadata?: Record<string, unknown>
  ): Promise<Issue> {
    return this.request('PATCH', `/issues/${issueId}`, {
      status,
      metadata,
    })
  }

  async assignIssue(issueId: string, agentSlug: string): Promise<Issue> {
    return this.request('PATCH', `/issues/${issueId}`, {
      assignedTo: agentSlug,
    })
  }

  async mentionAgent(
    issueId: string,
    agentSlugs: string[]
  ): Promise<Comment> {
    const mentions = agentSlugs.map((slug) => `@${slug}`).join(' ')
    return this.createComment(issueId, mentions)
  }

  async createComment(issueId: string, content: string): Promise<Comment> {
    return this.request('POST', `/issues/${issueId}/comments`, {
      content,
    })
  }

  async listIssues(filter?: IssueFilter): Promise<Issue[]> {
    const params = new URLSearchParams()
    if (filter?.assignedTo) params.append('assignedTo', filter.assignedTo)
    if (filter?.status) params.append('status', filter.status)
    if (filter?.label) params.append('label', filter.label)

    const queryString = params.toString()
    return this.request(
      'GET',
      `/issues${queryString ? '?' + queryString : ''}`
    )
  }
}

class PaperclipError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode?: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'PaperclipError'
  }
}

export default PaperclipClient
```

### Singleton Pattern for Agent

```typescript
// lib/paperclip-singleton.ts
let client: PaperclipClient | null = null

export function initPaperclip(): PaperclipClient {
  if (client) return client

  const required = [
    'PAPERCLIP_API_KEY',
    'PAPERCLIP_API_URL',
    'PAPERCLIP_RUN_ID',
    'AGENT_SLUG',
    'SPRINT_ID',
  ]
  const missing = required.filter((key) => !process.env[key])

  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`)
  }

  // Validate SPRINT_ID format: should match pattern 'sprint-YYYY-MM-DD-NNN'
  const sprintId = process.env.SPRINT_ID!
  const sprintIdPattern = /^sprint-\d{4}-\d{2}-\d{2}-\d+$/
  if (!sprintIdPattern.test(sprintId)) {
    throw new Error(
      `Invalid SPRINT_ID format: "${sprintId}". ` +
      `Expected format: sprint-YYYY-MM-DD-NNN (e.g., sprint-2026-03-31-001)`
    )
  }

  client = new PaperclipClient({
    apiKey: process.env.PAPERCLIP_API_KEY!,
    apiUrl: process.env.PAPERCLIP_API_URL!,
    runId: process.env.PAPERCLIP_RUN_ID!,
    agentSlug: process.env.AGENT_SLUG!,
  })

  return client
}

export function getPaperclip(): PaperclipClient {
  if (!client) {
    throw new Error('Paperclip not initialized. Call initPaperclip() first.')
  }
  return client
}
```

---

## Part 2: Phase-by-Phase Integration Patterns

### Phase 1: Planning (Orchestrator → Planner)

**Goal**: Orchestrator creates a Paperclip issue, assigns to Planner, and passes brief.

#### Step 1a: Create Issue for Sprint

```typescript
// agents/orchestrator/create-sprint.ts
import PaperclipClient from '@/lib/paperclip'

async function createSprintIssue(
  paperclip: PaperclipClient,
  brief: string,
  sprintId: string
) {
  const issueResponse = await paperclip.createIssue({
    title: `Sprint Planning — ${sprintId}`,
    description: `**Brief**: "${brief}"\n\n**Status**: Assigned to Planner`,
    assignedTo: 'planner',
    labels: ['sprint', 'planning'],
    metadata: {
      sprintId,
      brief,
      phase: 'planning',
    },
  })

  console.log(`Created issue ${issueResponse.id}`)
  return issueResponse.id
}
```

#### Step 1b: Planner Reads Issue and Brief

```typescript
// agents/planner/read-brief.ts
async function readBriefFromPaperclip(
  paperclip: PaperclipClient,
  issueId: string
) {
  const issue = await paperclip.getIssue(issueId)

  if (issue.assignedTo !== 'planner') {
    throw new Error(
      `Issue not assigned to planner (assigned to: ${issue.assignedTo})`
    )
  }

  const brief = issue.metadata.brief
  const sprintId = issue.metadata.sprintId

  return { brief, sprintId, issueId }
}
```

#### Step 1c: Planner Creates sprint-plan.md

```typescript
// agents/planner/write-plan.ts
async function writePlanAndSignal(
  paperclip: PaperclipClient,
  issueId: string,
  planContent: string,
  sprintId: string
) {
  // 1. Write plan to filesystem
  const planPath = `./sprints/${sprintId}/sprint-plan.md`
  await fs.promises.writeFile(planPath, planContent)

  // 2. Update Paperclip issue status to 'done'
  const updatedIssue = await paperclip.updateIssueStatus(issueId, 'done', {
    phase: 'planning',
    planPath,
  })

  // 3. Mention Orchestrator to signal plan ready
  await paperclip.mentionAgent(issueId, ['orchestrator'])

  console.log(`Plan ready. Signaled orchestrator.`)
  return { issueId, planPath }
}
```

**Error Handling for Phase 1**:

```typescript
// Error: Issue not found
if (error instanceof PaperclipError && error.statusCode === 404) {
  console.error(`Issue ${issueId} not found. Check PAPERCLIP_TASK_ID.`)
  process.exit(1)
}

// Error: Not assigned to me
if (issue.assignedTo !== 'planner') {
  console.error(`Issue assigned to ${issue.assignedTo}, not planner`)
  process.exit(1)
}

// Error: Network timeout
if (error instanceof PaperclipError && error.statusCode === 504) {
  console.error('Paperclip API timeout. Retry in 5s...')
  await new Promise((r) => setTimeout(r, 5000))
  // retry
}
```

---

### Phase 2: Architecture (Orchestrator → Lead)

**Goal**: Create and assign architecture issue to Lead. Lead reads, creates task-breakdown.md, signals done.

#### Step 2a: Orchestrator Creates Architecture Issue

```typescript
// agents/orchestrator/create-architecture-issue.ts
async function createArchitectureIssue(
  paperclip: PaperclipClient,
  sprintId: string,
  planIssueId: string
) {
  const issueResponse = await paperclip.createIssue({
    title: `Sprint Architecture — ${sprintId}`,
    description: `Planning phase complete. Ready for architecture design.`,
    parentIssueId: planIssueId, // link to planning issue
    assignedTo: 'lead',
    labels: ['sprint', 'architecture'],
    metadata: {
      sprintId,
      phase: 'architecture',
      planIssueId,
    },
  })

  return issueResponse.id
}
```

#### Step 2b: Lead Scaffolds Repository

```typescript
// agents/lead/scaffold-repo.ts
async function scaffoldRepo(
  paperclip: PaperclipClient,
  issueId: string,
  sprintId: string
) {
  // 1. Get architecture issue
  const issue = await paperclip.getIssue(issueId)

  // 2. Create directory structure
  const sprintDir = `./sprints/${sprintId}`
  await fs.promises.mkdir(sprintDir, { recursive: true })

  // 3. Create task-breakdown.md with stub tasks
  const breakdownPath = `${sprintDir}/task-breakdown.md`
  const breakdownContent = generateTaskBreakdown(issue.metadata.sprintId)
  await fs.promises.writeFile(breakdownPath, breakdownContent)

  // 4. Signal done
  await paperclip.updateIssueStatus(issueId, 'done', {
    phase: 'architecture',
    breakdownPath,
  })

  await paperclip.mentionAgent(issueId, ['orchestrator'])

  console.log(`Architecture complete. Ready for implementation.`)
  return { issueId, breakdownPath }
}
```

---

### Phase 3: Implementation (Lead → Alpha/Beta)

**Goal**: Assign features to Alpha and Beta in parallel. Each engineer signals when ready.

#### Step 3a: Lead Assigns Features

```typescript
// agents/lead/assign-features.ts
async function assignFeaturesToEngineers(
  paperclip: PaperclipClient,
  sprintId: string,
  alphaFeatures: string[],
  betaFeatures: string[]
) {
  // Create feature issues for Alpha
  for (const feature of alphaFeatures) {
    const issue = await paperclip.createIssue({
      title: `[${sprintId}] ${feature.title}`,
      description: feature.acceptance_criteria.join('\n'),
      assignedTo: 'alpha',
      labels: ['sprint', 'implementation'],
      metadata: {
        sprintId,
        phase: 'implementation',
        engineer: 'alpha',
      },
    })

    console.log(`Assigned ${feature.title} to alpha (issue: ${issue.id})`)
  }

  // Create feature issues for Beta
  for (const feature of betaFeatures) {
    const issue = await paperclip.createIssue({
      title: `[${sprintId}] ${feature.title}`,
      description: feature.acceptance_criteria.join('\n'),
      assignedTo: 'beta',
      labels: ['sprint', 'implementation'],
      metadata: {
        sprintId,
        phase: 'implementation',
        engineer: 'beta',
      },
    })

    console.log(`Assigned ${feature.title} to beta (issue: ${issue.id})`)
  }
}
```

#### Step 3b: Engineer (Alpha/Beta) Implements and Signals QA

```typescript
// agents/engineer-alpha/implement-feature.ts
async function implementFeature(
  paperclip: PaperclipClient,
  featureIssueId: string,
  sprintId: string
) {
  // 1. Get feature issue
  const issue = await paperclip.getIssue(featureIssueId)

  // 2. Implement feature locally
  // ... (code implementation here)

  // 3. Create handoff artifact
  const handoffPath = `./sprints/${sprintId}/handoff-alpha.md`
  const handoffContent = generateHandoff(issue.metadata)
  await fs.promises.writeFile(handoffPath, handoffContent)

  // 4. Signal ready for QA
  await paperclip.updateIssueStatus(featureIssueId, 'done', {
    phase: 'implementation',
    engineer: 'alpha',
    handoffPath,
  })

  await paperclip.assignIssue(featureIssueId, 'qa')

  console.log(`Feature ready for QA. Assigned to qa.`)
  return { featureIssueId, handoffPath }
}
```

---

### Phase 4: QA Evaluation (QA → Engineer / Delivery)

**Goal**: QA tests, creates eval report, routes to either engineer (FAIL) or delivery (PASS).

#### Step 4a: QA Tests Feature

```typescript
// agents/qa/test-feature.ts
async function evaluateFeature(
  paperclip: PaperclipClient,
  featureIssueId: string,
  sprintId: string
) {
  // 1. Get handoff artifact from issue metadata
  const issue = await paperclip.getIssue(featureIssueId)
  const handoffPath = issue.metadata.handoffPath

  // 2. Run tests using Playwright
  const testResults = await runPlaywrightTests(handoffPath)

  // 3. Grade using 4-criteria rubric
  const scores = {
    functionality: calculateFunctionality(testResults),
    productDepth: calculateProductDepth(testResults),
    visualDesign: calculateVisualDesign(testResults),
    codeQuality: calculateCodeQuality(testResults),
  }

  const total = Object.values(scores).reduce((a, b) => a + b)
  const passed = total >= 24 // 6 per criterion minimum

  // 4. Create eval report
  const evalPath = `./sprints/${sprintId}/eval-${issue.id}.md`
  const evalContent = generateEvalReport(scores, testResults, passed)
  await fs.promises.writeFile(evalPath, evalContent)

  return { featureIssueId, evalPath, scores, passed }
}
```

#### Step 4b: QA Routes Based on Result

```typescript
// agents/qa/route-result.ts
async function routeEvalResult(
  paperclip: PaperclipClient,
  featureIssueId: string,
  evalPath: string,
  passed: boolean,
  engineer: 'alpha' | 'beta'
) {
  if (passed) {
    // PASS: assign to delivery
    await paperclip.assignIssue(featureIssueId, 'delivery')
    await paperclip.updateIssueStatus(featureIssueId, 'done', {
      phase: 'qa',
      result: 'PASS',
      evalPath,
    })

    console.log(`Feature PASSED. Assigned to delivery.`)
  } else {
    // FAIL: return to engineer
    await paperclip.assignIssue(featureIssueId, engineer)
    await paperclip.updateIssueStatus(featureIssueId, 'blocked', {
      phase: 'qa',
      result: 'FAIL',
      evalPath,
      failCount: (issue.metadata.failCount || 0) + 1,
    })

    // Mention engineer with eval report summary
    const summary = `QA FAIL — See ${evalPath} for details. Please refine.`
    await paperclip.createComment(featureIssueId, summary)

    console.log(`Feature FAILED. Returned to ${engineer}. Fail count: 1`)
  }
}
```

#### Step 4c: Engineer Responds to FAIL

```typescript
// agents/engineer-alpha/respond-to-qa-fail.ts
async function respondToQAFail(
  paperclip: PaperclipClient,
  featureIssueId: string,
  evalPath: string,
  sprintId: string
) {
  // 1. Read eval report
  const evalContent = await fs.promises.readFile(evalPath, 'utf-8')
  const requiredFixes = parseRequiredFixes(evalContent)

  // 2. Estimate fix time
  const estimatedMinutes = requiredFixes.reduce(
    (sum, fix) => sum + estimateFixTime(fix),
    0
  )

  if (estimatedMinutes < 20) {
    // Option A: Refine
    console.log(`Estimated ${estimatedMinutes} min to refine. Proceeding...`)

    // Apply fixes
    for (const fix of requiredFixes) {
      await applyFix(fix)
    }

    // Re-create handoff
    const handoffPath = `./sprints/${sprintId}/handoff-alpha-v2.md`
    const handoffContent = generateHandoff({ version: 2 })
    await fs.promises.writeFile(handoffPath, handoffContent)

    // Signal ready for QA again
    await paperclip.assignIssue(featureIssueId, 'qa')
    await paperclip.createComment(
      featureIssueId,
      `Refined and ready for re-eval. V2 handoff: ${handoffPath}`
    )
  } else {
    // Option B: Escalate to Lead (can't fix in time)
    const message = `Cannot refine in time (est: ${estimatedMinutes} min). Recommending pivot.`
    await paperclip.createComment(featureIssueId, `@lead ${message}`)
    await paperclip.mentionAgent(featureIssueId, ['lead'])
  }
}
```

**QA Fail State Tracking**:

```typescript
// Track fail count to enforce 2-cycle limit
async function checkFailLimit(
  paperclip: PaperclipClient,
  featureIssueId: string
) {
  const issue = await paperclip.getIssue(featureIssueId)
  const failCount = issue.metadata.failCount || 0

  if (failCount >= 2) {
    throw new Error(
      `Feature has failed QA ${failCount} times. Cannot retry. Escalate to orchestrator.`
    )
  }

  return failCount
}
```

---

### Phase 5: Deployment (Delivery → Orchestrator)

**Goal**: Delivery engineer deploys all passing features to production, signals Orchestrator.

#### Step 5a: Delivery Gathers Passing Features

```typescript
// agents/delivery/gather-features.ts
async function gatherPassingFeatures(
  paperclip: PaperclipClient,
  sprintId: string
) {
  const issues = await paperclip.listIssues({
    label: 'sprint',
    status: 'done',
  })

  const passing = issues.filter(
    (issue) =>
      issue.metadata.phase === 'qa' &&
      issue.metadata.result === 'PASS' &&
      issue.metadata.sprintId === sprintId
  )

  console.log(
    `Found ${passing.length} passing features for deployment.`
  )

  return passing
}
```

#### Step 5b: Delivery Deploys and Reports

```typescript
// agents/delivery/deploy-and-report.ts
async function deployAndReport(
  paperclip: PaperclipClient,
  rootIssueId: string,
  sprintId: string,
  passingFeatures: Issue[]
) {
  // 1. Deploy
  const deploymentUrl = await deployToProduction(sprintId)

  // 2. Run smoke tests
  const smokeTestsPassed = await runSmokeTests(deploymentUrl)

  if (!smokeTestsPassed) {
    throw new Error('Smoke tests failed. Rollback required.')
  }

  // 3. Create sprint report
  const reportPath = `./sprints/${sprintId}/sprint-report.md`
  const reportContent = generateSprintReport(
    sprintId,
    passingFeatures,
    deploymentUrl
  )
  await fs.promises.writeFile(reportPath, reportContent)

  // 4. Signal Orchestrator
  await paperclip.mentionAgent(rootIssueId, ['orchestrator'])
  await paperclip.createComment(
    rootIssueId,
    `Deployment complete. Live at ${deploymentUrl}. Report: ${reportPath}`
  )

  console.log(`Deployment complete. Sprint shipped.`)
  return { deploymentUrl, reportPath }
}
```

---

## Part 3: Error Handling Patterns

### Retry Strategy

```typescript
// lib/retry.ts
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    backoffMs?: number
    backoffMultiplier?: number
    shouldRetry?: (error: unknown) => boolean
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    backoffMs = 1000,
    backoffMultiplier = 2,
    shouldRetry = (error) =>
      error instanceof PaperclipError &&
      (error.statusCode === 429 || error.statusCode >= 500),
  } = options

  let lastError: unknown
  let delay = backoffMs

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (!shouldRetry(error)) {
        throw error
      }

      if (attempt < maxRetries - 1) {
        console.warn(
          `Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`
        )
        await new Promise((r) => setTimeout(r, delay))
        delay *= backoffMultiplier
      }
    }
  }

  throw lastError
}

// Usage
const issue = await withRetry(() => paperclip.getIssue(issueId))
```

### Circuit Breaker for Cascading Failures

```typescript
// lib/circuit-breaker.ts
class CircuitBreaker {
  private failureCount = 0
  private lastFailureTime: number | null = null
  private state: 'closed' | 'open' | 'half-open' = 'closed'

  constructor(
    private failureThreshold: number = 5,
    private resetTimeoutMs: number = 30000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - (this.lastFailureTime || 0) > this.resetTimeoutMs) {
        console.log('Circuit breaker: resetting to half-open')
        this.state = 'half-open'
      } else {
        throw new Error(
          'Circuit breaker is open. Paperclip API appears to be down.'
        )
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  private onSuccess() {
    this.failureCount = 0
    this.state = 'closed'
  }

  private onFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.failureCount >= this.failureThreshold) {
      console.error(
        `Circuit breaker opened after ${this.failureCount} failures`
      )
      this.state = 'open'
    }
  }
}

// Usage
const breaker = new CircuitBreaker()
const issue = await breaker.execute(() => paperclip.getIssue(issueId))
```

### Timeout Handling

```typescript
// lib/timeout.ts
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label?: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label || 'Operation'} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ])
}

// Usage
const issue = await withTimeout(
  paperclip.getIssue(issueId),
  10000,
  'Get issue'
)
```

---

## Part 4: Debugging & Diagnostics

### Request Logging

```typescript
// lib/paperclip-logger.ts
class PaperclipLogger {
  async logRequest(
    method: string,
    path: string,
    body?: unknown,
    requestId?: string
  ) {
    const id = requestId || crypto.randomUUID().slice(0, 8)
    console.log(`[${id}] → ${method} ${path}`)
    if (body) {
      console.log(`[${id}]   Body:`, JSON.stringify(body, null, 2))
    }
  }

  async logResponse(
    requestId: string,
    statusCode: number,
    responseTime: number,
    body?: unknown
  ) {
    console.log(`[${requestId}] ← ${statusCode} (${responseTime}ms)`)
    if (body) {
      console.log(`[${requestId}]   Response:`, JSON.stringify(body, null, 2))
    }
  }

  async logError(
    requestId: string,
    error: PaperclipError,
    responseTime: number
  ) {
    console.error(`[${requestId}] ✗ ${error.statusCode} (${responseTime}ms)`)
    console.error(`[${requestId}]   ${error.message}`)
    if (error.details) {
      console.error(`[${requestId}]   Details:`, error.details)
    }
  }
}
```

### Health Check

```typescript
// lib/paperclip-health.ts
async function healthCheck(paperclip: PaperclipClient): Promise<boolean> {
  try {
    const response = await fetch(
      `${process.env.PAPERCLIP_API_URL}/health`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.PAPERCLIP_API_KEY}`,
        },
      }
    )

    const data = await response.json()
    return data.status === 'ok'
  } catch (error) {
    console.error('Health check failed:', error)
    return false
  }
}

// Usage
const isHealthy = await healthCheck(paperclip)
if (!isHealthy) {
  console.error('Paperclip API is down. Aborting.')
  process.exit(1)
}
```

### Debugging Checklist

```markdown
## When Paperclip Integration Breaks

### 1. Verify Credentials
- [ ] PAPERCLIP_API_KEY is set and valid (should start with `pk_`)
- [ ] PAPERCLIP_API_URL is correct (https://api.paperclip.dev/v1)
- [ ] PAPERCLIP_RUN_ID is a valid UUID

### 2. Check Network
- [ ] Agent has internet connectivity
- [ ] No firewall/proxy blocking api.paperclip.dev
- [ ] DNS resolution works: `nslookup api.paperclip.dev`

### 3. Verify Issue State
- [ ] Issue exists: `GET /issues/{id}`
- [ ] Issue is assigned to current agent
- [ ] Issue is in expected status (todo, blocked, done)
- [ ] Issue has required metadata fields

### 4. Test API Directly
```bash
curl -X GET https://api.paperclip.dev/v1/companies/sprint-co/issues/[ID] \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
```

### 5. Check Logs
- [ ] Agent logs show successful connection
- [ ] Request/response IDs match in logs
- [ ] No timeout or 429 (rate limit) errors
- [ ] No 403 (auth) errors

### 6. Validate Payloads
- [ ] JSON is valid (use jq or online validator)
- [ ] Required fields are present
- [ ] No extraneous fields that API will reject
- [ ] Enum values match API spec (e.g., status must be 'todo', 'blocked', 'done')

### 7. Check Paperclip Dashboard
- [ ] Log in at https://paperclip.dev
- [ ] Navigate to Sprint Co company
- [ ] Find the issue in the UI
- [ ] Verify metadata and assignment
- [ ] Check activity log for recent changes
```

---

## Part 5: Common Pitfalls & Solutions

### Pitfall 1: Missing X-Paperclip-Run-Id Header

**Symptom**: Requests succeed but agent identities get mixed up between parallel runs.

**Solution**: Always include header in every request:
```typescript
headers['X-Paperclip-Run-Id'] = process.env.PAPERCLIP_RUN_ID!
```

### Pitfall 2: Assigning Issue to Wrong Agent Slug

**Symptom**: Feature is assigned to 'qa-engineer' instead of 'qa', so QA never gets notified.

**Solution**: Use standardized slugs from agent registry:
```typescript
const AGENT_SLUGS = {
  orchestrator: 'orchestrator',
  planner: 'planner',
  lead: 'lead',
  alphaEngineer: 'alpha',
  betaEngineer: 'beta',
  qaEngineer: 'qa',
  deliveryEngineer: 'delivery',
} as const
```

### Pitfall 3: Creating Duplicate Issues

**Symptom**: Multiple 'Sprint Planning' issues exist for the same sprint.

**Solution**: Always check if issue already exists before creating:
```typescript
async function getOrCreateSprintIssue(
  paperclip: PaperclipClient,
  sprintId: string
) {
  const existing = await paperclip.listIssues({
    label: 'sprint',
    metadata: { sprintId },
  })

  if (existing.length > 0) {
    return existing[0]
  }

  return await paperclip.createIssue({
    title: `Sprint Planning — ${sprintId}`,
    // ...
  })
}
```

### Pitfall 4: Forgetting to Update Issue Status

**Symptom**: Feature is "done" but issue status is still 'todo', so downstream agents don't know it's ready.

**Solution**: Always update status when handoff is complete:
```typescript
await paperclip.updateIssueStatus(issueId, 'done', {
  phase: 'implementation',
  handoffPath,
})
```

### Pitfall 5: Race Condition in Parallel Feature Development

**Symptom**: Both Alpha and Beta try to update the same file simultaneously, causing conflicts.

**Solution**: Use isolated handoff files per agent:
```
./sprints/[sprint-id]/handoff-alpha.md
./sprints/[sprint-id]/handoff-beta.md
```

### Pitfall 6: Losing Context After Session Reset

**Symptom**: Agent restarts and forgets which issue it was working on.

**Solution**: Always recover issue ID from Paperclip:
```typescript
async function recoverFromCrash(
  paperclip: PaperclipClient,
  agentSlug: string,
  sprintId: string
) {
  const issues = await paperclip.listIssues({
    assignedTo: agentSlug,
    status: 'todo',
  })

  const sprintIssues = issues.filter(
    (issue) => issue.metadata.sprintId === sprintId
  )

  if (sprintIssues.length === 0) {
    console.log('No active tasks found.')
    return null
  }

  return sprintIssues[0]
}
```

---

## Part 6: Testing the Integration

### Unit Test: PaperclipClient

```typescript
// tests/paperclip.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import PaperclipClient from '@/lib/paperclip'

describe('PaperclipClient', () => {
  let client: PaperclipClient

  beforeEach(() => {
    client = new PaperclipClient({
      apiKey: 'pk_test_123',
      apiUrl: 'https://api.test.paperclip.dev/v1',
      runId: 'test-run-id',
      agentSlug: 'planner',
    })
  })

  it('should construct valid request headers', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')

    try {
      await client.getIssue('issue-123')
    } catch {
      // Expected to fail due to mock
    }

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer pk_test_123',
          'X-Paperclip-Run-Id': 'test-run-id',
          'X-Agent-Slug': 'planner',
        }),
      })
    )
  })

  it('should retry on 429 (rate limit)', async () => {
    // Mock fetch to return 429 then 200
    let callCount = 0
    global.fetch = vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify({}), { status: 429 })
      }
      return new Response(JSON.stringify({ id: 'issue-123' }), {
        status: 200,
      })
    })

    const result = await withRetry(() => client.getIssue('issue-123'))
    expect(result.id).toBe('issue-123')
    expect(callCount).toBe(2)
  })

  it('should throw on 403 (auth error)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 403,
      })
    )

    await expect(client.getIssue('issue-123')).rejects.toThrow(
      PaperclipError
    )
  })
})
```

### Integration Test: Full Handoff Flow

```typescript
// tests/handoff-flow.integration.ts
describe('Handoff Flow Integration', () => {
  it('should complete planner → orchestrator handoff', async () => {
    const paperclip = new PaperclipClient({
      apiKey: process.env.PAPERCLIP_API_KEY!,
      apiUrl: process.env.PAPERCLIP_API_URL!,
      runId: crypto.randomUUID(),
      agentSlug: 'planner',
    })

    // 1. Get issue
    const issue = await paperclip.getIssue('test-issue-123')
    expect(issue.assignedTo).toBe('planner')

    // 2. Create plan
    const planPath = './test-sprint/sprint-plan.md'
    await fs.promises.writeFile(planPath, '# Test Plan')

    // 3. Signal ready
    await paperclip.updateIssueStatus('test-issue-123', 'done')

    // 4. Verify status change
    const updated = await paperclip.getIssue('test-issue-123')
    expect(updated.status).toBe('done')
  })
})
```

---

## Part 7: Deployment Checklist

Before deploying an agent with Paperclip integration:

```markdown
## Pre-Deployment Checklist

### Environment
- [ ] All env vars set (.env file exists and has no placeholder values)
- [ ] PAPERCLIP_API_KEY has been rotated in past 90 days
- [ ] PAPERCLIP_RUN_ID is generated fresh for each sprint
- [ ] AGENT_SLUG matches the registered agent name

### Code
- [ ] No hardcoded issue IDs or run IDs
- [ ] All API calls use retry wrapper
- [ ] Circuit breaker installed for Paperclip client
- [ ] Error logging is in place
- [ ] Health check passes before starting

### Testing
- [ ] Unit tests pass (PaperclipClient)
- [ ] Integration tests pass (handoff flow)
- [ ] Manual test: Can read issue, create comment, update status
- [ ] Manual test: Can recover from network interruption
- [ ] Manual test: Handles 5xx errors gracefully

### Monitoring
- [ ] Request/response logging is enabled
- [ ] Alerts set for circuit breaker open
- [ ] Dashboards show Paperclip API latency and error rates
- [ ] On-call runbook includes Paperclip troubleshooting

### Documentation
- [ ] README documents env var setup
- [ ] Runbook documents common failures and recovery
- [ ] Team has access to Paperclip dashboard
```

---

## Summary

This guide provides production-ready patterns for integrating Sprint Co agents with the Paperclip API. Key takeaways:

1. **Always use retry** for transient failures (429, 5xx)
2. **Always include headers** (X-Paperclip-Run-Id, X-Agent-Slug)
3. **Always verify assignment** before assuming ownership of an issue
4. **Always update status** when handoff is complete
5. **Always handle errors** — never silently swallow Paperclip API failures

Refer to `signaling-protocol.md` for the high-level handoff patterns. Refer to this document for implementation details.

For specific agent implementations, see:
- Orchestrator: Phase 1 (create issues) and Phase 5 (final signal)
- Planner: Phase 2 (read brief, create plan)
- Lead: Phase 3 (scaffold, assign features)
- Alpha/Beta: Phase 3-4 (implement, handle QA feedback)
- QA: Phase 4 (test, grade, route)
- Delivery: Phase 5 (deploy, report)

# Phase 1 Test Checklist — Sprint Co

**Document Type**: QA / Testing  
**Version**: 1.0  
**Last Updated**: 2026-03-31  
**Status**: ACTIVE  
**Purpose**: Verify all Phase 1 implementation changes work correctly in isolation and in integration

---

## Overview

This checklist provides test cases for all Phase 1 changes:

1. **Skill Modifications**: 5 skills updated (sprint-protocol, sprint-planner, sprint-generator, sprint-evaluator, sprint-delivery)
2. **Integration Guides**: 3 new documents (signaling-protocol, paperclip-api-integration, issue-id-threading)
3. **API Integration**: Paperclip coordination protocol implemented
4. **Issue ID Threading**: Context recovery mechanisms implemented
5. **End-to-End Flow**: All 10 handoff patterns working

**Test Scope**: Unit tests, integration tests, manual verification, and real-world scenario testing.

---

## Part 1: Skill Document Verification

### Test Set 1.1: sprint-protocol.md Changes

**Objective**: Verify Section 7 (Paperclip Coordination Protocol) is complete and correct.

#### Test 1.1.1: Document Structure
```
[ ] Section 7 exists and is titled "Paperclip Coordination Protocol"
[ ] Section 7.1: Role Slug Table present
    [ ] 7 agents listed: orchestrator, planner, lead, alpha, beta, qa, delivery
    [ ] Each agent has correct slug (lowercase, hyphenated)
    [ ] No typos in agent names
[ ] Section 7.2: Signal Definitions present
    [ ] QA signal: @qa-engineer [task]
    [ ] Delivery signal: @delivery-engineer [task]
    [ ] Engineer signal: @alpha | @beta [task]
    [ ] Lead signal: @sprint-lead [task]
    [ ] Orchestrator signal: @orchestrator [task]
[ ] Section 7.3: Status Values documented
    [ ] Values: 'todo', 'blocked', 'done'
    [ ] No extraneous values listed
[ ] Section 7.4: Environment Variables listed
    [ ] PAPERCLIP_API_KEY
    [ ] PAPERCLIP_API_URL
    [ ] PAPERCLIP_RUN_ID
    [ ] AGENT_SLUG
[ ] Section 7.5: Handoff Artifact Extension
    [ ] Paperclip fields documented
    [ ] X-Paperclip-Run-Id header documented
    [ ] Issue ID threading explained
```

#### Test 1.1.2: Content Accuracy
```
[ ] All signal definitions are mechanically sound (use Paperclip API)
[ ] Status transitions are valid (todo → blocked → done, no loops)
[ ] No conflicting rules (e.g., two different ways to signal same thing)
[ ] Links to signaling-protocol.md are present and correct
```

#### Test 1.1.3: Code Examples
```
[ ] Section 7 includes at least 2 code examples
[ ] Code examples are valid pseudocode or actual code
[ ] No syntax errors in examples
[ ] Examples reference correct API endpoints
```

### Test Set 1.2: sprint-planner.md Changes

**Objective**: Verify sprint-plan.md template includes Paperclip metadata.

#### Test 1.2.1: Template Changes
```
[ ] sprint-plan.md template includes new field: "Paperclip Sprint Issue"
[ ] Field position: Immediately after "Sprint Window" (before "Handoff to Sprint Lead")
[ ] Field format: "**Paperclip Sprint Issue**: [issue-id]"
[ ] Field is marked as required (or includes placeholder [issue-id])
```

#### Test 1.2.2: Documentation
```
[ ] Field is explained in the brief expansion methodology
[ ] Explanation states: "This is required for context recovery"
[ ] Example shows real issue ID format (not placeholder)
```

#### Test 1.2.3: Integration
```
[ ] Field is referenced in sprint-generator.md (engineer reads it)
[ ] Field is referenced in sprint-evaluator.md (QA reads it)
[ ] Field is referenced in sprint-delivery.md (delivery engineer reads it)
```

### Test Set 1.3: sprint-generator.md Changes

**Objective**: Verify code fence fix and product depth criteria are correct.

#### Test 1.3.1: Code Fence Fix (Issue 7)
```
[ ] Handoff artifact format uses quadruple backticks for outer fence
[ ] Outer fence: ````markdown
[ ] Inner bash blocks are triple backticks: ```bash
[ ] When code is rendered, inner blocks render correctly (no escape issues)
[ ] Markdown parser can parse the nested fences without errors
```

**Verification command**:
```bash
# Should render without errors
node -e "const m = require('markdown-it')(); const fs = require('fs'); const text = fs.readFileSync('/Volumes/JS-DEV/paperclip/skills/sprint-generator/SKILL.md', 'utf-8'); const start = text.indexOf('## 5. Handoff'); const end = text.indexOf('---', start); console.log(m.parse(text.substring(start, end)));"
```

#### Test 1.3.2: Product Depth Criteria (Issue 9)
```
[ ] Self-evaluation section renamed "Edge Cases" → "Product Depth"
[ ] Rubric Section 2 now called "Product Depth (0–10)" (in sprint-evaluator.md)
[ ] Criteria alignment: Self-eval table matches QA rubric exactly
    [ ] Functionality (0–10)
    [ ] Product Depth (0–10) — was "Edge Cases"
    [ ] Visual Design (0–10)
    [ ] Code Quality (0–10)
[ ] Product Depth checklist includes:
    [ ] Loading states
    [ ] Success feedback
    [ ] Empty states
    [ ] Error handling
```

#### Test 1.3.3: Handoff File Path Convention
```
[ ] Canonical path defined: ./sprints/[sprint-id]/handoff-[AGENT].md
[ ] Format is clear and unambiguous
[ ] [AGENT] is lowercase (alpha, beta, not Alpha, Beta)
[ ] Document explains why standard path matters (QA discovery)
```

### Test Set 1.4: sprint-evaluator.md Changes

**Objective**: Verify 4-criteria rubric and file path convention.

#### Test 1.4.1: Rubric Structure
```
[ ] 4 criteria, each with 0–10 scale:
    [ ] Criterion 1: Functionality (0–10)
    [ ] Criterion 2: Product Depth (0–10)
    [ ] Criterion 3: Visual Design (0–10)
    [ ] Criterion 4: Code Quality (0–10)
[ ] Each criterion has:
    [ ] Score table (10, 9, 8, 7, **6** [threshold], 5, ..., 0)
    [ ] Concrete FAIL examples
    [ ] Concrete PASS examples
[ ] Pass threshold is 6 per criterion
[ ] Total pass threshold is 24/40 (all four criteria ≥6)
```

#### Test 1.4.2: Product Depth Criterion
```
[ ] Criterion 2 is titled "Product Depth"
[ ] Measures: "Does this feel like a real product or a demo?"
[ ] Includes checks for:
    [ ] Loading states
    [ ] Empty states
    [ ] Success feedback
    [ ] Error handling
    [ ] Onboarding
    [ ] Polish
```

#### Test 1.4.3: File Path Convention
```
[ ] Canonical path defined: ./sprints/[sprint-id]/eval-[TASK-ID].md
[ ] Format is clear (uppercase TASK-ID)
[ ] Document explains: "Sprint Delivery checks for eval at this path"
[ ] No alternative paths mentioned (only one convention)
```

#### Test 1.4.4: Fail-Fast Rule (URL Reachability)
```
[ ] Section 2.1 includes pre-flight check
[ ] Check: Attempt to reach app URL before testing
[ ] Rule: If unreachable after 2 attempts, return Functionality=0/10, FAIL
[ ] Rationale: Cannot test app if it's not running
```

#### Test 1.4.5: Eval Report Format
```
[ ] Template includes all required sections
[ ] Test Evidence section includes:
    [ ] Setup (did app start?)
    [ ] Happy Path Test (step-by-step)
    [ ] Edge Case Results
    [ ] Viewport Tests (1280px, 768px)
[ ] Scores table includes:
    [ ] All 4 criteria
    [ ] Pass/Fail column (✅/❌)
    [ ] Key Finding column (one-liner)
```

### Test Set 1.5: sprint-delivery.md Changes

**Objective**: Verify deployment guide is complete and dates are templated.

#### Test 1.5.1: Document Completeness
```
[ ] Section 1: Pre-Deployment Checklist (exists and complete)
[ ] Section 2: Cloudflare Pages Deployment (complete with example)
[ ] Section 3: Cloudflare Workers Deployment (complete with example)
[ ] Section 4: Full-Stack Deployment (complete with example)
[ ] Section 5: Smoke Tests (automated and manual checks)
[ ] Section 6: Git Release Tagging (commit and tag format)
[ ] Section 7: Sprint Report Format (markdown template)
[ ] Section 8: Fallback Deployment Options (Vercel, Railway, Render, GH Pages)
```

#### Test 1.5.2: Date Templating
```
[ ] All hardcoded dates removed or templated
[ ] wrangler.toml config uses: compatibility_date = "YYYY-MM-DD — use today's date"
    [ ] Not: compatibility_date = "2024-01-01" (hardcoded)
[ ] Examples show format: "2026-03-31" (current date)
[ ] No future dates or outdated dates visible
```

#### Test 1.5.3: Configuration Examples
```
[ ] Workers config example:
    [ ] name = "sprint-[sprint-id]"
    [ ] main = "dist/worker.js"
    [ ] compatibility_date = "[YYYY-MM-DD]"
    [ ] compatibility_flags = ["nodejs_compat"]
[ ] Pages config example:
    [ ] name = "sprint-[sprint-id]"
    [ ] bucket = "./dist"
    [ ] compatibility_date = "[YYYY-MM-DD]"
```

#### Test 1.5.4: Report Template
```
[ ] sprint-report.md template includes:
    [ ] Status: SHIPPED ✅ / PARTIAL ⚠️ / FAILED ❌
    [ ] Production URL
    [ ] Deploy Time (HH:MM:SS)
    [ ] Features Shipped (table with QA scores)
    [ ] Features Dropped (table with V-label and reason)
    [ ] Sprint Timeline (milestone tracking)
    [ ] Git Release (tag, commit, repo)
    [ ] Recommendations for Jeremy
```

---

## Part 2: Integration Guide Verification

### Test Set 2.1: signaling-protocol.md

**Objective**: Verify all 10 handoff patterns and signal mechanics are defined.

#### Test 2.1.1: Handoff Patterns Coverage
```
[ ] Pattern 1: Orchestrator → Planner (brief → planning)
    [ ] Signal definition included
    [ ] API sequence documented
    [ ] Error cases handled
[ ] Pattern 2: Planner → Orchestrator (plan ready)
    [ ] Signal definition included
    [ ] API sequence documented
[ ] Pattern 3: Orchestrator → Lead (architecture)
    [ ] Signal definition included
    [ ] API sequence documented
[ ] Pattern 4: Lead → Alpha+Beta (parallel features)
    [ ] Signal definition included
    [ ] API sequence documented
[ ] Pattern 5: Alpha → QA (feature ready)
    [ ] Signal definition included
    [ ] API sequence documented
[ ] Pattern 6: QA → Alpha (FAIL)
    [ ] Signal definition included
    [ ] API sequence documented
    [ ] Fail count tracking mentioned
[ ] Pattern 7: QA → Lead (escalation after 2 fails)
    [ ] Signal definition included
    [ ] Escalation criteria documented
[ ] Pattern 8: QA → Delivery (PASS)
    [ ] Signal definition included
    [ ] API sequence documented
[ ] Pattern 9: Delivery → Orchestrator (deployment)
    [ ] Signal definition included
    [ ] API sequence documented
    [ ] Report creation documented
[ ] Pattern 10: Orchestrator → Closure (sprint end)
    [ ] Signal definition included
    [ ] Cleanup steps documented
```

#### Test 2.1.2: Signal Mechanics
```
[ ] 3 primitives defined:
    [ ] @-mention (wake without reassign)
    [ ] Assignment (transfer ownership)
    [ ] Status transition (signal state)
[ ] Rules documented:
    [ ] Budget cost (each signal costs budget time)
    [ ] One-signal rule (don't send duplicate signals)
    [ ] Parallelism (Alpha and Beta can work simultaneously)
[ ] Error recovery procedures:
    [ ] No-wake diagnosis (issue not found)
    [ ] Race conditions (simultaneous updates)
    [ ] Stuck agents (issue not transitioning)
    [ ] Signal loops (circular dependencies)
```

#### Test 2.1.3: Debugging Procedures
```
[ ] Debugging section includes:
    [ ] How to verify signal was received (check issue updated)
    [ ] How to check issue status (API call example)
    [ ] How to recover from lost signal (resend)
    [ ] How to debug stuck issue (check for blockers)
```

#### Test 2.1.4: Real Workflow Trace
```
[ ] Document includes end-to-end trace
[ ] Trace shows actual issue IDs and timestamps
[ ] Trace shows parallel feature development
[ ] Trace shows QA fail and refinement cycle
[ ] Trace shows successful deployment
```

### Test Set 2.2: paperclip-api-integration.md

**Objective**: Verify API patterns and code examples are complete and correct.

#### Test 2.2.1: Client Initialization
```
[ ] Environment variables documented (6 required vars)
[ ] PaperclipClient class defined with:
    [ ] Constructor with config
    [ ] request() method for API calls
    [ ] Proper headers (Authorization, X-Paperclip-Run-Id, X-Agent-Slug)
    [ ] Error handling (PaperclipError)
[ ] Singleton pattern implemented
[ ] initPaperclip() validates all env vars
```

#### Test 2.2.2: Phase-by-Phase Patterns
```
[ ] Phase 1 (Planning): Create issue, assign to planner, read brief
[ ] Phase 2 (Architecture): Create architecture issue, scaffold repo
[ ] Phase 3 (Implementation): Assign features, implement, signal ready
[ ] Phase 4 (QA): Test, evaluate, route (PASS or FAIL)
[ ] Phase 5 (Deployment): Gather features, deploy, report
```

#### Test 2.2.3: Error Handling
```
[ ] Retry strategy:
    [ ] Exponential backoff implemented
    [ ] shouldRetry() filter (429, 5xx)
    [ ] Max retries (default 3)
[ ] Circuit breaker:
    [ ] Tracks failure count
    [ ] Opens after threshold (default 5)
    [ ] Half-open recovery
    [ ] Exponential backoff on reset
[ ] Timeout handling:
    [ ] withTimeout() wrapper
    [ ] Configurable timeout (default 10s)
```

#### Test 2.2.4: Debugging Tools
```
[ ] Request logging:
    [ ] Method, path, body logged
    [ ] Request ID (for tracing)
    [ ] Response status and time logged
[ ] Health check:
    [ ] Verifies API is up
    [ ] Called before sprint starts
[ ] Debugging checklist:
    [ ] Credentials verification
    [ ] Network checks
    [ ] Issue state validation
    [ ] Direct API testing (curl example)
    [ ] Log inspection
    [ ] Payload validation
    [ ] Dashboard verification
```

#### Test 2.2.5: Testing Examples
```
[ ] Unit tests for PaperclipClient
[ ] Integration tests for handoff flow
[ ] Mock fetch for error scenarios
[ ] Real API testing (integration test)
```

### Test Set 2.3: issue-id-threading.md

**Objective**: Verify context recovery mechanisms are complete and practical.

#### Test 2.3.1: Issue Tree Documentation
```
[ ] Root issue (sprint-planning-[ID]) documented
[ ] Parent-child relationships documented
[ ] Metadata structure for each phase documented:
    [ ] Planning phase metadata
    [ ] Architecture phase metadata
    [ ] Implementation phase metadata
    [ ] QA phase metadata
    [ ] Deployment phase metadata
```

#### Test 2.3.2: Context Recovery Patterns
```
[ ] Pattern 1: Agent restart recovery (missing issue ID)
    [ ] Lists unfinished issues
    [ ] Filters by sprint
    [ ] Returns task context
[ ] Pattern 2: Agent transition (feature ready for QA)
    [ ] Gets feature issue
    [ ] Extracts metadata
    [ ] Verifies assignment
    [ ] Reads handoff artifact
[ ] Pattern 3: Orchestrator status check
    [ ] Gets root issue
    [ ] Finds all child issues
    [ ] Groups by phase and status
    [ ] Returns complete sprint snapshot
[ ] Pattern 4: Recovery of missing handoffs
    [ ] Checks multiple paths
    [ ] Uses API to recover path
    [ ] Handles missing files gracefully
```

#### Test 2.3.3: State Machine
```
[ ] State transitions documented:
    [ ] TODO → BLOCKED (waiting)
    [ ] TODO → DONE (complete)
    [ ] BLOCKED → TODO (retry)
    [ ] BLOCKED → DONE (bypass block)
[ ] Invalid transitions rejected
[ ] State meaning clear (who can act, when)
```

#### Test 2.3.4: Debugging Symptoms
```
[ ] Symptom 1: "Issue Not Found"
    [ ] Diagnosis procedure
    [ ] Recovery procedure
[ ] Symptom 2: "Not Assigned to Me"
    [ ] Diagnosis procedure
    [ ] Recovery procedure
[ ] Symptom 3: "Wrong Issue Status"
    [ ] Diagnosis procedure
    [ ] Recovery procedure
[ ] Symptom 4: "Missing Metadata"
    [ ] Diagnosis procedure
    [ ] Recovery procedure
[ ] Symptom 5: "Issue Tree Broken"
    [ ] Diagnosis procedure
    [ ] Root issue finder implementation
```

#### Test 2.3.5: Concurrency & Thread Safety
```
[ ] Race condition handling (parallel feature updates)
[ ] Optimistic concurrency (ETag-based updates)
[ ] Deadlock prevention
[ ] Metadata scoping (engineer.alpha.* vs engineer.beta.*)
```

---

## Part 3: Unit Tests

### Test Set 3.1: Paperclip Client

**Objective**: Test PaperclipClient class functionality.

#### Test 3.1.1: Initialization
```typescript
[ ] test('should require all env vars')
    [ ] Throws if PAPERCLIP_API_KEY missing
    [ ] Throws if PAPERCLIP_API_URL missing
    [ ] Throws if PAPERCLIP_RUN_ID missing
    [ ] Throws if AGENT_SLUG missing
[ ] test('should initialize with valid config')
    [ ] Creates client successfully
    [ ] Sets baseUrl correctly
    [ ] Stores config
```

#### Test 3.1.2: Request Headers
```typescript
[ ] test('should include Authorization header')
    [ ] Header format: "Bearer {apiKey}"
[ ] test('should include X-Paperclip-Run-Id header')
    [ ] Header value matches env var
[ ] test('should include X-Agent-Slug header')
    [ ] Header value matches env var
[ ] test('should include Content-Type header')
    [ ] Value: "application/json"
```

#### Test 3.1.3: API Methods
```typescript
[ ] test('getIssue(issueId)')
    [ ] Calls GET /issues/{issueId}
    [ ] Returns issue object
    [ ] Throws on 404
[ ] test('updateIssueStatus(issueId, status)')
    [ ] Calls PATCH /issues/{issueId}
    [ ] Includes status in body
    [ ] Returns updated issue
[ ] test('assignIssue(issueId, agentSlug)')
    [ ] Calls PATCH /issues/{issueId}
    [ ] Sets assignedTo in body
    [ ] Returns updated issue
[ ] test('mentionAgent(issueId, agentSlugs)')
    [ ] Calls POST /issues/{issueId}/comments
    [ ] Content includes @mentions
    [ ] Returns comment object
[ ] test('listIssues(filter)')
    [ ] Calls GET /issues with query params
    [ ] Supports filtering by assignedTo, status, label
    [ ] Returns array of issues
```

#### Test 3.1.4: Error Handling
```typescript
[ ] test('should throw PaperclipError on non-2xx')
    [ ] Includes statusCode
    [ ] Includes errorCode
    [ ] Includes details
[ ] test('should handle 403 (auth error)')
    [ ] Throws with clear message
[ ] test('should handle 404 (not found)')
    [ ] Throws with issue ID in message
[ ] test('should handle 429 (rate limit)')
    [ ] Does not throw (let retry wrapper handle it)
    [ ] Returns response for retry logic
```

### Test Set 3.2: Retry Wrapper

**Objective**: Test retry logic with exponential backoff.

#### Test 3.2.1: Success on First Attempt
```typescript
[ ] test('should return result on success')
    [ ] Calls fn once
    [ ] Returns result immediately
```

#### Test 3.2.2: Retry on Transient Failure
```typescript
[ ] test('should retry on 429 (rate limit)')
    [ ] First attempt fails with 429
    [ ] Waits backoffMs
    [ ] Retries and succeeds
    [ ] Returns success result
[ ] test('should retry on 503 (service unavailable)')
    [ ] First attempt fails with 503
    [ ] Retries with exponential backoff
    [ ] Succeeds on retry
```

#### Test 3.2.3: No Retry on Permanent Failure
```typescript
[ ] test('should not retry on 403 (auth error)')
    [ ] Throws immediately
    [ ] Does not wait
    [ ] Does not retry
[ ] test('should not retry on 400 (bad request)')
    [ ] Throws immediately
```

#### Test 3.2.4: Max Retries Exceeded
```typescript
[ ] test('should throw after maxRetries')
    [ ] All attempts fail
    [ ] Throws last error
    [ ] Has attempted maxRetries times
```

### Test Set 3.3: Circuit Breaker

**Objective**: Test circuit breaker pattern.

#### Test 3.3.1: Closed State
```typescript
[ ] test('should pass through on success')
    [ ] Executes fn
    [ ] Returns result
    [ ] Remains closed
```

#### Test 3.3.2: Open State
```typescript
[ ] test('should open after failureThreshold')
    [ ] Fails 5 times in a row
    [ ] Opens on 5th failure
    [ ] Throws "circuit breaker is open" on next call
```

#### Test 3.3.3: Half-Open State
```typescript
[ ] test('should recover to half-open after resetTimeout')
    [ ] Circuit opens
    [ ] Waits resetTimeoutMs
    [ ] Transitions to half-open
    [ ] Attempts next call
```

#### Test 3.3.4: Half-Open Success
```typescript
[ ] test('should close after successful half-open call')
    [ ] Circuit in half-open
    [ ] Call succeeds
    [ ] Returns to closed
    [ ] Clears failureCount
```

---

## Part 4: Integration Tests

### Test Set 4.1: Full Handoff Flow

**Objective**: Test end-to-end handoff patterns (requires Paperclip test instance).

#### Test 4.1.1: Planning Phase Handoff
```typescript
[ ] test('orchestrator → planner → orchestrator')
    [ ] Orchestrator creates sprint issue
    [ ] Planner reads issue
    [ ] Planner creates sprint-plan.md
    [ ] Planner updates issue status to 'done'
    [ ] Paperclip issue is marked done
    [ ] Planner can read back the issue and see status='done'
```

#### Test 4.1.2: Architecture Phase Handoff
```typescript
[ ] test('orchestrator → lead → orchestrator')
    [ ] Orchestrator creates architecture issue
    [ ] Lead reads issue
    [ ] Lead creates task-breakdown.md
    [ ] Lead updates issue status to 'done'
    [ ] Orchestrator can see 'done' status
```

#### Test 4.1.3: Implementation Phase Handoff
```typescript
[ ] test('lead → alpha → qa')
    [ ] Lead creates feature issue for alpha
    [ ] Alpha reads issue (assignedTo=alpha)
    [ ] Alpha implements feature
    [ ] Alpha creates handoff-alpha.md
    [ ] Alpha updates issue status to 'done' and reassigns to 'qa'
    [ ] QA can read issue (assignedTo=qa, status=done)
    [ ] QA can read handoff artifact
```

#### Test 4.1.4: QA Phase Handoff (PASS Path)
```typescript
[ ] test('qa → delivery (PASS)')
    [ ] QA creates eval report
    [ ] QA scores ≥24 (all criteria ≥6)
    [ ] QA updates issue with result='PASS'
    [ ] QA reassigns to 'delivery'
    [ ] Delivery can read issue (result=PASS)
    [ ] Delivery proceeds to deployment
```

#### Test 4.1.5: QA Phase Handoff (FAIL Path)
```typescript
[ ] test('qa → alpha (FAIL, first attempt)')
    [ ] QA creates eval report
    [ ] QA scores <24
    [ ] QA updates issue with result='FAIL'
    [ ] QA reassigns to 'alpha'
    [ ] QA increments failCount to 1
    [ ] Alpha can read issue (result=FAIL, failCount=1)
[ ] test('qa → alpha (FAIL, second attempt)')
    [ ] Alpha refines based on feedback
    [ ] Alpha re-submits (handoff-alpha-v2.md)
    [ ] QA tests again
    [ ] QA scores <24 again
    [ ] QA increments failCount to 2
    [ ] Issue is escalated to lead
[ ] test('qa → lead (escalation after 2 FAILs)')
    [ ] failCount=2 triggers escalation
    [ ] QA mentions lead in issue
    [ ] Lead receives escalation notification
    [ ] Lead can decide: drop, simplify, or continue
```

#### Test 4.1.6: Deployment Phase Handoff
```typescript
[ ] test('delivery → orchestrator (complete)')
    [ ] Delivery gathers all passing features
    [ ] Delivery deploys to production
    [ ] Delivery runs smoke tests
    [ ] Deployment succeeds
    [ ] Delivery creates sprint-report.md
    [ ] Delivery mentions orchestrator
    [ ] Orchestrator receives completion signal
```

### Test Set 4.2: Context Recovery

**Objective**: Test that agents can recover from crashes/restarts.

#### Test 4.2.1: Agent Restart
```typescript
[ ] test('alpha restarts and recovers task')
    [ ] Alpha has task issue in 'todo' state
    [ ] Alpha crashes
    [ ] Alpha restarts (new session)
    [ ] Alpha calls recoverFromCrash()
    [ ] Function queries Paperclip for unfinished tasks
    [ ] Returns the task issue
    [ ] Alpha can read full context from issue metadata
```

#### Test 4.2.2: Missing File Path
```typescript
[ ] test('qa recovers handoff path from issue metadata')
    [ ] Handoff file exists but path in issue is wrong
    [ ] QA reads issue
    [ ] QA calls getHandoffPath()
    [ ] Function checks issue.metadata.handoffPath
    [ ] Function attempts to find by convention
    [ ] Function finds the correct file
    [ ] QA can read and test
```

#### Test 4.2.3: Issue Tree Navigation
```typescript
[ ] test('agent can walk up issue tree')
    [ ] Child issue has parentIssueId
    [ ] Agent calls findParent()
    [ ] Function queries parent issue
    [ ] Returns parent metadata
    [ ] Agent can walk all the way to root
    [ ] Root issue has no parent
```

### Test Set 4.3: Parallel Feature Development

**Objective**: Test Alpha and Beta working simultaneously without conflicts.

#### Test 4.3.1: Parallel Implementation
```typescript
[ ] test('alpha and beta do not conflict')
    [ ] Lead creates issue-alpha and issue-beta
    [ ] Alpha reads issue-alpha (assignedTo=alpha)
    [ ] Beta reads issue-beta (assignedTo=beta)
    [ ] Both implement simultaneously
    [ ] Alpha creates ./sprints/[id]/handoff-alpha.md
    [ ] Beta creates ./sprints/[id]/handoff-beta.md
    [ ] No file conflicts
    [ ] Both can be evaluated independently
```

#### Test 4.3.2: Parallel QA
```typescript
[ ] test('qa evaluates both features without blocking')
    [ ] Alpha feature 1 ready for QA
    [ ] Beta feature 2 ready for QA
    [ ] QA evaluates feature 1
    [ ] Beta can start QA on feature 2 (no blocking)
    [ ] QA creates eval-TASK-001.md
    [ ] QA creates eval-TASK-002.md
    [ ] Both are independent
```

#### Test 4.3.3: Race Condition Handling
```typescript
[ ] test('simultaneous updates do not cause data loss')
    [ ] Alpha updates issue-alpha at T0
    [ ] Beta updates issue-beta at T0 (same time)
    [ ] Both use different metadata keys (engineer.alpha.*, engineer.beta.*)
    [ ] No overwrites
    [ ] Both updates succeed
```

---

## Part 5: Manual Verification Tests

### Test Set 5.1: Documentation Consistency

**Objective**: Manually verify all documents are internally consistent.

#### Test 5.1.1: Issue ID Threading References
```
Checklist: All 5 skills reference issue ID threading correctly
[ ] sprint-protocol.md mentions Paperclip issue ID fields
[ ] sprint-planner.md includes Paperclip Sprint Issue field
[ ] sprint-generator.md includes Paperclip Feature Issue field
[ ] sprint-evaluator.md includes Paperclip Feature Issue field
[ ] sprint-delivery.md references Paperclip Sprint Issue field

Cross-reference check:
[ ] Each document that creates artifacts documents the issue ID field
[ ] Each document that reads artifacts knows where issue ID is
[ ] No conflicting field names (all use "Paperclip [Type] Issue")
```

#### Test 5.1.2: Canonical Path Consistency
```
Check: All documents use canonical file paths
[ ] Handoff path: ./sprints/[sprint-id]/handoff-[AGENT].md
[ ] Eval path: ./sprints/[sprint-id]/eval-[TASK-ID].md
[ ] Plan path: ./sprints/[sprint-id]/sprint-plan.md
[ ] Breakdown path: ./sprints/[sprint-id]/task-breakdown.md
[ ] Report path: ./sprints/[sprint-id]/sprint-report.md

Check: No alternative paths documented
[ ] sprint-generator.md uses only canonical handoff path
[ ] sprint-evaluator.md uses only canonical eval path
[ ] No "also could be at" variations
```

#### Test 5.1.3: Status Transition Consistency
```
Check: All documents use same status values
[ ] Documents never use 'pending', 'in_progress', 'completed'
[ ] Always use: 'todo', 'blocked', 'done'
[ ] sprint-protocol.md defines statuses
[ ] All other docs reference these statuses (no invention)
```

#### Test 5.1.4: Signal Definition Consistency
```
Check: All documents define signals the same way
[ ] @orchestrator
[ ] @planner
[ ] @lead
[ ] @alpha
[ ] @beta
[ ] @qa
[ ] @delivery

Check: No alternative slug names
[ ] Not: @orchestrator-agent, @orchestrator_agent, @Orchestrator
[ ] Consistent lowercase, hyphenated form
```

### Test Set 5.2: Artifact Generation

**Objective**: Manually create sample artifacts and verify they match templates.

#### Test 5.2.1: Generate sample sprint-plan.md
```
Steps:
1. Read sprint-plan.md template from sprint-planner.md
2. Fill in placeholder values
3. Verify sections:
   [ ] # Sprint Plan — [Sprint ID]
   [ ] **Paperclip Sprint Issue**: [issue-id]
   [ ] Product Spec section
   [ ] Sprint Backlog section (V1, V2, V3)
   [ ] Risk Assessment
   [ ] Handoff to Sprint Lead
4. Check that Paperclip Sprint Issue field is present and in right place
```

#### Test 5.2.2: Generate sample handoff-alpha.md
```
Steps:
1. Read handoff template from sprint-generator.md
2. Fill in sample values
3. Verify sections:
   [ ] # Handoff — [TASK-ID]: [Feature]
   [ ] **Paperclip Feature Issue**: [issue-id]
   [ ] **Paperclip Sprint Issue**: [issue-id]
   [ ] Status section (READY FOR QA)
   [ ] What Was Built
   [ ] Files Changed
   [ ] How to Run
   [ ] How to Test
   [ ] Self-Evaluation
   [ ] Known Issues
   [ ] QA Notes
4. Check markdown renders correctly (no escaping issues)
5. Check bash code blocks render correctly (quadruple fence)
```

#### Test 5.2.3: Generate sample eval-TASK-001.md
```
Steps:
1. Read eval template from sprint-evaluator.md
2. Fill in sample values
3. Verify sections:
   [ ] # Eval Report — [TASK-ID]: [Feature]
   [ ] **Paperclip Feature Issue**: [issue-id]
   [ ] Result: PASS ✅ or FAIL ❌
   [ ] Scores table (4 criteria)
   [ ] Test Evidence
   [ ] What Works Well
   [ ] Required Fixes (or empty if PASS)
   [ ] Optional Improvements
   [ ] Notes to Engineer
   [ ] Next Action
4. Verify pass/fail is determined by: total ≥24 AND all ≥6
```

#### Test 5.2.4: Generate sample sprint-report.md
```
Steps:
1. Read report template from sprint-delivery.md
2. Fill in sample values
3. Verify sections:
   [ ] # Sprint Report — Sprint [ID]
   [ ] **Paperclip Sprint Issue**: [issue-id]
   [ ] Status: SHIPPED ✅ / PARTIAL ⚠️ / FAILED ❌
   [ ] Production section (URL, Type, Deploy Time)
   [ ] Features Shipped (table)
   [ ] Features Dropped (table)
   [ ] Sprint Timeline (milestones)
   [ ] Git Release (tag, commit)
   [ ] Recommendations for Jeremy
4. Verify that all shipped features have eval reports
5. Verify that dropped features have reasons
```

### Test Set 5.3: Real-World Scenario Testing

**Objective**: Simulate a real sprint with all agents and phases.

#### Test 5.3.1: Sprint-Co Mini Simulation
```
Setup:
- Use test Paperclip instance (or mock)
- Use test sprint ID: sprint-2026-03-31-test-001
- Use test brief: "Build a simple task list app"

Execution:
[ ] Orchestrator creates root issue
    [ ] Paperclip Sprint Issue: [recorded]
[ ] Planner reads brief, creates sprint-plan.md
    [ ] Includes Paperclip Sprint Issue: [same as root]
[ ] Orchestrator creates architecture issue
    [ ] Parent link to planning issue
[ ] Lead reads brief and plan, creates task-breakdown.md
    [ ] Lists 3 features (V1 scope)
[ ] Lead creates feature issues for Alpha and Beta
    [ ] Alpha gets TASK-001 (auth)
    [ ] Beta gets TASK-002 (list display)
[ ] Alpha and Beta implement simultaneously
    [ ] Create handoff-alpha.md and handoff-beta.md
    [ ] Both include Paperclip Feature Issue IDs
[ ] QA evaluates both
    [ ] Creates eval-TASK-001.md (PASS)
    [ ] Creates eval-TASK-002.md (PASS)
    [ ] Both total ≥24
[ ] Delivery deploys
    [ ] Creates sprint-report.md
    [ ] Includes deployment URL
    [ ] References Paperclip Sprint Issue
[ ] All issue IDs thread correctly through artifacts
    [ ] Can trace any artifact back to root
    [ ] Can recover context from any phase
```

#### Test 5.3.2: QA Fail & Refinement Path
```
Same setup as above, but:
[ ] QA evaluates TASK-002
    [ ] Score <24 (FAIL)
    [ ] eval-TASK-002.md marked FAIL
    [ ] Required fixes listed
[ ] QA reassigns to Beta
    [ ] Issues assignedTo=beta again
    [ ] Beta reads eval report
[ ] Beta refines implementation
    [ ] Creates handoff-beta-v2.md
    [ ] Addresses required fixes
[ ] QA evaluates again
    [ ] Score ≥24 (PASS)
    [ ] Feature can now be deployed
```

#### Test 5.3.3: Context Loss Recovery
```
During the simulation:
[ ] At any point, simulate agent restart
    [ ] Agent crashes
    [ ] Agent session lost
    [ ] Agent restarts
    [ ] Call recoverFromCrash()
    [ ] Recover task from Paperclip
    [ ] Continue work without manual intervention
```

---

## Part 6: Checklist Completion Matrix

Track test completion:

```markdown
## Test Completion Tracking

### Part 1: Skill Document Verification
[ ] Test Set 1.1: sprint-protocol.md (3 tests)
[ ] Test Set 1.2: sprint-planner.md (3 tests)
[ ] Test Set 1.3: sprint-generator.md (3 tests)
[ ] Test Set 1.4: sprint-evaluator.md (5 tests)
[ ] Test Set 1.5: sprint-delivery.md (4 tests)

**Subtotal**: 18 tests

### Part 2: Integration Guide Verification
[ ] Test Set 2.1: signaling-protocol.md (4 tests)
[ ] Test Set 2.2: paperclip-api-integration.md (5 tests)
[ ] Test Set 2.3: issue-id-threading.md (5 tests)

**Subtotal**: 14 tests

### Part 3: Unit Tests
[ ] Test Set 3.1: Paperclip Client (4 test groups)
[ ] Test Set 3.2: Retry Wrapper (4 test groups)
[ ] Test Set 3.3: Circuit Breaker (4 test groups)

**Subtotal**: ~40 individual unit tests

### Part 4: Integration Tests
[ ] Test Set 4.1: Full Handoff Flow (6 test scenarios)
[ ] Test Set 4.2: Context Recovery (3 test scenarios)
[ ] Test Set 4.3: Parallel Development (3 test scenarios)

**Subtotal**: 12 integration tests

### Part 5: Manual Verification
[ ] Test Set 5.1: Documentation Consistency (4 checklist items)
[ ] Test Set 5.2: Artifact Generation (4 artifacts)
[ ] Test Set 5.3: Real-World Scenarios (3 simulations)

**Subtotal**: 11 manual tests

---

## Overall Status

**Total Tests**: ~95 unit + integration + manual tests

**Prerequisites**:
- [ ] All Phase 1 code changes deployed
- [ ] Paperclip test instance available (or mock setup)
- [ ] Test data seeded (test sprint, test brief)
- [ ] Agent endpoints accessible
- [ ] Filesystem setup for artifacts

**Success Criteria**:
- [ ] All Part 1 & 2 tests pass (documentation correct)
- [ ] All Part 3 unit tests pass
- [ ] All Part 4 integration tests pass
- [ ] All Part 5 manual tests pass
- [ ] No critical issues found
- [ ] No regressions in existing functionality
```

---

## Appendix: Test Execution Guide

### Running Unit Tests

```bash
# Run all unit tests
npm test

# Run specific test file
npm test -- tests/paperclip.test.ts

# Run with coverage
npm test -- --coverage
```

### Running Integration Tests

```bash
# Requires Paperclip test instance and env vars set
export PAPERCLIP_API_KEY=pk_test_...
export PAPERCLIP_API_URL=https://api.test.paperclip.dev/v1
export PAPERCLIP_RUN_ID=$(uuidgen)

# Run integration tests only
npm test -- --testMatch="**/tests/**/*.integration.ts"
```

### Manual Testing Procedure

1. **Read all documents**: Verify structure and consistency (Part 1-2)
2. **Create sample artifacts**: Generate examples, verify rendering (Part 5.2)
3. **Simulate sprint**: Run through all phases with test data (Part 5.3)
4. **Stress test**: Try to break context recovery (Part 5.3.3)
5. **Document results**: Record any issues found and resolutions

---

## Sign-Off

When all tests pass:

```markdown
## Phase 1 QA Sign-Off

- [x] All skill documents verified
- [x] All integration guides complete
- [x] All unit tests passing
- [x] All integration tests passing
- [x] All manual tests complete
- [x] No critical issues
- [x] Documentation is correct and consistent

**Approved for Phase 2** (Release Changelog Integration)

Signed: QA Engineer  
Date: [Date]
```

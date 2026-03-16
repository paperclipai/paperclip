# Paperclip Platform - UAT Test Plan

**Test Plan Version:** 1.0
**Created:** March 16, 2026
**Scope:** Phases 0-3 (Foundation, Multi-LLM, Agent Chat, Workflow Builder, Agent Creation)
**Status:** Ready for Testing

---

## Test Objectives

1. Verify all features work as designed
2. Validate data integrity and persistence
3. Confirm security and authorization controls
4. Test error handling and edge cases
5. Validate performance under normal load
6. Ensure UI/UX meets requirements

---

## Test Environment Setup

### Prerequisites
- Docker Desktop running
- PostgreSQL with pgvector support
- Node.js 18+
- Build completed successfully (`npm exec pnpm -- build` passes)

### Application Startup
```bash
cd C:\DevAps\DeskAI\paperclip\.claude\worktrees\focused-ramanujan
docker-compose up -d
npm start
# App available at http://localhost:5173 (frontend)
# API available at http://localhost:3000 (backend)
```

### Test Data Setup
```bash
# Create test company
POST /api/companies
{
  "name": "Test Company",
  "issuePrefix": "TEST"
}

# Note company ID for subsequent tests
```

---

## Test Cases by Phase

### PHASE 0: Foundation & Setup

#### T0.1: Docker Deployment
- [ ] Docker container starts without errors
- [ ] PostgreSQL database initializes
- [ ] pgvector extension loads
- [ ] All migrations run successfully
- [ ] Database schema is correct

**Expected Result:** All tables created with correct columns and indexes

#### T0.2: Application Startup
- [ ] Server starts on port 3000
- [ ] Frontend builds and serves on port 5173
- [ ] No startup errors in logs
- [ ] Health check endpoint responds: `/health` → 200 OK

**Expected Result:** Application is ready to use

#### T0.3: TypeScript Compilation
- [ ] All packages compile without errors
- [ ] No type mismatches
- [ ] All imports resolve correctly
- [ ] Strict mode enabled and passes

**Expected Result:** Build output shows "✅ All packages: Build SUCCESS"

---

### PHASE 1: Multi-LLM Provider Settings

#### T1.1: Provider Registry
- [ ] List all 7 supported providers via GET /api/llm/providers
  - OpenRouter
  - Anthropic
  - OpenAI
  - HuggingFace
  - Ollama
  - Custom

**Expected Result:** All 7 providers listed with correct configuration schema

#### T1.2: Model Browser
- [ ] Load model browser UI
- [ ] Select provider "OpenRouter"
- [ ] Models populate dynamically
- [ ] Select different provider
- [ ] Models update correctly

**Expected Result:** Model list matches provider capabilities

#### T1.3: Company LLM Settings
- [ ] POST /companies/{id}/llm-settings with provider credentials
- [ ] Validate credentials are encrypted
- [ ] Retrieve settings via GET
- [ ] Update settings via PUT
- [ ] Verify previous settings are overwritten

**Expected Result:** Company settings persist and update correctly

#### T1.4: User LLM Credentials
- [ ] User sets personal LLM credentials
- [ ] Credentials isolated from other users
- [ ] User can override company defaults
- [ ] Credentials are never exposed in logs

**Expected Result:** Credentials are secure and properly isolated

---

### PHASE 2: Quick Hire Wizard + Agent Chat

#### T2.1: Agent Creation via Wizard
- [ ] Navigate to "New Agent" or "Create Agent"
- [ ] Select agent role (CEO, Developer, Designer, etc.)
- [ ] Wizard provides AI suggestions for:
  - Agent name
  - System prompt
  - Capabilities
- [ ] User can customize suggestions
- [ ] Confirm and create agent

**Expected Result:** New agent created with correct role and system prompt

#### T2.2: Agent Details Page
- [ ] Agent appears in agent list
- [ ] Agent detail page loads
- [ ] Shows agent info: name, role, status, LLM provider/model
- [ ] Status updates reflect current state (idle, active, paused, terminated)

**Expected Result:** All agent information displays correctly

#### T2.3: Agent Chat Interface
- [ ] Navigate to agent detail → Chat tab
- [ ] Chat interface loads
- [ ] Type message: "Hello, what can you do?"
- [ ] Message appears in chat
- [ ] Agent responds (if LLM configured)
- [ ] Response appears in chat
- [ ] Timestamp shows for each message

**Expected Result:** Chat UI is functional and messages persist

#### T2.4: Chat History
- [ ] Multiple messages in chat
- [ ] Refresh page
- [ ] Chat history persists
- [ ] No duplicate messages

**Expected Result:** Chat history is persistent and accurate

#### T2.5: Agent Actions
- [ ] Invoke button triggers agent execution
- [ ] Agent status changes to "running"
- [ ] Invoke completes (status → idle or error)
- [ ] Pause/Resume buttons work
- [ ] Terminate button removes agent

**Expected Result:** Agent lifecycle actions work correctly

---

### PHASE 3A-3B: Workflow Foundation

#### T3A.1: Workflow Database
- [ ] Workflows table created
- [ ] Workflow runs table created
- [ ] Workflow run steps table created
- [ ] All foreign keys working
- [ ] Indexes for performance

**Expected Result:** Database schema is correct

#### T3A.2: Workflow CRUD API
- [ ] POST /companies/{id}/workflows - Create workflow
- [ ] GET /companies/{id}/workflows - List workflows
- [ ] GET /companies/{id}/workflows/{id} - Get details
- [ ] PUT /companies/{id}/workflows/{id} - Update workflow
- [ ] DELETE /companies/{id}/workflows/{id} - Delete workflow

**Expected Result:** All CRUD operations work correctly

#### T3A.3: Workflow UI
- [ ] Navigate to Workflows page
- [ ] "New Workflow" button visible
- [ ] Click to create new workflow
- [ ] Workflow editor loads with canvas
- [ ] ReactFlow canvas is interactive
- [ ] Can drag/drop nodes

**Expected Result:** Workflow UI is functional

---

### PHASE 3C: Execution Engine

#### T3C.1: Workflow Scheduler
- [ ] Schedule workflow with cron: "0 9 * * *" (daily at 9 AM)
- [ ] Save workflow
- [ ] Check workflow runs at scheduled time
- [ ] Log entry created for scheduled run

**Expected Result:** Cron scheduling works

#### T3C.2: Variable Interpolation
- [ ] Create workflow with trigger node
- [ ] Add action node with variables: `{{ triggerData.timestamp }}`
- [ ] Execute workflow
- [ ] Variables are replaced with actual values

**Expected Result:** Variables interpolate correctly

#### T3C.3: Workflow Execution
- [ ] Create simple workflow: trigger → action → complete
- [ ] Execute workflow via API
- [ ] Workflow run created with status "running"
- [ ] Execution completes
- [ ] Execution logs available

**Expected Result:** Workflow executes sequentially

#### T3C.4: Conditional Logic
- [ ] Create workflow with condition node
- [ ] Set condition: "if trigger.value > 10"
- [ ] Add two action paths (true/false)
- [ ] Execute with different trigger values
- [ ] Correct path executes

**Expected Result:** Conditional execution works

---

### PHASE 3D: API Routes

#### T3D.1: Execution Trigger
- [ ] POST /companies/{id}/workflows/{workflowId}/run
- [ ] Response: 202 Accepted with runId
- [ ] Workflow executes asynchronously
- [ ] Can query run status separately

**Expected Result:** Async execution and status tracking works

#### T3D.2: Run History
- [ ] GET /companies/{id}/workflows/{id}/runs
- [ ] List of all runs returned
- [ ] Each run shows: status, duration, error (if any)
- [ ] GET /companies/{id}/workflows/runs/{runId}
- [ ] Full run details including step execution

**Expected Result:** Run history is accurate and complete

---

### PHASE 3E: Advanced Triggers & Actions

#### T3E.1: HTTP Request Action
- [ ] Add HTTP request action to workflow
- [ ] Configure: POST to httpbin.org/post
- [ ] Add custom headers
- [ ] Add JSON body
- [ ] Execute workflow
- [ ] HTTP request completes
- [ ] Response captured in workflow run

**Expected Result:** HTTP actions work correctly

#### T3E.2: Webhook Trigger
- [ ] Create workflow with webhook trigger
- [ ] Webhook endpoint created
- [ ] Receive webhook secret
- [ ] POST JSON to webhook URL
- [ ] Workflow executes
- [ ] Webhook payload available in workflow variables

**Expected Result:** Webhooks trigger workflows

#### T3E.3: Create Issue Action
- [ ] Add "create-issue" action to workflow
- [ ] Configure issue properties
- [ ] Execute workflow
- [ ] Issue created with correct data

**Expected Result:** Issue creation from workflow works

#### T3E.4: Add Comment Action
- [ ] Add "add-comment" action to workflow
- [ ] Configure comment text with variables
- [ ] Execute workflow
- [ ] Comment added to issue

**Expected Result:** Comments are added correctly

---

### Phase 3 Extension: Agent Creation

#### T3X.1: CEO Agent Team Member Creation (UI)
- [ ] Login as CEO agent
- [ ] Navigate to agent detail page
- [ ] "Team" button visible in header
- [ ] Click "Team" button
- [ ] "Create Team Member" button visible
- [ ] Click to expand form

**Expected Result:** Team creation UI is accessible

#### T3X.2: Create Team Member Form
- [ ] Form fields: name, role, description, llmProvider, llmModel
- [ ] Fill form: name="Alice", role="Developer", etc.
- [ ] Select LLM provider: "OpenRouter"
- [ ] Select model: "claude-3-5-sonnet"
- [ ] Click Create
- [ ] API called with correct data

**Expected Result:** Form submits correctly

#### T3X.3: Team Member Creation API
- [ ] New team member agent created
- [ ] parentAgentId set to CEO agent ID
- [ ] createdByAgent flag set to 1
- [ ] Team member inherits company affiliation
- [ ] Activity logged
- [ ] Response returns new agent data

**Expected Result:** Team member created with correct relationships

#### T3X.4: Team Members List
- [ ] Navigate to Team tab
- [ ] Team members listed
- [ ] Each member shows: name, role, status
- [ ] Click member to navigate to agent detail

**Expected Result:** Team list is complete and navigable

#### T3X.5: Authorization Tests
- [ ] Non-CEO agent tries to create team member
- [ ] Request rejected with 403
- [ ] Only CEO can access team creation
- [ ] Non-CEO agents don't see Team button

**Expected Result:** Authorization controls work

---

## Edge Case Tests

### EC1: Invalid Input Validation
- [ ] Create agent without name → error
- [ ] Create workflow with invalid cron → error
- [ ] HTTP request to invalid URL → handled gracefully
- [ ] Missing required parameters → 400 error

**Expected Result:** Validation prevents invalid data

### EC2: Concurrent Operations
- [ ] Two users create workflows simultaneously
- [ ] Both workflows save correctly
- [ ] No data corruption
- [ ] Both runs execute independently

**Expected Result:** Concurrent operations don't interfere

### EC3: Large Data Sets
- [ ] 100+ workflows in system
- [ ] Performance still acceptable
- [ ] Pagination works if implemented
- [ ] Search/filter works

**Expected Result:** System handles scale

### EC4: Error Recovery
- [ ] Workflow execution fails
- [ ] Error logged and visible
- [ ] System continues operating
- [ ] Can retry failed workflow

**Expected Result:** Error handling is robust

---

## Performance Tests

### PERF1: Workflow Execution
- [ ] Simple workflow executes in < 100ms
- [ ] Complex workflow (10+ steps) completes
- [ ] Large variable objects handled

**Expected Result:** Execution is performant

### PERF2: API Response Times
- [ ] List 100 workflows: < 500ms
- [ ] Get workflow details: < 100ms
- [ ] Create workflow: < 200ms

**Expected Result:** API is responsive

### PERF3: Database Queries
- [ ] No N+1 query problems
- [ ] Indexes used correctly
- [ ] Large result sets paginated

**Expected Result:** Database performance is good

---

## Security Tests

### SEC1: Authorization
- [ ] User A cannot access company B's data
- [ ] Non-admin cannot create LLM credentials
- [ ] Only CEO can create team members

**Expected Result:** Authorization boundaries enforced

### SEC2: Data Privacy
- [ ] LLM credentials not exposed in API responses
- [ ] Passwords/secrets not logged
- [ ] API keys not visible in frontend

**Expected Result:** Sensitive data is protected

### SEC3: HMAC Validation
- [ ] Webhook with invalid signature rejected
- [ ] Webhook with correct signature accepted
- [ ] Signature validation prevents tampering

**Expected Result:** Webhooks are secure

---

## Test Execution Checklist

### Preparation
- [ ] Test environment set up
- [ ] Test data created
- [ ] Test credentials ready
- [ ] Browsers/tools prepared

### Execution
- [ ] Phase 0 tests run
- [ ] Phase 1 tests run
- [ ] Phase 2 tests run
- [ ] Phase 3 tests run (all sub-phases)
- [ ] Edge case tests run
- [ ] Performance tests run
- [ ] Security tests run

### Reporting
- [ ] Test results documented
- [ ] Failures logged with details
- [ ] Screenshots captured for issues
- [ ] Browser logs attached for debugging
- [ ] Summary report created

---

## Test Sign-Off

| Phase | Status | Notes | Tester | Date |
|-------|--------|-------|--------|------|
| 0 | ⏳ | Pending | TBD | TBD |
| 1 | ⏳ | Pending | TBD | TBD |
| 2 | ⏳ | Pending | TBD | TBD |
| 3A-3B | ⏳ | Pending | TBD | TBD |
| 3C | ⏳ | Pending | TBD | TBD |
| 3D | ⏳ | Pending | TBD | TBD |
| 3E | ⏳ | Pending | TBD | TBD |
| 3X | ⏳ | Pending | TBD | TBD |

---

## Known Issues / Limitations

1. **WebSocket Chat:** Real-time agent chat not yet implemented (polling used)
2. **Bulk Operations:** No bulk workflow execution
3. **Advanced Debugging:** Limited step-by-step debugging in workflow UI
4. **Mobile:** Limited mobile optimization

---

## Future Testing

- [ ] Phase 4: Knowledge Base & Memory tests
- [ ] Phase 5: Skills Marketplace tests
- [ ] Phase 6: Messaging Integration tests
- [ ] Phase 7: MCP & External APIs tests
- [ ] Phase 8: Distribution & PWA tests
- [ ] Performance under load
- [ ] Security penetration testing
- [ ] Accessibility compliance

---

**Document prepared by:** Claude AI Agent
**Last Updated:** March 16, 2026
**Ready for UAT:** YES ✅

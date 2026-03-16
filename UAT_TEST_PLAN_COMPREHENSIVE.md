# Paperclip Platform - Comprehensive UAT Test Plan
**Version:** 2.0
**Created:** March 16, 2026
**Updated:** March 16, 2026
**Scope:** Phases 0-4 (Foundation through Knowledge Base + Memory)
**Status:** Ready for UAT

---

## Executive Summary

This comprehensive test plan covers all implemented features from Phases 0-4 of the Paperclip Platform. Phase 4 introduces the Knowledge Base and Memory system, enabling agents to learn from documents and maintain contextual awareness.

### Completed Phases
- ✅ **Phase 0**: Foundation & Setup
- ✅ **Phase 1**: Multi-LLM Provider Settings
- ✅ **Phase 2**: Quick Hire Wizard + Agent Chat
- ✅ **Phase 3**: Visual Workflow Builder (3A-3E)
- ✅ **Phase 4**: Knowledge Base + Memory System

---

## Test Objectives

1. Verify all features work as designed
2. Validate data integrity and persistence
3. Confirm security and authorization controls
4. Test error handling and edge cases
5. Validate performance under normal load
6. Ensure UI/UX meets requirements
7. **NEW Phase 4**: Verify knowledge storage, retrieval, and context injection

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
  "name": "UAT Test Company",
  "issuePrefix": "TEST"
}

# Create test agent
POST /api/companies/{companyId}/agents
{
  "name": "TestBot",
  "role": "Developer",
  "llmProvider": "openrouter",
  "llmModel": "claude-3-5-sonnet"
}

# Note IDs for subsequent tests
```

---

## Test Cases by Phase

### PHASE 0: Foundation & Setup

#### T0.1: Docker Deployment ✅
- [ ] Docker container starts without errors
- [ ] PostgreSQL database initializes
- [ ] pgvector extension loads
- [ ] All migrations run successfully
- [ ] Database schema is correct

**Expected Result:** All tables created with correct columns and indexes

#### T0.2: Application Startup ✅
- [ ] Server starts on port 3000
- [ ] Frontend builds and serves on port 5173
- [ ] No startup errors in logs
- [ ] Health check endpoint responds: `/api/health` → 200 OK

**Expected Result:** Application is ready to use

#### T0.3: TypeScript Compilation ✅
- [ ] All packages compile without errors
- [ ] No type mismatches
- [ ] All imports resolve correctly
- [ ] Strict mode enabled and passes

**Expected Result:** Build output shows success message

---

### PHASE 1: Multi-LLM Provider Settings ✅

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

### PHASE 2: Agent Chat + Backend ✅

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
- [ ] Timestamp shows for each message

**Expected Result:** Chat UI is functional and messages persist

#### T2.4: Chat History
- [ ] Multiple messages in chat
- [ ] Refresh page
- [ ] Chat history persists
- [ ] No duplicate messages

**Expected Result:** Chat history is persistent and accurate

---

### PHASE 3: Visual Workflow Builder ✅

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

#### T3C.1: Workflow Execution
- [ ] Create simple workflow: trigger → action → complete
- [ ] Execute workflow via API
- [ ] Workflow run created with status "running"
- [ ] Execution completes
- [ ] Execution logs available

**Expected Result:** Workflow executes sequentially

#### T3C.2: Conditional Logic
- [ ] Create workflow with condition node
- [ ] Set condition: "if trigger.value > 10"
- [ ] Add two action paths (true/false)
- [ ] Execute with different trigger values
- [ ] Correct path executes

**Expected Result:** Conditional execution works

---

### PHASE 4: Knowledge Base + Memory System (NEW)

#### T4.1: Knowledge Database Schema
- [ ] knowledge_documents table created
- [ ] knowledge_chunks table created
- [ ] agent_memory table created
- [ ] conversation_history table created
- [ ] conversation_summaries table created
- [ ] agent_knowledge_associations table created
- [ ] All foreign keys working
- [ ] Indexes for performance
- [ ] Vector column (1536 dimensions) ready for embeddings

**Expected Result:** Database schema complete and indexed

#### T4.2: Document Upload - API
- [ ] POST /companies/{id}/knowledge/documents
  - Upload document with name and optional agentId
  - Validate document doesn't exceed size limit
  - Create document record with status "ready"
  - Response includes document ID

**Expected Result:** Document created and can be retrieved

#### T4.3: Document Upload - UI
- [ ] DocumentUploader component renders
- [ ] Drag and drop area visible
- [ ] Can select files via button
- [ ] Supported file types: PDF, TXT, Markdown
- [ ] Upload progress indicator shown
- [ ] Success message displayed
- [ ] Document appears in list after upload

**Expected Result:** Document upload works end-to-end

#### T4.4: Document Management - List
- [ ] GET /companies/{id}/knowledge/documents
  - Returns all company documents
  - Includes: id, name, status, chunkCount, createdAt
  - Sorted by creation date (newest first)
  - Proper pagination for large datasets

**Expected Result:** Document list is complete and current

#### T4.5: Document Management - Retrieve
- [ ] GET /companies/{id}/knowledge/documents/{docId}
  - Returns full document details
  - Includes: id, name, contentType, fileSize, status, errorMessage, chunkCount
  - Only accessible by authorized company members

**Expected Result:** Document details match uploaded metadata

#### T4.6: Document Management - Delete
- [ ] DELETE /companies/{id}/knowledge/documents/{docId}
  - Removes document record
  - Removes associated chunks
  - Removes associations
  - Returns success message
  - Cannot re-access deleted document

**Expected Result:** Document completely removed

#### T4.7: Document Search
- [ ] POST /companies/{id}/knowledge/search
  - Query: string (required)
  - Limit: number (default 5)
  - Returns matching documents
  - Matches on document name (MVP implementation)
  - Ordered by relevance

**Expected Result:** Search returns relevant documents

#### T4.8: Agent Memory - Save
- [ ] POST /agents/{agentId}/knowledge/memory
  - Save learned facts: type="learned_fact", content={...}
  - Save preferences: type="preference", content={...}
  - Save insights: type="insight", content={...}
  - Specify relevanceScore (0-100)
  - Only authorized users can save

**Expected Result:** Memory entry created and retrievable

#### T4.9: Agent Memory - Retrieve
- [ ] GET /agents/{agentId}/knowledge/memory
  - Optional filter: type=learned_fact|preference|insight
  - Returns array of memory entries
  - Ordered by relevanceScore (highest first)
  - Includes id, type, content, relevanceScore

**Expected Result:** All memory entries returned correctly

#### T4.10: Agent Context Building
- [ ] GET /agents/{agentId}/knowledge/context
  - Optional query parameter
  - Returns AgentContext object with:
    - knowledgeContext: relevant documents
    - conversationSummary: last 20 messages
    - learnedFacts: top 5 facts
    - preferences: top 5 preferences
    - totalTokens: estimated token count
  - Properly estimates tokens

**Expected Result:** Context ready for LLM injection

#### T4.11: Conversation History
- [ ] Messages automatically saved on GET /agents/{agentId}/chat
- [ ] ContextManager.recordMessage() called after each exchange
- [ ] Role field set correctly (user or assistant)
- [ ] Token count estimated

**Expected Result:** Full conversation history available

#### T4.12: Context Pruning
- [ ] pruneOldConversations(agentId, maxAge=30)
  - Deletes messages older than 30 days
  - Returns count of deleted messages
  - Only deletes specified agent's messages
  - Runs without errors

**Expected Result:** Old conversations cleaned up

#### T4.13: KnowledgeBrowser Component
- [ ] Component renders without errors
- [ ] Fetches and displays all company documents
- [ ] Search functionality filters documents
- [ ] Document status shown with color indicator
  - Green for "ready"
  - Amber for "processing"
  - Red for "error"
- [ ] Can click document to select
- [ ] Document count displayed

**Expected Result:** Browser fully functional

#### T4.14: Authorization and Access Control
- [ ] Non-company members cannot access documents
- [ ] Non-company members cannot access memory
- [ ] Non-company members cannot get context
- [ ] Users can only see their own company's knowledge
- [ ] Agents can only see associated knowledge

**Expected Result:** All access controls enforced

#### T4.15: Error Handling
- [ ] Upload non-supported file type → error message
- [ ] Upload to non-existent company → 403
- [ ] Get context for non-existent agent → 404
- [ ] Delete non-existent document → 404
- [ ] Search with empty query → error message
- [ ] Network failure → graceful error handling

**Expected Result:** All errors handled gracefully

---

## Edge Case Tests

### EC1: Invalid Input Validation
- [ ] Upload document without name → error
- [ ] Upload document with invalid agentId → error
- [ ] Search with empty query → error
- [ ] Memory save without content → error
- [ ] Missing required parameters → 400 error

**Expected Result:** Validation prevents invalid data

### EC2: Large Documents
- [ ] Upload 10MB PDF → accepted or gracefully rejected
- [ ] Upload 1000+ page document → parsed correctly
- [ ] Document with embedded images → handled correctly
- [ ] Very long text content → chunked appropriately

**Expected Result:** System handles large files

### EC3: Concurrent Operations
- [ ] Two users upload documents simultaneously
- [ ] Both uploads complete successfully
- [ ] No data corruption
- [ ] Both documents accessible
- [ ] Memory writes don't interfere

**Expected Result:** Concurrent operations are safe

### EC4: Special Characters
- [ ] Document name with special characters → handled
- [ ] Memory content with emojis → stored and retrieved
- [ ] Unicode text in documents → preserved
- [ ] Quotes and escapes → properly escaped

**Expected Result:** Special characters handled correctly

### EC5: Data Consistency
- [ ] Document upload transaction commits or rolls back
- [ ] Chunk creation linked to document
- [ ] Association created with both document and agent
- [ ] Orphaned records checked

**Expected Result:** Data remains consistent

---

## Performance Tests

### PERF1: Document Operations
- [ ] Upload document: < 2 seconds
- [ ] List 100+ documents: < 500ms
- [ ] Search documents: < 300ms
- [ ] Get context: < 200ms

**Expected Result:** Operations are responsive

### PERF2: Memory Operations
- [ ] Save memory entry: < 100ms
- [ ] Get 100 memory entries: < 500ms
- [ ] Get context with memory: < 300ms
- [ ] Prune old conversations: < 1 second for 1000 records

**Expected Result:** Memory ops are performant

### PERF3: Database
- [ ] No N+1 query problems
- [ ] Indexes used correctly
- [ ] Query plans optimized
- [ ] Large result sets paginated

**Expected Result:** Database performs well

### PERF4: Frontend
- [ ] DocumentUploader renders: < 500ms
- [ ] KnowledgeBrowser initial load: < 1 second
- [ ] Document list scrolling smooth
- [ ] Search responsive (< 300ms debounce)

**Expected Result:** UI is responsive

---

## Security Tests

### SEC1: Authorization
- [ ] User A cannot access company B's documents
- [ ] User cannot access other users' memories
- [ ] Only authorized users can create/delete documents
- [ ] Agent can only access its own memory

**Expected Result:** Authorization boundaries enforced

### SEC2: Data Privacy
- [ ] Document content not exposed in lists
- [ ] Memory content only visible to authorized users
- [ ] No credentials in API responses
- [ ] No sensitive data in logs

**Expected Result:** Sensitive data is protected

### SEC3: Input Sanitization
- [ ] XSS attempts in document names blocked
- [ ] SQL injection attempts blocked
- [ ] Path traversal attempts blocked
- [ ] Malicious file types rejected

**Expected Result:** Injection attacks prevented

---

## Integration Tests

### INT1: Knowledge → Agent Chat
- [ ] Agent receives context in chat
- [ ] Context includes relevant documents
- [ ] Conversation history in context
- [ ] Memories injected into LLM prompt
- [ ] Response incorporates knowledge

**Expected Result:** Knowledge enhances agent responses

### INT2: Workflow → Knowledge
- [ ] Workflow step can save to memory
- [ ] Workflow step can query documents
- [ ] Workflow step can access context
- [ ] Results propagated through workflow

**Expected Result:** Workflows can leverage knowledge

### INT3: Multi-Agent Coordination
- [ ] Agent A saves memory
- [ ] Agent B accesses that memory (if authorized)
- [ ] Shared knowledge across agents
- [ ] Memory relevance score affects priority

**Expected Result:** Knowledge shared appropriately

---

## Regression Tests

### REG1: Phase 0-3 Functionality
- [ ] All Phase 0-3 tests still pass
- [ ] No features broken by Phase 4
- [ ] Existing workflows still run
- [ ] Agent chat still functional
- [ ] LLM settings still work

**Expected Result:** No regressions introduced

---

## Mobile and Responsive Tests

### RESP1: Document Upload
- [ ] DocumentUploader works on mobile
- [ ] File selection works on iOS/Android
- [ ] Touch drag-and-drop functional (or alternative)
- [ ] Error messages visible

**Expected Result:** Upload works on mobile

### RESP2: Knowledge Browser
- [ ] KnowledgeBrowser responsive layout
- [ ] Search input accessible on mobile
- [ ] Document list scrollable
- [ ] Status indicators visible

**Expected Result:** Browser works on mobile

---

## Accessibility Tests

### ACC1: DocumentUploader
- [ ] Keyboard navigation working
- [ ] ARIA labels present
- [ ] Error messages announced
- [ ] File input labeled

**Expected Result:** Component is accessible

### ACC2: KnowledgeBrowser
- [ ] Search input labeled
- [ ] Document list items navigable
- [ ] Status colors + text indicators
- [ ] Focus visible

**Expected Result:** Browser is accessible

---

## Test Execution Checklist

### Pre-Execution
- [ ] Test environment set up
- [ ] Test data created
- [ ] Test credentials ready
- [ ] Browsers/tools prepared
- [ ] Test cases reviewed
- [ ] Success criteria clear

### Execution
- [ ] Phase 0 tests run
- [ ] Phase 1 tests run
- [ ] Phase 2 tests run
- [ ] Phase 3 tests run
- [ ] Phase 4 tests run (NEW)
- [ ] Edge case tests run
- [ ] Performance tests run
- [ ] Security tests run
- [ ] Integration tests run
- [ ] Regression tests run

### Reporting
- [ ] Test results documented
- [ ] Failures logged with details
- [ ] Screenshots captured for issues
- [ ] Browser logs attached for debugging
- [ ] Summary report created
- [ ] Issues prioritized

---

## Test Sign-Off

| Phase | Status | Issues | Notes | Tester | Date |
|-------|--------|--------|-------|--------|------|
| 0 | ⏳ | 0 | Pending | TBD | TBD |
| 1 | ⏳ | 0 | Pending | TBD | TBD |
| 2 | ⏳ | 0 | Pending | TBD | TBD |
| 3 | ⏳ | 0 | Pending | TBD | TBD |
| 4 | ⏳ | 0 | Pending (NEW) | TBD | TBD |

---

## Known Limitations

1. **Vector Search**: Semantic similarity search (pgvector cosine distance) planned but not yet integrated. MVP uses keyword matching.
2. **Document Parsing**: Basic text extraction implemented; advanced PDF/Office doc parsing planned.
3. **Embeddings**: Vector embeddings not yet generated; infrastructure ready for integration.
4. **Real-time Sync**: Memory updates broadcast plan for future phases.
5. **Bulk Operations**: No bulk upload for documents yet.

---

## Future Testing

- [ ] Phase 5: Skills Marketplace tests
- [ ] Phase 6: Messaging Integration tests
- [ ] Phase 7: MCP & External APIs tests
- [ ] Phase 8: Distribution & PWA tests
- [ ] Performance under heavy load (1000+ documents)
- [ ] Security penetration testing
- [ ] Accessibility compliance (WCAG 2.1 AA)
- [ ] Browser compatibility testing
- [ ] Mobile app compatibility

---

## Test Artifacts

### Files to Attach with Report
- Test execution logs
- Screenshot of failed tests
- Browser console output
- Server error logs
- Database query logs (if applicable)
- Performance metrics
- Code coverage report (if applicable)

---

## Contact & Escalation

- **Test Lead**: TBD
- **Development Lead**: Claude AI Agent
- **QA Manager**: TBD
- **Escalation Path**: Test Lead → Development Lead → Project Manager

---

**Document prepared by:** Claude AI Agent
**Last Updated:** March 16, 2026
**Ready for UAT:** YES ✅

### Summary Statistics
- **Total Test Cases:** 85+
- **Edge Cases:** 5
- **Performance Tests:** 4
- **Security Tests:** 3
- **Integration Tests:** 3
- **Phases Covered:** 5 (0-4)
- **Estimated Test Duration:** 8-12 hours

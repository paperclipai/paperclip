# Paperclip Platform - Remaining Phases Roadmap (4-8)

**Prepared:** March 16, 2026
**Total Estimated Effort:** 40-50 hours
**Current Progress:** Phases 0-3 Complete (50-55% done)

---

## Executive Summary

The foundation is solid. Phases 4-8 build enterprise features on top of the proven architecture. Phases 4-5 are high-priority (unlock core functionality), Phases 6-7 can be parallelized (integrations), Phase 8 is polish.

**Recommended Timeline:**
- Week 1: Phase 4 (Knowledge Base) - Critical for agent intelligence
- Week 2: Phase 5 (Skills) + Phase 6 (Messaging) in parallel
- Week 3: Phase 7 (MCP/APIs) + Phase 8 (Polish)
- Week 4: Integration testing, bug fixes, documentation

---

## Phase 4: Knowledge Base + Memory (10-12 hours)

### ⭐ Priority: CRITICAL
**Why:** Enables agents to learn from documents and remember context

### Features to Implement

#### 4.1: Document Upload & Management
- PDF/TXT/Markdown upload UI
- File size limits (100MB per document, 1GB per company)
- Progress indication during upload
- Document list with metadata (name, size, date, chunks count)
- Delete document capability

#### 4.2: Chunking & Embedding
- Semantic chunking (overlap, paragraph-aware)
- Multiple embedding models support:
  - OpenAI (text-embedding-3)
  - Anthropic (claude embeddings)
  - Local (Ollama)
- Batch processing for large documents
- Chunk quality validation

#### 4.3: Vector Search (pgvector)
- Semantic similarity search
- Cosine distance calculations
- Result ranking and scoring
- Top-K retrieval (default 5, customizable)

#### 4.4: Agent Context Memory
- Per-agent knowledge base association
- Automatic context injection into agent system prompt
- Memory decay (optional, configurable)
- Last accessed timestamp for relevance

#### 4.5: Conversation Memory
- Conversation history persistence
- Automatic summary generation for long conversations
- Context window management (sliding window)
- Memory format: structured JSON

### Database Schema

```sql
-- knowledge_documents
CREATE TABLE knowledge_documents (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID REFERENCES agents(id),  -- NULL = company-wide
  name TEXT NOT NULL,
  content_type TEXT,  -- application/pdf, text/plain, text/markdown
  file_size INTEGER,
  original_path TEXT,
  status TEXT,  -- processing, ready, error
  error_message TEXT,
  chunk_count INTEGER,
  embedding_model TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  INDEX (company_id, agent_id)
);

-- knowledge_chunks
CREATE TABLE knowledge_chunks (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  chunk_index INTEGER,
  content TEXT NOT NULL,
  tokens INTEGER,
  embedding VECTOR(1536),  -- pgvector
  metadata JSONB,  -- page number, section, etc.
  created_at TIMESTAMP,
  INDEX (document_id, chunk_index)
);

-- agent_memory
CREATE TABLE agent_memory (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id),
  memory_type TEXT,  -- conversation, learned_fact, preference
  content JSONB,
  relevance_score FLOAT,
  last_accessed TIMESTAMP,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  INDEX (agent_id, memory_type)
);

-- conversation_history
CREATE TABLE conversation_history (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id),
  role TEXT,  -- user, assistant
  content TEXT NOT NULL,
  tokens INTEGER,
  created_at TIMESTAMP,
  INDEX (agent_id, created_at)
);
```

### Backend Services

**DocumentProcessor** (`server/src/services/document-processor.ts`)
- parseDocument(buffer, type) - Extract text from PDF/TXT/Markdown
- chunkDocument(text) - Split into semantic chunks
- validateChunks(chunks) - Quality checks
- estimateTokens(text) - Token counting

**VectorStore** (`server/src/services/vector-store.ts`)
- embedChunk(text, model) - Generate embedding
- indexChunks(chunks) - Bulk insertion
- search(query, k) - Semantic search
- deleteDocument(documentId) - Cleanup

**ContextManager** (`server/src/services/context-manager.ts`)
- getContext(agentId, query) - Retrieve relevant knowledge
- buildPromptContext(agentId, messages) - Format for system prompt
- saveMemory(agentId, memory) - Persist learnings
- getConversationSummary(agentId) - Recent context

### API Endpoints

```
POST /companies/:id/knowledge/upload
- Multipart form-data: file
- Returns: document_id, status, processing_eta

GET /companies/:id/knowledge/documents
- List all documents

GET /companies/:id/knowledge/documents/:id
- Get document details, chunks, embeddings

DELETE /companies/:id/knowledge/documents/:id
- Remove document and chunks

POST /companies/:id/knowledge/search
- { query: "What is X?" }
- Returns: [{ chunk, score, document_name }]

GET /agents/:id/knowledge/context
- Get knowledge relevant to agent

PUT /agents/:id/memory
- { type: "learned_fact", content: {...} }
- Save agent memory
```

### Frontend Components

**DocumentUploader** (`ui/src/components/DocumentUploader.tsx`)
- Drag-drop zone
- File selection dialog
- Upload progress bar
- Status indication (processing/ready/error)

**KnowledgeSearch** (`ui/src/components/KnowledgeSearch.tsx`)
- Search box
- Results list with score
- Preview on hover
- Document source indicator

**MemoryBrowser** (`ui/src/components/MemoryBrowser.tsx`)
- Conversation history timeline
- Memory insights
- Learned facts display
- Memory management (delete, export)

### Integration Points

1. **Agent System Prompt Enhancement:**
   ```
   // Before
   "You are an AI agent named {{ name }}..."

   // After
   "You are an AI agent named {{ name }}...

   You have access to the following knowledge base:
   {{ knowledge_context }}

   Recent conversation history:
   {{ conversation_summary }}"
   ```

2. **Chat API Enhancement:**
   - Include knowledge context in LLM API calls
   - Track token usage for embeddings
   - Cache frequently used contexts

3. **Workflow Integration:**
   - New action: "search-knowledge-base"
   - New trigger: "on-document-uploaded"
   - Variable: `{{ knowledge.search(query) }}`

### Implementation Order

1. Database schema + migration
2. DocumentProcessor service
3. VectorStore service
4. API endpoints (upload, search, list, delete)
5. ContextManager service
6. Frontend components (DocumentUploader, KnowledgeSearch)
7. System prompt integration
8. Chat API integration
9. Testing & validation

### Success Criteria

- ✅ Documents upload and process without errors
- ✅ Chunks embed and store in pgvector
- ✅ Semantic search returns relevant results
- ✅ Agent system prompt includes knowledge context
- ✅ Conversation memory persists across sessions
- ✅ No token limit exceeded errors
- ✅ Performance: search completes in < 500ms

---

## Phase 5: Skills Marketplace (8-10 hours)

### ⭐ Priority: HIGH
**Why:** Enables extensibility and automation library

### Features to Implement

#### 5.1: Built-in Skill Library
- Math skills (calculate, statistics)
- Text skills (summarize, translate, extract)
- Data skills (parse CSV, format JSON)
- Utility skills (sleep, log, notify)

#### 5.2: Skill Discovery
- Browse all available skills
- Filter by category/tags
- Search by name/description
- View skill documentation
- See usage examples

#### 5.3: One-Click Installation
- Install skill for specific agent
- Install skill for company
- Version management
- Automatic dependency resolution

#### 5.4: Skill Execution in Workflows
- New node type: "skill"
- Drag-drop skills into workflow
- Configure skill parameters
- Map inputs from workflow variables
- Capture outputs for next steps

#### 5.5: Custom Skill Creation
- Skill template generator
- Support JavaScript/Python execution
- Parameter validation schema
- Testing framework
- Publishing to marketplace

### Database Schema

```sql
-- skills
CREATE TABLE skills (
  id UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  category TEXT,
  description TEXT,
  version TEXT,
  status TEXT,  -- published, draft, deprecated
  author_id UUID,
  parameters JSON SCHEMA,
  returns JSON SCHEMA,
  source_code TEXT,
  is_builtin BOOLEAN,
  download_count INTEGER,
  rating FLOAT,
  created_at TIMESTAMP
);

-- agent_installed_skills
CREATE TABLE agent_installed_skills (
  id UUID PRIMARY KEY,
  agent_id UUID REFERENCES agents(id),
  skill_id UUID REFERENCES skills(id),
  configuration JSONB,
  installed_at TIMESTAMP
);

-- skill_executions
CREATE TABLE skill_executions (
  id UUID PRIMARY KEY,
  skill_id UUID,
  agent_id UUID,
  inputs JSONB,
  outputs JSONB,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMP
);
```

### Backend Services

**SkillRegistry** (`server/src/services/skill-registry.ts`)
- loadSkill(skillId) - Load skill definition
- listSkills(filter) - Search skills
- installSkill(agentId, skillId) - Add skill to agent
- executeSkill(skillId, inputs) - Run skill code

**SkillExecutor** (`server/src/services/skill-executor.ts`)
- validateInputs(inputs, schema) - Parameter validation
- execute(skillCode, inputs) - Sandbox execution
- handleErrors(error) - Error recovery
- trackExecution(result) - Logging

### Built-In Skills (Examples)

```typescript
// math skills
const MathSkills = {
  calculate: {
    description: "Evaluate a math expression",
    parameters: { expression: "string" },
    returns: { result: "number" }
  },
  statistics: {
    description: "Calculate statistics from array",
    parameters: { values: "number[]" },
    returns: { mean: "number", median: "number", std: "number" }
  }
};

// text skills
const TextSkills = {
  summarize: {
    description: "Summarize text content",
    parameters: { text: "string", length: "number" },
    returns: { summary: "string" }
  },
  extract: {
    description: "Extract named entities",
    parameters: { text: "string", entity_types: "string[]" },
    returns: { entities: "object[]" }
  }
};
```

### Workflow Integration

```yaml
# Example workflow using skills
nodes:
  - id: trigger
    type: trigger

  - id: extract_email
    type: skill
    skill_id: "text-extract-email"
    config:
      text: "{{ triggerData.message }}"

  - id: notify
    type: action
    action: notify
    config:
      to: "{{ extract_email.output.email }}"
```

### API Endpoints

```
GET /api/skills
- List all skills with filters

GET /api/skills/:id
- Get skill documentation

POST /agents/:id/skills
- Install skill for agent

GET /agents/:id/skills
- List installed skills

POST /agents/:id/skills/:skillId/execute
- Execute skill with inputs
```

---

## Phase 6: Messaging Integrations (12-15 hours)

### ⭐ Priority: HIGH
**Why:** Multi-channel automation hub

### Features to Implement

#### 6.1: Telegram Bot
- BotFather setup integration
- Webhook endpoint configuration
- Message routing to agents
- Command handling (/start, /help)
- Inline keyboard support

#### 6.2: WhatsApp Business API
- Account setup wizard
- Message template management
- Webhook integration
- Media handling (images, documents)
- Business account verification

#### 6.3: Slack App
- App installation workflow
- Slash command handling
- Interactive buttons/forms
- Channel message routing
- File upload support

#### 6.4: Email Integration
- Inbound email processing
- SMTP configuration
- Email parsing (subject, body, attachments)
- Reply handling
- Template support

#### 6.5: Message Routing
- Agent assignment rules
- Priority queuing
- Load balancing
- Fallback handling
- Message logging

### Database Schema

```sql
-- messaging_integrations
CREATE TABLE messaging_integrations (
  id UUID PRIMARY KEY,
  company_id UUID REFERENCES companies(id),
  platform TEXT,  -- telegram, whatsapp, slack, email
  config JSONB,  -- credentials, tokens, webhooks
  enabled BOOLEAN,
  created_at TIMESTAMP
);

-- messages
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  integration_id UUID,
  platform TEXT,
  platform_message_id TEXT,
  source_id TEXT,  -- phone, email, user_id
  content TEXT,
  attachments JSONB,
  agent_id UUID REFERENCES agents(id),
  agent_response TEXT,
  status TEXT,  -- received, processed, sent
  created_at TIMESTAMP
);
```

### Backend Services

**MessageGateway** - Central message router
**TelegramAdapter** - Telegram-specific logic
**WhatsAppAdapter** - WhatsApp-specific logic
**SlackAdapter** - Slack-specific logic
**EmailAdapter** - Email-specific logic

### API Endpoints

```
POST /integrations/telegram/webhook
- Telegram webhook endpoint

POST /integrations/whatsapp/webhook
- WhatsApp webhook endpoint

POST /integrations/slack/webhook
- Slack webhook endpoint

POST /integrations/email/webhook
- Email inbound endpoint

GET /companies/:id/integrations
- List configured integrations

POST /companies/:id/integrations
- Add new integration

PUT /companies/:id/integrations/:id
- Update integration config

DELETE /companies/:id/integrations/:id
- Remove integration
```

---

## Phase 7: MCP + External APIs (8-10 hours)

### ⭐ Priority: MEDIUM
**Why:** Third-party service automation

### Features to Implement

#### 7.1: MCP (Model Context Protocol) Support
- MCP server implementation
- Tool registration system
- Prompt composition
- Resource management

#### 7.2: GitHub Integration
- Repository listing
- Issue CRUD operations
- Pull request management
- Commit history
- Webhook triggers

#### 7.3: Linear Integration
- Team/project management
- Issue tracking
- Cycle planning
- Release tracking

#### 7.4: Generic HTTP Connector
- Dynamic endpoint configuration
- Header/auth management
- Request templating
- Response parsing

### Database Schema

```sql
-- external_integrations
CREATE TABLE external_integrations (
  id UUID PRIMARY KEY,
  company_id UUID,
  service TEXT,  -- github, linear, generic
  auth_config JSONB,  -- encrypted tokens
  base_url TEXT,
  created_at TIMESTAMP
);

-- mcp_tools
CREATE TABLE mcp_tools (
  id UUID PRIMARY KEY,
  integration_id UUID,
  name TEXT,
  description TEXT,
  parameters JSON SCHEMA,
  created_at TIMESTAMP
);
```

---

## Phase 8: Polish + Distribution (10-12 hours)

### ⭐ Priority: MEDIUM
**Why:** Production readiness

### Features to Implement

#### 8.1: Workflow Templates Library
- Pre-built templates (40+)
- Categories: HR, Finance, Ops, Sales, Dev
- One-click deployment
- Customization guide

#### 8.2: Mobile PWA
- Responsive design
- Offline support
- Install prompt
- Native app feel

#### 8.3: Public Landing Page
- Feature showcase
- Pricing (future)
- Documentation links
- Sign-up

#### 8.4: Docker Optimization
- Multi-stage builds
- Minimal image size
- Health checks
- Graceful shutdown

#### 8.5: Performance Monitoring
- Error tracking (Sentry optional)
- Performance metrics
- Usage analytics
- Alert thresholds

#### 8.6: Documentation
- User guide
- API documentation
- Developer guide
- FAQ

---

## Implementation Priority Matrix

| Phase | Effort | Impact | Risk | Priority |
|-------|--------|--------|------|----------|
| 4 | 12h | HIGH | LOW | 🔴 **CRITICAL** |
| 5 | 10h | HIGH | LOW | 🟠 **HIGH** |
| 6 | 15h | MEDIUM | MEDIUM | 🟠 **HIGH** |
| 7 | 10h | MEDIUM | MEDIUM | 🟡 **MEDIUM** |
| 8 | 12h | MEDIUM | LOW | 🟡 **MEDIUM** |

---

## Recommended Execution Schedule

### Week 1: Foundation (40 hours)
- **Phase 4 (Knowledge Base):** 12 hours
  - Mon-Wed: Database + services
  - Wed-Thu: API endpoints + frontend
  - Thu-Fri: Integration + testing

### Week 2: Features (40 hours)
- **Phase 5 (Skills):** 10 hours (Mon-Tue morning)
- **Phase 6 (Messaging):** 15 hours (Tue-Thu, parallel with Phase 5)
- **Phase 6 testing:** 5 hours (Thu-Fri)

### Week 3: Integration (40 hours)
- **Phase 7 (MCP/APIs):** 10 hours (Mon-Tue morning)
- **Phase 8 (Polish):** 12 hours (Tue-Wed)
- **Cross-phase integration:** 5 hours (Wed-Thu)
- **Documentation:** 5 hours (Thu-Fri)

### Week 4: Quality (40 hours)
- **UAT & bug fixes:** 20 hours
- **Performance optimization:** 10 hours
- **Security audit:** 5 hours
- **Final testing:** 5 hours

---

## Success Metrics

### Phase 4
- ✅ 95%+ search accuracy
- ✅ <500ms search latency
- ✅ 10GB document capacity per company
- ✅ Perfect embedding quality

### Phase 5
- ✅ 25+ built-in skills available
- ✅ <100ms skill execution
- ✅ 99.9% skill reliability
- ✅ Easy custom skill creation

### Phase 6
- ✅ 4 messaging platforms supported
- ✅ <5 second message routing
- ✅ 99.9% message delivery
- ✅ Webhook verification working

### Phase 7
- ✅ 5+ external services integrated
- ✅ MCP protocol compliant
- ✅ <200ms API calls
- ✅ Proper error handling

### Phase 8
- ✅ 40+ workflow templates
- ✅ PWA works offline
- ✅ <3 second page load
- ✅ <500MB Docker image

---

## Risk Mitigation

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Embedding API rate limits | Cache embeddings, batch processing | Phase 4 |
| Webhook reliability | Retry logic, dead letter queue | Phase 6 |
| Integration testing complexity | Comprehensive test matrix | All |
| Performance degradation | Load testing, optimization | Phase 8 |

---

## Budget & Timeline Summary

| Phase | Hours | Days | Cost* | Cumulative |
|-------|-------|------|-------|-----------|
| Phases 0-3 | 28 | 3.5 | $420 | $420 |
| Phase 4 | 12 | 1.5 | $180 | $600 |
| Phase 5 | 10 | 1.25 | $150 | $750 |
| Phase 6 | 15 | 1.9 | $225 | $975 |
| Phase 7 | 10 | 1.25 | $150 | $1,125 |
| Phase 8 | 12 | 1.5 | $180 | $1,305 |
| **TOTAL** | **87** | **~11 days** | **$1,305** | - |

*Assuming $150/hour developer rate

---

## Next Steps

1. **Immediate (Today):** Review this roadmap
2. **Day 1:** Start Phase 4 implementation
3. **Day 3:** Phase 4 complete, begin Phase 5
4. **Day 5:** Phase 5 complete, start Phase 6
5. **Day 8:** Phase 6 + 7 in parallel
6. **Day 11:** Phase 8 polish
7. **Day 12:** UAT & bug fixes
8. **Day 14:** Release ready

---

**Document prepared by:** Claude AI Agent
**Status:** Ready for implementation
**Estimated completion:** 2 weeks (with consistent 40-hour weeks)

# Phase 0 Completion Guide

## ✅ Current Status

### What's Done:
- [x] **Docker deployment running** - http://localhost:3100
- [x] **PostgreSQL** - Healthy, 24 migrations applied
- [x] **Auth system** - better-auth configured
- [x] **UI** - Built and serving from Docker
- [x] **Basic routes** - Health, companies, agents, issues all working
- [x] **onboarding wizard** - 5-step UI flow ready

### What's Remaining (Phase 0):

1. **LLM Provider Validation Endpoint** ❌
   - POST `/api/llm-providers/validate`
   - Validate API keys and model availability
   - Return list of available models

2. **Platform Adapter Runtime** ❌
   - LLM execution loop (prompt + tool calls)
   - Heartbeat trigger integration
   - Tool execution framework

3. **End-to-End Flow Testing** ❌
   - Signup → Onboarding → CEO creation → Task execution

---

## 🔨 Task 1: Build LLM Provider Validation Endpoint

### Location:
```
server/src/routes/llms.ts       (create new route)
ui/src/api/llmProviders.ts      (create new client)
packages/shared/src/schemas/    (add validation schema)
```

### Backend Implementation (server/src/routes/llms.ts)

```typescript
// 1. Create new route for LLM provider validation
router.post("/llm-providers/validate", validate(validateLlmProviderSchema), async (req, res) => {
  const { providerType, apiKey, baseUrl } = req.body;
  
  try {
    // Call the appropriate provider SDK to validate
    const result = await validateProvider(providerType, { apiKey, baseUrl });
    
    res.json({
      ok: result.ok,
      error: result.error || null,
      models: result.models || [],
    });
  } catch (err) {
    res.status(400).json({
      error: "Validation failed",
      details: [{ path: ["general"], message: String(err) }],
    });
  }
});

// 2. Helper function to validate each provider
async function validateProvider(type: string, config: { apiKey?: string | null; baseUrl?: string | null }) {
  switch (type) {
    case "anthropic":
      return await validateAnthropicApiKey(config.apiKey);
    case "openai":
      return await validateOpenAiKey(config.apiKey);
    case "openrouter":
      return await validateOpenRouterKey(config.apiKey);
    case "ollama":
      return await validateOllamaUrl(config.baseUrl);
    default:
      return { ok: false, error: "Unknown provider" };
  }
}
```

### Validation Schema (packages/shared/src/schemas/)

```typescript
export const validateLlmProviderSchema = z.object({
  providerType: z.enum(["anthropic", "openai", "openrouter", "ollama"]),
  apiKey: z.string().min(1).nullable().optional(),
  baseUrl: z.string().url().nullable().optional(),
});
```

### Frontend Client (ui/src/api/llmProviders.ts)

```typescript
export const llmProvidersApi = {
  async validate(req: { providerType: string; apiKey?: string | null; baseUrl?: string | null }) {
    const response = await apiClient.post("/api/llm-providers/validate", req);
    return response.json() as Promise<{
      ok: boolean;
      error?: string;
      models?: Array<{ id: string; name: string }>;
    }>;
  },
  
  async create(req: { providerType: string; apiKey?: string | null; baseUrl?: string | null; name?: string }) {
    const response = await apiClient.post("/api/llm-providers", req);
    return response.json() as Promise<any>;
  },
  
  async getModels(providerId: string, opts?: { pageSize?: number }) {
    const response = await apiClient.get(`/api/llm-providers/${providerId}/models`, { ...opts });
    return response.json() as Promise<any>;
  },
};
```

---

## 🔨 Task 2: Platform Adapter Runtime

### Location:
```
server/src/services/platformAdapterRuntime.ts (create new)
server/src/routes/agents.ts                   (add execution endpoint)
```

### Core Execution Loop

```typescript
// server/src/services/platformAdapterRuntime.ts

export async function executePlatformAgent(
  agentId: string,
  issueId: string,
  agentPrompt: string,
  llmProviderId: string,
  db: Db
) {
  const agent = await agentService(db).getById(agentId);
  const issue = await issueService(db).getById(issueId);
  
  if (!agent || !issue) throw new Error("Agent or issue not found");
  
  const llmProvider = await getLlmProvider(llmProviderId, db);
  
  // 1. Build system prompt
  const systemPrompt = buildAgentSystemPrompt(agent);
  
  // 2. Call LLM with tool definitions
  const tools = [
    { name: "create_agent", description: "Create a new agent" },
    { name: "assign_task", description: "Assign task to another agent" },
    { name: "update_issue", description: "Update issue status/description" },
    { name: "read_issue", description: "Read issue details" },
  ];
  
  const response = await llmProvider.chat({
    system: systemPrompt,
    messages: [{ role: "user", content: agentPrompt }],
    tools: tools,
  });
  
  // 3. Execute tool calls
  for (const toolCall of response.toolCalls) {
    await executeTool(toolCall.name, toolCall.args, db);
  }
  
  // 4. Store conversation
  await storeConversation(agentId, issueId, {
    userMessage: agentPrompt,
    assistantMessage: response.text,
    toolCalls: response.toolCalls,
  }, db);
  
  return { success: true, toolCalls: response.toolCalls };
}
```

### Heartbeat Integration

```typescript
// In heartbeat execution loop:
if (agent.adapterType === "platform" && agent.preferredProviderId) {
  const pendingIssues = await issueService(db).getByAgent(agentId, { status: "todo" });
  
  for (const issue of pendingIssues) {
    try {
      await executePlatformAgent(
        agentId,
        issue.id,
        issue.title,
        agent.preferredProviderId,
        db
      );
    } catch (err) {
      console.error(`Failed to execute agent ${agentId} on issue ${issue.id}:`, err);
    }
  }
}
```

---

## 🔨 Task 3: Add LLM Provider CRUD Routes

### Add to server/src/routes/agents.ts or create new server/src/routes/settings.ts

```typescript
// Create LLM provider
router.post("/llm-providers", validate(createLlmProviderSchema), async (req, res) => {
  const { companyId } = req;
  const { providerType, name, apiKey, baseUrl } = req.body;
  
  const provider = await db.insert(llmProviders).values({
    id: generateId(),
    companyId,
    providerType,
    name: name || providerType,
    apiKey, // encrypted by middleware
    baseUrl,
    createdAt: new Date(),
  });
  
  res.json(provider);
});

// Get LLM provider models
router.get("/llm-providers/:providerId/models", async (req, res) => {
  const provider = await db.query.llmProviders.findFirst({ where: eq(llmProviders.id, req.params.providerId) });
  
  const models = await fetchModelsFromProvider(provider);
  
  res.json({ models, pageSize: 100 });
});
```

---

## 📋 Testing Checklist

### 1. LLM Provider Validation
- [ ] POST to `/api/llm-providers/validate` with OpenRouter API key
- [ ] Returns `{ ok: true, models: [...] }`
- [ ] Test with invalid key returns `{ ok: false, error: "..." }`
- [ ] Test Ollama local URL validation

### 2. Onboarding Flow
- [ ] Sign up → new user created
- [ ] Step 2: Create CEO agent (name: "CEO", role: "ceo", adapter: "platform")
- [ ] Step 3: Validate & save LLM provider
- [ ] Step 4: Create first task, assign to CEO
- [ ] Step 5: Launch → dashboard

### 3. Platform Agent Execution
- [ ] CEO agent executes on heartbeat
- [ ] Task is assigned and completed
- [ ] Conversation stored in database
- [ ] UI shows agent chat history

---

## 🚀 Implementation Order

```
1. Create LLM provider validation endpoint
   ├─ Backend: validateProvider() function
   ├─ Schema: validateLlmProviderSchema
   └─ Tests: curl -X POST http://localhost:3100/api/llm-providers/validate

2. Add LLM provider CRUD routes
   ├─ POST /api/llm-providers (create)
   ├─ GET /api/llm-providers/:id/models
   └─ Tests: Create provider, get models

3. Build platform adapter runtime
   ├─ executePlatformAgent()
   ├─ Tool execution framework
   ├─ Conversation storage
   └─ Heartbeat integration

4. End-to-end testing
   ├─ Full onboarding flow
   ├─ CEO creation + task assignment
   ├─ Agent execution
   └─ Chat history verification
```

---

## 🔌 Database Migrations Needed

```typescript
// New table: llm_providers
CREATE TABLE llm_providers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  provider_type TEXT NOT NULL, -- anthropic, openai, openrouter, ollama
  name TEXT,
  api_key TEXT, -- encrypted
  base_url TEXT,
  created_at TIMESTAMP NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

// New table: agent_conversations
CREATE TABLE agent_conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  issue_id TEXT,
  user_message TEXT,
  assistant_message TEXT,
  tool_calls JSONB,
  created_at TIMESTAMP NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);
```

---

## 📦 Environment Variables

```bash
# In Docker .env or docker-compose:
OPENROUTER_API_KEY=<user-provided, stored in settings>
ANTHROPIC_API_KEY=<optional, for platform>
BETTER_AUTH_BASE_URL=http://localhost:3100
PAPERCLIP_DEPLOYMENT_MODE=authenticated
```

---

## ✅ Phase 0 Success Criteria

- [x] Docker deployed and running
- [ ] LLM provider validation working
- [ ] CEO agent created automatically on signup
- [ ] Platform adapter can execute tasks
- [ ] Chat UI shows agent conversations
- [ ] Full onboarding → execution flow works
- [ ] No 400 validation errors

---

## 📞 Next Steps After Phase 0

Once Phase 0 is complete:
- **Phase 1**: Zeroclaw UI pages (Cost, Cron, Integrations, Tools, Memory, Logs)
- **Phase 2**: Sim workflow engine + visual canvas
- **Phase 3**: Messaging integrations (WhatsApp, Telegram, Slack)


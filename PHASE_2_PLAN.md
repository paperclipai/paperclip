# Phase 2: Quick Hire Wizard + Agent Chat

## Overview
Add AI-assisted agent creation (Quick Hire Wizard) and per-agent chat functionality.

## Phase 2 Components

### A. Quick Hire Wizard
**Purpose:** AI-guided agent creation using the company's selected LLM

#### UI Components
- `ui/src/components/QuickHireWizard.tsx` - Multi-step wizard
- Modal/dialog triggered from Agent creation button
- Steps:
  1. Agent Name (AI suggests based on role)
  2. Agent Role (AI suggests capabilities)
  3. Agent Instructions (AI generates template)
  4. LLM Provider Selection (uses company default)
  5. Review & Create

#### Backend
- `server/src/routes/agents.ts` - Add POST `/agents/ai-generate` endpoint
  - Accepts: role description, company context
  - Calls company's selected LLM to generate agent config
  - Returns: suggested name, role, instructions, icon

### B. Per-Agent Chat Tab
**Purpose:** Allow users to chat with individual agents

#### UI Components
- `ui/src/components/AgentChat.tsx` - Chat interface
- `ui/src/pages/AgentDetail.tsx` - Add "Chat" tab alongside "Overview"
- Message display with role styling (user vs assistant)
- Input field with send button
- Auto-refresh or real-time updates

#### Database
- `agent_conversations` table (create migration if missing)
  - Fields: id, agent_id, role, content, created_at
  - Index on agent_id for fast lookup

#### Backend
- `server/src/routes/agents.ts`
  - GET `/:agentId/chat` - Fetch conversation history
  - POST `/:agentId/chat` - Send message to agent
  - Triggers agent heartbeat/executor for response generation

## Implementation Tasks

### Task 1: Database Setup
- [ ] Create/verify `agent_conversations` table exists
- [ ] Create migration 0027 if needed
- [ ] Add indexes for performance

### Task 2: Backend - Chat Endpoints
- [ ] GET `/agents/:agentId/chat` - List messages
- [ ] POST `/agents/:agentId/chat` - Send message
- [ ] Implement message storage
- [ ] Trigger agent execution for response

### Task 3: Backend - AI Generation Endpoint
- [ ] POST `/agents/ai-generate` endpoint
- [ ] Load company's selected LLM provider/model from llm-settings
- [ ] Call LLM with agent creation prompt
- [ ] Return generated config (name, role, instructions)

### Task 4: Frontend - Chat UI
- [ ] Create `AgentChat.tsx` component
- [ ] Add "Chat" tab to `AgentDetail.tsx`
- [ ] Implement message list rendering
- [ ] Implement message input/send
- [ ] Add React Query hooks for data fetching
- [ ] Add auto-refresh/polling for new messages

### Task 5: Frontend - Quick Hire Wizard
- [ ] Create `QuickHireWizard.tsx` component
- [ ] Implement multi-step wizard UI
- [ ] Add step validation
- [ ] Call AI generation endpoint
- [ ] Implement agent creation with generated config
- [ ] Add loading states and error handling

### Task 6: Integration
- [ ] Add wizard trigger button in Agent creation UI
- [ ] Wire up API calls
- [ ] Add query keys to `queryKeys.ts`
- [ ] Add API methods to `agentsApi`
- [ ] Test end-to-end workflows

### Task 7: Testing & Polish
- [ ] Unit tests for components
- [ ] Test wizard with different LLM providers
- [ ] Test chat message persistence
- [ ] Error handling and edge cases
- [ ] UI/UX polish and styling

## Technical Details

### Chat Message Flow
1. User types message in chat input
2. Send button triggers mutation
3. Message POSTed to `/agents/:agentId/chat`
4. Server stores in `agent_conversations`
5. Server triggers agent executor (heartbeat)
6. Agent processes and generates response
7. Response stored in `agent_conversations`
8. Frontend polls/refreshes to fetch new messages
9. Messages displayed in chat

### AI Generation Flow
1. User clicks "Quick Hire" button
2. Opens wizard modal
3. User selects role (e.g., "Data Analyst")
4. User clicks "Generate with AI"
5. Frontend calls POST `/agents/ai-generate` with role
6. Backend loads company's LLM settings
7. Backend calls LLM: "Generate agent config for a Data Analyst..."
8. LLM returns: name, role description, instructions
9. Wizard populates fields with AI suggestions
10. User reviews and adjusts if needed
11. User clicks "Create Agent"
12. Final config POSTed to agent creation endpoint

## Database Migration (0027)

```sql
-- Create agent_conversations table
CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent_id
  ON agent_conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_created_at
  ON agent_conversations(created_at DESC);
```

## API Contracts

### GET /api/agents/:agentId/chat
```json
Response:
[
  {
    "id": "uuid",
    "agentId": "uuid",
    "role": "user|assistant",
    "content": "message text",
    "createdAt": "2026-03-16T..."
  }
]
```

### POST /api/agents/:agentId/chat
```json
Request:
{
  "message": "Hello agent"
}

Response:
{
  "id": "uuid",
  "agentId": "uuid",
  "role": "user",
  "content": "Hello agent",
  "createdAt": "2026-03-16T..."
}
```

### POST /api/agents/ai-generate
```json
Request:
{
  "role": "Data Analyst",
  "context": "optional context about company"
}

Response:
{
  "name": "DataBot v1",
  "role": "data_analyst",
  "instructions": "You are a data analysis expert...",
  "icon": "chart"
}
```

## Success Criteria

✅ **Phase 2 Complete When:**
1. Agent chat UI loads in Agent Detail page
2. Messages can be sent and appear in chat
3. Messages persist after refresh
4. Quick Hire Wizard generates agent configs with AI
5. Created agents are fully functional
6. No console errors
7. All styling matches Paperclip design system

## Estimated Effort
- Backend: 4-5 hours
- Frontend: 6-8 hours
- Testing/Polish: 2-3 hours
- **Total: ~12-16 hours**

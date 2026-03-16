# Phase 0 Task 4: Agent Chat Integration

Add chat functionality to the Agent Detail page.

## Summary

- **Location:** `ui/src/pages/AgentDetail.tsx`
- **Components:** Chat tab + AgentChat component
- **Time:** 1-2 hours

---

## Implementation Steps

### Step 1: Check AgentChat Component Exists

```bash
ls -la ui/src/components/AgentChat.tsx
```

Expected: File exists with `<AgentChat agentId={agentId} />` export

### Step 2: Add Navigation Tabs to AgentDetail

Edit `ui/src/pages/AgentDetail.tsx`:

```tsx
// Add state for active tab
const [activeTab, setActiveTab] = useState<"overview" | "chat">("overview");

// In JSX, add tab buttons:
<div className="flex gap-4 border-b">
  <button
    onClick={() => setActiveTab("overview")}
    className={activeTab === "overview" ? "font-bold border-b-2 border-blue-500" : ""}
  >
    Overview
  </button>
  <button
    onClick={() => setActiveTab("chat")}
    className={activeTab === "chat" ? "font-bold border-b-2 border-blue-500" : ""}
  >
    Chat
  </button>
</div>

// Render based on tab
{activeTab === "overview" && <AgentOverview agent={agent} />}
{activeTab === "chat" && <AgentChat agentId={agent.id} />}
```

### Step 3: Verify AgentChat Component

The `AgentChat` component should:
- Accept `agentId` prop
- Render message list
- Render message input field
- Call `agentsApi.sendChatMessage(agentId, message)` on send
- Listen for new messages (React Query auto-refresh or WebSocket)

If missing:

```tsx
// ui/src/components/AgentChat.tsx
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";

interface AgentChatProps {
  agentId: string;
}

export function AgentChat({ agentId }: AgentChatProps) {
  const [message, setMessage] = useState("");

  // Fetch chat messages
  const messagesQuery = useQuery({
    queryKey: queryKeys.agents.chat(agentId),
    queryFn: () => agentsApi.getChatMessages(agentId),
    refetchInterval: 2000, // Poll every 2 seconds
  });

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: (msg: string) => agentsApi.sendChatMessage(agentId, msg),
    onSuccess: () => {
      setMessage("");
      // Refetch messages
      messagesQuery.refetch();
    },
  });

  return (
    <div className="flex flex-col h-96 gap-4">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto border rounded p-4 bg-gray-50">
        {messagesQuery.data?.map((msg: any) => (
          <div
            key={msg.id}
            className={`mb-2 p-2 rounded ${
              msg.role === "user" ? "bg-blue-100 ml-8" : "bg-gray-200 mr-8"
            }`}
          >
            <strong>{msg.role}:</strong> {msg.content}
          </div>
        ))}
      </div>

      {/* Message input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              sendMutation.mutate(message);
            }
          }}
          placeholder="Type a message..."
          className="flex-1 border rounded px-3 py-2"
        />
        <button
          onClick={() => sendMutation.mutate(message)}
          disabled={!message.trim() || sendMutation.isPending}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

### Step 4: Verify Backend Chat API

Check `server/src/routes/agents.ts`:

```typescript
// Should have endpoint:
router.post("/:agentId/chat", async (req, res) => {
  const { agentId } = req.params;
  const { message } = req.body;

  // Save message to agentConversations table
  // Trigger heartbeat/executor for agent response
  // Return updated message list

  res.json({ messages: [...] });
});

router.get("/:agentId/chat", async (req, res) => {
  const { agentId } = req.params;

  // Fetch messages from agentConversations
  const messages = await db.select().from(agentConversations)
    .where(eq(agentConversations.agentId, agentId));

  res.json(messages);
});
```

### Step 5: Add Query Keys

Update `ui/src/lib/queryKeys.ts`:

```typescript
export const queryKeys = {
  agents: {
    all: () => ["agents"],
    list: () => [...queryKeys.agents.all(), "list"],
    detail: (id: string) => [...queryKeys.agents.all(), id],
    chat: (id: string) => [...queryKeys.agents.detail(id), "chat"],
  },
};
```

### Step 6: Add Agent API Methods

Update `ui/src/api/agents.ts`:

```typescript
export const agentsApi = {
  // ... existing methods ...

  getChatMessages: (agentId: string) =>
    client.get(`/agents/${agentId}/chat`),

  sendChatMessage: (agentId: string, message: string) =>
    client.post(`/agents/${agentId}/chat`, { message }),
};
```

---

## Testing Checklist

- [ ] Agent Detail page loads without errors
- [ ] "Overview" and "Chat" tabs appear
- [ ] Clicking tabs switches between them
- [ ] Chat tab shows message list (empty initially)
- [ ] Message input field renders
- [ ] Typing in input works
- [ ] Clicking send disables button during request
- [ ] Message appears in chat after send
- [ ] Refresh page → messages persist
- [ ] No console errors

---

## Database Check

Verify table exists:

```bash
docker exec paperclip-v2-db psql -U paperclip -d paperclip -c "SELECT * FROM agent_conversations LIMIT 1;"
```

If table missing, create migration:

```sql
CREATE TABLE agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_conversations_agent_id ON agent_conversations(agent_id);
```

---

## Success Criteria

✅ **Task 4 Complete When:**
1. Agent Detail page has Overview + Chat tabs
2. Chat tab shows message list
3. Messages can be sent and received
4. Messages persist after page refresh
5. No console/network errors
6. Styling matches Paperclip design system

---

## Notes

- Phase 0: Chat UI only, platform adapter response is stub
- Phase 1: Full LLM response + tool execution
- Websocket real-time messaging (Phase 2+)

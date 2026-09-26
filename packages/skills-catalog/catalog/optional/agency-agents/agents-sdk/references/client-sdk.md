# Client SDK

Choose `useAgent` for React state/RPC, `AgentClient` for other WebSocket clients, and `agentFetch` for one-off HTTP requests. Add `useAgentChat` when the UI needs chat messages and streaming. Check installed package versions before adapting current examples.

| Task | Documentation |
|------|---------------|
| Connect, sync state, call RPC, or send HTTP requests | [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) — hooks, vanilla JS, typed calls, streaming callbacks, and connection options |
| Build chat UI | [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) — `useAgentChat`, message rendering, status, and tool interactions |
| Authenticate across origins | [Cross-domain authentication](https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/) — token validation and WebSocket authentication |

Keep client instance selection consistent with server routing. For authentication, account for token refresh on reconnect and query caching. Close manually created `AgentClient` connections when finished; React hooks manage their own cleanup.
